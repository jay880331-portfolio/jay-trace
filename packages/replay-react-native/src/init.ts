import { createChildTraceparent, createSessionManager, createTraceparent, parseTraceparent, type Traceparent } from "@jaytrace/core";
import { initJayTraceReactNativeReplay } from "./client.js";
import { createJayTraceFetch, headersObject } from "./fetch.js";
import { installReactNativeReplayErrorHandlers, type ReactNativeErrorHandlerGlobals } from "./error-handlers.js";
import { ReactNativeWireframeCoordinator } from "./wireframe-coordinator.js";
import type { InitJayTraceReactNativeReplayOptions, ReactNativeCrashMetadata, ReactNativeReplayClient, ReactNativeReplayEngine, ReactNativeViewTreeNode } from "./types.js";
import type { ReplayMetadata, ReplayV2SegmentDocument } from "@jaytrace/replay-core";

const DEFAULT_SEGMENT_FLUSH_MS = 10_000;
const DEFAULT_MAX_SEGMENT_BYTES = 262_144;
const DEFAULT_MAX_SESSION_MS = 1_800_000;
const DEFAULT_WIREFRAME_INTERVAL_MS = 800;
const WIREFRAME_IDLE_LIMIT = 6;

export interface InitJayTraceReactNativeOptions
  extends Omit<InitJayTraceReactNativeReplayOptions, "traceId" | "traceparent" | "enabled" | "mode"> {
  traceId?: string;
  traceparent?: string;
  traceOrigins?: string[];
  release?: string;
  environment?: string;
  replay?: Pick<
    InitJayTraceReactNativeReplayOptions,
    | "enabled"
    | "mode"
    | "sampleRate"
    | "privacy"
    | "maskText"
    | "maskInputs"
    | "maxEvents"
    | "maxDurationMs"
    | "maxScreenshotBytes"
    | "engine"
    | "wireframeIntervalMs"
    | "segmentFlushMs"
    | "maxSegmentBytes"
    | "maxSessionMs"
  >;
  patchGlobalFetch?: boolean;
  /** Capture request/response bodies on the traced fetch (off by default). */
  captureBody?: boolean | { maxBytes?: number };
  globals?: ReactNativeErrorHandlerGlobals;
  appState?: ReactNativeAppStateLike;
  nativeCrash?: ReactNativeCrashBridgeLike;
  flushIntervalMs?: number;
  viewTreeThrottleMs?: number;
}

export interface ReactNativeAppStateLike {
  currentState?: string;
  addEventListener?: (
    type: "change",
    listener: (state: string) => void
  ) => { remove?: () => void } | (() => void) | void;
}

export interface ReactNativeCrashBridgeLike {
  install?: (options: { apiKey: string; endpoint: string; sessionId: string; traceId: string; traceparent: string }) => void;
  getLastCrash?: () => ReactNativeCrashMetadata | null | Promise<ReactNativeCrashMetadata | null>;
  clearLastCrash?: () => void | Promise<void>;
}

export interface JayTraceReactNativeClient {
  traceparent: string;
  traceId: string;
  sessionId: string;
  replay: ReactNativeReplayClient | null;
  fetch: typeof fetch;
  headers: (headers?: HeadersInit) => HeadersInit;
  traceNetwork: <T>(options: {
    method: string;
    url: string | URL;
    run: (headers: HeadersInit) => Promise<T>;
    status?: (result: T) => number | undefined;
    headers?: HeadersInit;
  }) => Promise<T>;
  setUser: (user: ReplayMetadata | null) => void;
  /** Records a custom log timeline event. Level "error" records error severity but does not trigger a flush. */
  log: (level: "debug" | "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => void;
  addAction: (name: string, detail?: string) => void;
  addInput: (target: string) => void;
  addScroll: (target: string, offset?: number) => void;
  addPerformance: (name: string, durationMs: number, detail?: string) => void;
  recordView: (name: string) => void;
  captureViewTree: (snapshot: ReactNativeViewTreeNode) => void;
  recordNativeCrash: (metadata: ReactNativeCrashMetadata) => Promise<void>;
  restore: () => void;
}

export function resolveReplayEngine(options: InitJayTraceReactNativeOptions): ReactNativeReplayEngine {
  return options.replay?.engine ?? "wireframe";
}

export function initJayTraceReactNative(options: InitJayTraceReactNativeOptions): JayTraceReactNativeClient {
  const traceparent = createRuntimeTraceparent(options.traceparent, options.traceId);
  // Active-session getter: buffers/instrumentation call it to stamp the current
  // session at document/request time; touch() rotates it (Datadog-style idle/max).
  const getSessionId = createSessionIdGetter(options);
  const sessionId = getSessionId();
  const engine = resolveReplayEngine(options);
  const replayEnabled = options.replay?.enabled ?? true;
  const privacy = options.replay?.privacy ?? options.privacy ?? "mask-all";
  const maskText = options.replay?.maskText ?? options.maskText ?? privacy === "mask-all";
  const replayMetadata: ReplayMetadata = {
    release: options.release,
    environment: options.environment,
    ...options.metadata
  };
  // Capture the un-patched fetch up front so wireframe-segment POSTs don't recurse
  // through the traced global fetch installed below.
  const originalFetch = options.fetch ?? globalThis.fetch;
  const replay = initJayTraceReactNativeReplay({
    ...options,
    // Privacy (Phase 2 parity): pixels upload only for engine "screenshot".
    screenshot: engine === "screenshot" ? options.screenshot : undefined,
    traceId: traceparent.traceId,
    sessionId,
    getSessionId,
    traceparent: traceparent.value,
    metadata: replayMetadata,
    enabled: replayEnabled,
    mode: options.replay?.mode ?? "on-error",
    sampleRate: options.replay?.sampleRate ?? options.sampleRate,
    privacy: options.replay?.privacy ?? options.privacy,
    maskText: options.replay?.maskText ?? options.maskText,
    maskInputs: options.replay?.maskInputs ?? options.maskInputs,
    maxEvents: options.replay?.maxEvents ?? options.maxEvents,
    maxDurationMs: options.replay?.maxDurationMs ?? options.maxDurationMs,
    maxScreenshotBytes: options.replay?.maxScreenshotBytes ?? options.maxScreenshotBytes,
    // Timeline event stream is on by default for the one-line client (web parity).
    service: options.service ?? "react-native",
    captureTimeline: options.captureTimeline ?? true,
    maxTimelineEvents: options.maxTimelineEvents
  });

  const coordinator =
    engine === "wireframe" && replayEnabled
      ? new ReactNativeWireframeCoordinator({
          sampleRate: options.replay?.sampleRate ?? options.sampleRate ?? 1,
          segmentFlushMs: options.replay?.segmentFlushMs ?? DEFAULT_SEGMENT_FLUSH_MS,
          maxSegmentBytes: options.replay?.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES,
          maxSessionMs: options.replay?.maxSessionMs ?? DEFAULT_MAX_SESSION_MS,
          wireframeIntervalMs: options.replay?.wireframeIntervalMs ?? DEFAULT_WIREFRAME_INTERVAL_MS,
          maskText,
          sessionId,
          traceId: traceparent.traceId,
          traceparent: traceparent.value,
          metadata: replayMetadata,
          sendSegment: doc => sendWireframeSegment(originalFetch, options, traceparent.value, doc),
          now: options.now
        })
      : null;

  const tracedFetch = createJayTraceFetch(replay, {
    traceparent: traceparent.value,
    traceOrigins: options.traceOrigins,
    fetch: options.fetch,
    captureBody: options.captureBody,
    redaction: options.redaction,
    getSessionId
  });
  // On error, promote the wireframe error-tail alongside the v1 replay flush.
  const errorClient = replay && coordinator ? wrapReplayForWireframe(replay, coordinator) : replay;
  const handlers = installReactNativeReplayErrorHandlers(errorClient, options.globals);
  const appStateSubscription = installAppStateFlush(replay, options.appState, coordinator);
  const flushTimer = installBatchFlush(replay, options.flushIntervalMs ?? 10_000);
  const viewTreeCapture = createThrottledViewTreeCapture(replay, options.viewTreeThrottleMs ?? 1_000);
  const wireframeCapture = coordinator
    ? installWireframeCapture(coordinator, {
        appState: options.appState,
        intervalMs: options.replay?.wireframeIntervalMs ?? DEFAULT_WIREFRAME_INTERVAL_MS
      })
    : null;
  installNativeCrashBridge(replay, options.nativeCrash, {
    apiKey: options.apiKey,
    endpoint: options.endpoint,
    sessionId,
    traceId: traceparent.traceId,
    traceparent: traceparent.value
  });
  const globals = globalThis as { fetch?: typeof fetch };
  const previousFetch = globals.fetch;

  if (options.patchGlobalFetch !== false) {
    globals.fetch = tracedFetch;
  }

  return {
    traceparent: traceparent.value,
    traceId: traceparent.traceId,
    sessionId,
    replay,
    fetch: tracedFetch,
    headers(headers) {
      return mergeHeaders(headers, traceparent.value);
    },
    async traceNetwork({ method, url, run, status, headers }) {
      const startedAt = Date.now();
      // Header merge is SDK bookkeeping: if it throws, still run the caller's
      // request with its own headers rather than failing the whole call.
      let shouldTrace = false;
      let nextHeaders: HeadersInit = headers ?? {};
      try {
        shouldTrace = shouldTraceUrl(url, options.traceOrigins);
        nextHeaders = shouldTrace ? mergeHeaders(headers, traceparent.value) : headers ?? {};
      } catch {
        shouldTrace = false;
        nextHeaders = headers ?? {};
      }
      try {
        const result = await run(nextHeaders);
        // Recording (incl. the user status() extractor) is isolated so a throw
        // here can't turn a successful result into a rejection.
        try {
          if (shouldTrace) {
            void replay?.recordNetwork({
              method,
              url: String(url),
              status: status?.(result),
              durationMs: Date.now() - startedAt
            }).catch(() => undefined);
          }
        } catch {
        }
        return result;
      } catch (error) {
        try {
          if (shouldTrace) {
            void replay?.recordNetwork({
              method,
              url: String(url),
              durationMs: Date.now() - startedAt,
              error: error instanceof Error ? error.message : String(error)
            }).catch(() => undefined);
          }
        } catch {
        }
        throw error; // pass the caller's run() rejection through untouched
      }
    },
    setUser(user) {
      replay?.setUser(user);
    },
    log(level, message, context) {
      replay?.log(level, message, context);
    },
    addAction(name, detail) {
      replay?.recordAction(name, detail);
    },
    addInput(target) {
      replay?.recordInput(target);
    },
    addScroll(target, offset) {
      replay?.recordScroll(target, offset);
    },
    addPerformance(name, durationMs, detail) {
      replay?.recordPerformance(name, durationMs, detail);
    },
    recordView(name) {
      replay?.recordView(name);
    },
    captureViewTree(snapshot) {
      // A hostile/oversized view tree must never throw into the host's render.
      try {
        viewTreeCapture.capture(snapshot);
        wireframeCapture?.capture(snapshot);
      } catch {
      }
    },
    async recordNativeCrash(metadata) {
      coordinator?.promoteErrorTail();
      await replay?.recordNativeCrash(metadata);
    },
    restore() {
      replay?.restore();
      handlers.uninstall();
      uninstallAppStateFlush(appStateSubscription);
      if (flushTimer) {
        clearInterval(flushTimer);
      }
      viewTreeCapture.cancel();
      wireframeCapture?.stop();
      coordinator?.dispose();
      if (options.patchGlobalFetch !== false) {
        globals.fetch = previousFetch;
      }
    }
  };
}

function createThrottledViewTreeCapture(
  replay: ReactNativeReplayClient | null,
  throttleMs: number
): { capture: (snapshot: ReactNativeViewTreeNode) => void; cancel: () => void } {
  let pending: ReactNativeViewTreeNode | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    capture(snapshot) {
      if (!replay) {
        return;
      }
      pending = snapshot;
      if (timer) {
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        if (pending) {
          // Runs on the event loop: a throw while serializing a hostile tree
          // would be an uncaught exception, so isolate it.
          try {
            replay.recordViewTreeSnapshot(pending);
          } catch {
          }
          pending = undefined;
        }
      }, Math.max(0, throttleMs));
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
      }
      timer = undefined;
      pending = undefined;
    }
  };
}

function installBatchFlush(replay: ReactNativeReplayClient | null, flushIntervalMs: number): ReturnType<typeof setInterval> | undefined {
  if (!replay || flushIntervalMs <= 0) {
    return undefined;
  }
  return setInterval(() => {
    void replay.flush("manual").catch(() => undefined);
  }, flushIntervalMs);
}

function installNativeCrashBridge(
  replay: ReactNativeReplayClient | null,
  bridge: ReactNativeCrashBridgeLike | undefined,
  options: { apiKey: string; endpoint: string; sessionId: string; traceId: string; traceparent: string }
): void {
  if (!replay || !bridge) {
    return;
  }

  bridge.install?.(options);
  void Promise.resolve(bridge.getLastCrash?.()).then(async crash => {
    if (!crash) {
      return;
    }
    await replay.recordNativeCrash(crash);
    await bridge.clearLastCrash?.();
  }).catch(() => undefined);
}

function installAppStateFlush(
  replay: ReactNativeReplayClient | null,
  appState: ReactNativeAppStateLike | undefined,
  coordinator?: ReactNativeWireframeCoordinator | null
): { remove?: () => void } | (() => void) | void {
  if (!appState?.addEventListener || (!replay && !coordinator)) {
    return undefined;
  }
  return appState.addEventListener("change", state => {
    if (state === "background" || state === "inactive") {
      void replay?.flush("manual").catch(() => undefined);
      coordinator?.flushPending();
    }
  });
}

/** Derives viewport from the root snapshot's measured bounds; runs the foreground-gated re-capture timer with Phase-2 idle-pause. */
function installWireframeCapture(
  coordinator: ReactNativeWireframeCoordinator,
  opts: { appState: ReactNativeAppStateLike | undefined; intervalMs: number }
): { capture: (snapshot: ReactNativeViewTreeNode) => void; stop: () => void } {
  let lastSnapshot: ReactNativeViewTreeNode | undefined;
  let idleHash: string | null = null;
  let idleCount = 0;

  const captureNow = (snapshot: ReactNativeViewTreeNode): void => {
    const bounds = snapshot.bounds;
    if (!bounds) {
      return; // no measured geometry -> nothing meaningful to draw
    }
    coordinator.capture(snapshot, { width: bounds.width, height: bounds.height });
  };

  const timer =
    opts.intervalMs > 0
      ? setInterval(() => {
          // Runs on the event loop: serializing/capturing a hostile tree must
          // never surface as an uncaught exception.
          try {
            if (!lastSnapshot || !isForeground(opts.appState)) {
              return;
            }
            const hash = JSON.stringify(lastSnapshot);
            if (hash === idleHash) {
              idleCount += 1;
              if (idleCount >= WIREFRAME_IDLE_LIMIT) {
                return; // static screen: pause until a new tree arrives
              }
            } else {
              idleHash = hash;
              idleCount = 0;
            }
            captureNow(lastSnapshot);
          } catch {
          }
        }, opts.intervalMs)
      : undefined;

  return {
    capture(snapshot) {
      lastSnapshot = snapshot;
      idleHash = JSON.stringify(snapshot);
      idleCount = 0;
      captureNow(snapshot);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
      }
    }
  };
}

function isForeground(appState: ReactNativeAppStateLike | undefined): boolean {
  return !appState?.currentState || appState.currentState === "active";
}

/** Overlays error-tail promotion onto a v1 replay client without touching its other methods. */
function wrapReplayForWireframe(
  replay: ReactNativeReplayClient,
  coordinator: ReactNativeWireframeCoordinator
): ReactNativeReplayClient {
  return {
    ...replay,
    async recordError(error, errorOptions) {
      coordinator.promoteErrorTail();
      await replay.recordError(error, errorOptions);
    },
    async recordNativeCrash(metadata) {
      coordinator.promoteErrorTail();
      await replay.recordNativeCrash(metadata);
    }
  };
}

function sendWireframeSegment(
  fetchImpl: typeof fetch | undefined,
  options: InitJayTraceReactNativeOptions,
  traceparent: string,
  document: ReplayV2SegmentDocument
): void {
  if (!fetchImpl) {
    return;
  }
  // Isolate the sender: a synchronous throw here would otherwise escape every
  // coordinator send path (capture flush, promoteErrorTail, dispose, appState).
  try {
    void fetchImpl(options.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(traceparent ? { traceparent } : {})
      },
      body: JSON.stringify({ apiKey: options.apiKey, reason: "segment", document })
    }).catch(() => undefined);
  } catch {
  }
}

function uninstallAppStateFlush(subscription: { remove?: () => void } | (() => void) | void): void {
  if (typeof subscription === "function") {
    subscription();
    return;
  }
  subscription?.remove?.();
}

function createRuntimeTraceparent(traceparent: string | undefined, traceId: string | undefined): Traceparent {
  const parsed = parseTraceparent(traceparent);
  if (parsed) {
    return createChildTraceparent(parsed);
  }

  const normalizedTraceId = traceId?.trim().toLowerCase();
  if (normalizedTraceId && /^[0-9a-f]{32}$/.test(normalizedTraceId) && !/^0+$/.test(normalizedTraceId)) {
    const parent: Traceparent = {
      version: "00",
      traceId: normalizedTraceId,
      spanId: "1111111111111111",
      flags: "01",
      value: `00-${normalizedTraceId}-1111111111111111-01`
    };
    return createChildTraceparent(parent);
  }

  return createTraceparent();
}

// ponytail: in-memory only — sessions reset on app restart; add AsyncStorage adapter if that matters
function createSessionIdGetter(options: InitJayTraceReactNativeOptions): () => string {
  // An explicit sessionId pins a fixed session (no rotation) — preserves prior behavior.
  if (options.sessionId) {
    const fixed = options.sessionId;
    return () => fixed;
  }
  const manager = createSessionManager(options.now ? { now: () => options.now!().getTime() } : {});
  return () => manager.touch();
}

function mergeHeaders(headers: HeadersInit | undefined, traceparent: string): HeadersInit {
  return {
    ...headersObject(headers),
    traceparent
  };
}

function shouldTraceUrl(url: string | URL, traceOrigins: string[] | undefined): boolean {
  if (!traceOrigins?.length) {
    return true;
  }
  try {
    return traceOrigins.map(origin => origin.replace(/\/$/, "")).includes(new URL(String(url)).origin);
  } catch {
    return false;
  }
}
