import { redact, type JayTraceError } from "@jaytrace/core";
import { ReplayBuffer, maskReplayText, type ReplayDocument, type ReplayEvent } from "@jaytrace/replay-core";
import { TimelineBuffer } from "./timeline.js";
import type {
  InitJayTraceReactNativeReplayOptions,
  ReactNativeCrashMetadata,
  ReactNativeNetworkEvent,
  ReactNativeReplayClient,
  ReactNativeViewTreeNode
} from "./types.js";

const MAX_TIMELINE_VIEWS = 100;

const DEFAULT_MAX_SCREENSHOT_BYTES = 320_000;

export function initJayTraceReactNativeReplay(options: InitJayTraceReactNativeReplayOptions): ReactNativeReplayClient | null {
  if (options.enabled !== true || options.mode === "off" || !sampleRate(options.sampleRate ?? 100)) {
    return null;
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("JayTrace React Native replay requires fetch");
  }

  const mode = options.mode === "always" ? "always" : "on-error";
  const privacy = options.privacy ?? "mask-all";
  const maskText = options.maskText ?? privacy === "mask-all";
  const buffer = new ReplayBuffer({
    platform: "react-native",
    traceId: options.traceId,
    sessionId: options.sessionId ?? options.traceId,
    traceparent: options.traceparent,
    metadata: {
      ...options.metadata,
      "replay.screenshot": options.screenshot ? "enabled" : "missing"
    },
    mode,
    maxEvents: options.maxEvents ?? 200,
    maxDurationMs: options.maxDurationMs ?? 30_000,
    now: options.now
  });
  const pendingFrames = new Set<Promise<void>>();

  // Event-stream (timeline.v1) mirror of the replay document. The console renders
  // click/view/fetch/error events from here; without it RN sessions show no stream.
  const timeline =
    options.captureTimeline === true
      ? new TimelineBuffer({
          apiKey: options.apiKey,
          endpoint: options.endpoint,
          service: options.service ?? "react-native",
          traceId: options.traceId,
          sessionId: options.sessionId ?? options.traceId,
          getSessionId: options.getSessionId,
          traceparent: options.traceparent ?? "",
          maxEvents: options.maxTimelineEvents,
          fetchImpl,
          now: options.now,
          redaction: options.redaction
        })
      : null;
  // View dedupe/cap (web observeViews parity): one event per name, 100 per session.
  const seenViewNames = new Set<string>();
  let recordedViews = 0;
  // Global console patch (web captureConsole parity). Off unless captureConsole is
  // set; records `console.<method> ...` timeline `log` events and restores on restore().
  const restoreConsole = timeline && options.captureConsole ? patchConsole(timeline, options.captureConsole) : () => {};

  function flushTimeline(reason: "error" | "manual"): void {
    if (!timeline?.hasEvents()) {
      return;
    }
    void timeline.flush(reason).catch(() => undefined);
  }

  async function send(reason: "error" | "manual"): Promise<void> {
    if (!buffer.hasEvents()) {
      return;
    }
    await waitForFrames();

    try {
      await fetchImpl(options.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.traceparent ? { traceparent: options.traceparent } : {})
        },
        body: JSON.stringify({
          apiKey: options.apiKey,
          reason,
          document: redact(buffer.document(), options.redaction)
        })
      });
      buffer.clear();
    } catch {
    }
  }

  function queueFrame(event: ReplayEvent, point?: { x: number; y: number }): void {
    const pending = captureFrame(event, point).finally(() => pendingFrames.delete(pending));
    pendingFrames.add(pending);
  }

  async function captureFrame(event: ReplayEvent, point?: { x: number; y: number }): Promise<void> {
    const screenshot = await screenshotFrame();
    if (!screenshot) {
      return;
    }
    buffer.addFrameForEvent(event, {
      type: "image",
      image: screenshot.image,
      mediaType: screenshot.mediaType,
      width: screenshot.width,
      height: screenshot.height,
      ...point
    });
  }

  async function waitForFrames(): Promise<void> {
    await Promise.allSettled(Array.from(pendingFrames));
  }

  async function screenshotFrame() {
    try {
      const screenshot = await options.screenshot?.();
      return screenshot && validScreenshot(screenshot.image, options.maxScreenshotBytes ?? DEFAULT_MAX_SCREENSHOT_BYTES)
        ? screenshot
        : null;
    } catch {
      return null;
    }
  }

  return {
    setUser(user) {
      buffer.deleteMetadataPrefix("user.");
      buffer.setMetadata(user ? userMetadata(user) : undefined);
      timeline?.setUser(user ? (user as unknown as NonNullable<Parameters<TimelineBuffer["setUser"]>[0]>) : null);
    },
    recordScreen(name: string) {
      buffer.setMetadata({ "view.name": maskReplayText(name, maskText) });
      queueFrame(buffer.add("route", `screen ${maskReplayText(name, maskText)}`));
      timeline?.addText("navigation", `route ${name}`, "info");
    },
    recordScreenEnd(name: string, durationMs: number) {
      buffer.add("route", `screen_end ${maskReplayText(name, maskText)} durationMs=${Math.max(0, Math.round(durationMs))}`);
    },
    recordComponentMount(name: string) {
      buffer.add("gesture", `component_mount ${maskReplayText(name, maskText)}`);
    },
    recordComponentUnmount(name: string, durationMs: number) {
      buffer.add("gesture", `component_unmount ${maskReplayText(name, maskText)} durationMs=${Math.max(0, Math.round(durationMs))}`);
    },
    recordViewTreeSnapshot(snapshot: ReactNativeViewTreeNode) {
      buffer.add("mutation", `view_tree ${compactSnapshot(snapshot, maskText)}`);
    },
    recordAction(name: string, detail?: string) {
      const suffix = detail ? ` ${maskReplayText(detail, true)}` : "";
      queueFrame(buffer.add("gesture", `action ${maskReplayText(name, maskText)}${suffix}`));
    },
    recordTap(target: string, x?: number, y?: number) {
      const roundedPoint = typeof x === "number" && typeof y === "number" ? { x: Math.round(x), y: Math.round(y) } : undefined;
      const pointText = roundedPoint ? ` x=${roundedPoint.x} y=${roundedPoint.y}` : "";
      queueFrame(buffer.add("gesture", `tap ${maskReplayText(target, maskText)}${pointText}`), roundedPoint);
      timeline?.addText("click", `click ${target}${pointText}`, "info");
    },
    recordView(name: string) {
      if (seenViewNames.has(name) || recordedViews >= MAX_TIMELINE_VIEWS) {
        return;
      }
      seenViewNames.add(name);
      recordedViews += 1;
      buffer.add("mutation", `view ${maskReplayText(name, maskText)}`);
      timeline?.addText("view", name, "info");
    },
    log(level, message, context) {
      try {
        const text = `log ${message}`;
        const data = context ? redact(context, options.redaction) : undefined;
        // level "error" records with error severity but is NOT a flush trigger —
        // only thrown exceptions / failing fetches drive the error flush, so this
        // just records to the timeline and the replay event line.
        timeline?.addText("log", text, level, data);
        buffer.add("gesture", text);
      } catch {
        // isolation: host logging must never throw back into the caller
      }
    },
    recordInput(target: string) {
      queueFrame(buffer.add("input", `input ${maskReplayText(target, maskText)} value=redacted`));
    },
    recordScroll(target: string, offset?: number) {
      const suffix = typeof offset === "number" ? ` offset=${Math.round(offset)}` : "";
      queueFrame(buffer.add("scroll", `scroll ${maskReplayText(target, maskText)}${suffix}`));
    },
    recordPerformance(name: string, durationMs: number, detail?: string) {
      const suffix = detail ? ` ${maskReplayText(detail, true)}` : "";
      queueFrame(buffer.add("gesture", `performance ${maskReplayText(name, maskText)} durationMs=${Math.round(durationMs)}${suffix}`));
      timeline?.addText("performance", `performance ${name} durationMs=${Math.round(durationMs)}`, "info");
    },
    recordGesture(name: string, detail?: string) {
      const suffix = detail ? ` ${maskReplayText(detail, true)}` : "";
      queueFrame(buffer.add("gesture", `${maskReplayText(name, maskText)}${suffix}`));
    },
    async recordNetwork(event: ReactNativeNetworkEvent) {
      const replayEvent = buffer.add("network", networkLine(event, maskText));
      queueFrame(replayEvent);
      // Replay events are string lines with no data slot (frames only carry
      // image/html), so captured bodies ride on a companion `network-body` line
      // rather than as structured event data. Each field is capped at 1KB; the
      // bodies were already redacted upstream in the fetch wrapper.
      if (event.requestBody !== undefined || event.responseBody !== undefined) {
        buffer.add("network", networkBodyLine(event, maskText));
      }
      const failed = isNetworkFailure(event);
      // Timeline `fetch` event: same masked line as the replay, plus the already
      // redacted request/response bodies as structured `data` (console body view).
      timeline?.addText("fetch", networkLine(event, maskText), failed ? "error" : "info", timelineNetworkData(event));
      if (failed && (mode === "on-error" || mode === "always")) {
        await send("error");
        flushTimeline("error");
      }
    },
    async recordError(error: unknown, options?: { fatal?: boolean }) {
      const text = `error ${errorText(error)}${options?.fatal ? " fatal=true" : ""}`;
      const screenshot = await screenshotFrame();
      if (screenshot) {
        buffer.addFrame("error", text, {
          type: "image",
          image: screenshot.image,
          mediaType: screenshot.mediaType,
          width: screenshot.width,
          height: screenshot.height
        });
      } else {
        buffer.add("error", text);
      }
      timeline?.addError(errorText(error), toJayTraceError(error));
      flushTimeline("error");
      if (mode === "on-error" || mode === "always") {
        await send("error");
      }
    },
    async recordNativeCrash(metadata: ReactNativeCrashMetadata) {
      buffer.setMetadata(crashMetadata(metadata, maskText));
      const text = `error ${metadata.message ?? "native crash"} fatal=true`;
      buffer.add("error", text);
      timeline?.addError(metadata.message ?? "native crash", {
        name: "NativeCrash",
        message: metadata.message ?? "native crash",
        stack: metadata.stack,
        code: metadata.nativeCrashId
      });
      flushTimeline("error");
      if (mode === "on-error" || mode === "always") {
        await send("error");
      }
    },
    async flush(reason: "error" | "manual") {
      await send(reason);
      flushTimeline(reason);
    },
    snapshot(): ReplayDocument {
      return buffer.document();
    },
    restore() {
      restoreConsole();
    }
  };
}

const CONSOLE_UNIQUE_CAP = 30;

/**
 * Patches the global `console` methods so host output is mirrored into the
 * timeline as `log` events (web captureConsole parity). The host's original
 * console call always runs first, untouched. Repeat suppression records the
 * first occurrence of each unique line only, capped at 30 distinct lines per
 * session so a hot log loop can't flood the timeline. Returns a restore fn.
 */
function patchConsole(
  timeline: TimelineBuffer,
  config: boolean | Array<"error" | "warn" | "log" | "info">
): () => void {
  const consoleRef = (globalThis as unknown as { console?: Record<string, unknown> }).console;
  if (!consoleRef) {
    return () => {};
  }

  // `true` is shorthand for ["error"]; an array selects the methods to patch.
  const requested = config === true ? (["error"] as const) : Array.isArray(config) ? config : [];
  const methods = [...new Set(requested)].filter(
    (method): method is "error" | "warn" | "log" | "info" =>
      method === "error" || method === "warn" || method === "log" || method === "info"
  );

  const originals = new Map<string, (...args: unknown[]) => unknown>();
  // Re-entrancy guard: SDK bookkeeping (or a patched console called from inside
  // a handler) must never recurse into a second timeline record.
  let inHandler = false;
  const seenTexts = new Set<string>();

  for (const method of methods) {
    const original = (consoleRef as Record<string, unknown>)[method];
    if (typeof original !== "function") {
      continue;
    }
    const originalFn = original as (...args: unknown[]) => unknown;
    originals.set(method, originalFn);

    const severity: "error" | "warn" | "info" = method === "error" ? "error" : method === "warn" ? "warn" : "info";
    const patched = (...args: unknown[]): unknown => {
      // The host's original console call always runs first, untouched.
      const result = originalFn.apply(consoleRef, args);
      if (!inHandler) {
        inHandler = true;
        try {
          const text = `console.${method} ${serializeConsoleArgs(args)}`;
          // First occurrence of each unique line only, capped at 30 per session.
          if (!seenTexts.has(text) && seenTexts.size < CONSOLE_UNIQUE_CAP) {
            seenTexts.add(text);
            timeline.addText("log", text, severity);
          }
        } catch {
          // isolation: capture failures must not affect the host console call
        } finally {
          inHandler = false;
        }
      }
      return result;
    };

    try {
      (consoleRef as Record<string, unknown>)[method] = patched;
    } catch {
      // isolation: a non-writable console method is silently skipped
      originals.delete(method);
    }
  }

  return () => {
    for (const [method, originalFn] of originals) {
      try {
        (consoleRef as Record<string, unknown>)[method] = originalFn;
      } catch {
        // isolation: restore is best-effort
      }
    }
  };
}

const CONSOLE_ARG_CAP = 500;
const CONSOLE_LINE_CAP = 2_000;

/**
 * Safe serialization of console arguments: primitives stringify directly,
 * objects are JSON-encoded and capped at 500 chars each, and the joined line
 * is capped at 2,000 chars so a single log entry can't bloat the payload.
 */
function serializeConsoleArgs(args: unknown[]): string {
  const parts = args.map(arg => {
    if (typeof arg === "string") {
      return arg;
    }
    if (arg === null || arg === undefined || typeof arg !== "object") {
      return String(arg);
    }
    const json = safeJson(arg);
    return json.length > CONSOLE_ARG_CAP ? json.slice(0, CONSOLE_ARG_CAP) : json;
  });
  const joined = parts.join(" ");
  return joined.length > CONSOLE_LINE_CAP ? joined.slice(0, CONSOLE_LINE_CAP) : joined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function crashMetadata(metadata: ReactNativeCrashMetadata, maskText: boolean): Record<string, string | undefined> {
  return {
    "crash.device_model": metadata.deviceModel ? maskReplayText(metadata.deviceModel, maskText) : undefined,
    "crash.os_name": metadata.osName,
    "crash.os_version": metadata.osVersion,
    "crash.app_version": metadata.appVersion,
    "crash.build_number": metadata.buildNumber,
    "crash.native_id": metadata.nativeCrashId
  };
}

function compactSnapshot(snapshot: ReactNativeViewTreeNode, maskText: boolean): string {
  return truncate(JSON.stringify(redactViewTree(snapshot, maskText)), 2_000);
}

function redactViewTree(node: ReactNativeViewTreeNode, maskText: boolean): ReactNativeViewTreeNode {
  return {
    type: truncate(node.type, 80),
    key: node.key ? truncate(node.key, 80) : undefined,
    props: node.props ? Object.fromEntries(Object.entries(node.props).map(([key, value]) => [key, typeof value === "string" ? maskReplayText(value, maskText) : value])) : undefined,
    children: node.children?.slice(0, 50).map(child => redactViewTree(child, maskText))
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function userMetadata(user: Record<string, unknown>): Record<string, string | number | boolean | null | undefined> {
  return Object.fromEntries(Object.entries(user).map(([key, value]) => [`user.${key}`, primitive(value)]));
}

function primitive(value: unknown): string | number | boolean | null | undefined {
  return value === null || ["string", "number", "boolean", "undefined"].includes(typeof value) ? value as string | number | boolean | null | undefined : String(value);
}

function sampleRate(rate: number): boolean {
  const clamped = Math.max(0, Math.min(rate, 100));
  return clamped >= 100 || Math.random() * 100 < clamped;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const stack = error.stack && error.stack !== `${error.name}: ${error.message}` ? ` stack=${error.stack}` : "";
    return `${error.name}: ${error.message}${stack}`;
  }

  return String(error);
}

function timelineNetworkData(event: ReactNativeNetworkEvent): Record<string, unknown> | undefined {
  // Reuse the values already redacted by the fetch wrapper — do not re-mask here.
  if (event.requestBody === undefined && event.responseBody === undefined) {
    return undefined;
  }
  const data: Record<string, unknown> = {};
  if (event.requestBody !== undefined) {
    data.requestBody = event.requestBody;
  }
  if (event.responseBody !== undefined) {
    data.responseBody = event.responseBody;
  }
  return data;
}

function toJayTraceError(error: unknown): JayTraceError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "Error", message: String(error) };
}

function networkLine(event: ReactNativeNetworkEvent, maskText: boolean): string {
  const status = typeof event.status === "number" ? ` status=${event.status}` : "";
  const duration = typeof event.durationMs === "number" ? ` durationMs=${Math.round(event.durationMs)}` : "";
  const error = event.error ? ` error=${maskReplayText(event.error, maskText)}` : "";
  return `${event.method.toUpperCase()} ${maskReplayText(event.url, maskText)}${status}${duration}${error}`;
}

const NETWORK_BODY_CAP = 1_024;

function networkBodyLine(event: ReactNativeNetworkEvent, maskText: boolean): string {
  const req = renderBody(event.requestBody);
  const res = renderBody(event.responseBody);
  return `network-body ${event.method.toUpperCase()} ${maskReplayText(event.url, maskText)} req=${req} res=${res}`;
}

function renderBody(body: unknown): string {
  if (body === undefined) {
    return "-";
  }
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return truncate(text ?? "", NETWORK_BODY_CAP);
}

function isNetworkFailure(event: ReactNativeNetworkEvent): boolean {
  return Boolean(event.error) || (typeof event.status === "number" && event.status >= 500);
}

function validScreenshot(image: string, maxBytes: number): boolean {
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(image)) {
    return false;
  }
  return base64ByteLength(image.slice(image.indexOf(",") + 1)) <= maxBytes;
}

function base64ByteLength(value: string): number {
  const normalized = value.replace(/\s/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}
