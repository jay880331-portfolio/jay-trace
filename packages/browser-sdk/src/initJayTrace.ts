import {
  createChildTraceparent,
  createSessionManager,
  createTraceparent,
  parseTraceparent,
  redact,
  type SessionState,
  type SessionStorage,
  type Traceparent
} from "@jaytrace/core";
import { startReplayWeb, type ReplayWebController } from "@jaytrace/replay-web";
import type { ReplayDocument, ReplayV2SegmentDocument } from "@jaytrace/replay-core";

import { describeTarget, type PointerSample } from "./dom.js";
import { installErrorHandlers, type ErrorHandlers } from "./errorHandlers.js";
import { instrumentFetch, markInternalRequest, type FetchInstrumentation } from "./instrumentFetch.js";
import { instrumentXhr, type XhrInstrumentation } from "./instrumentXhr.js";
import { RageClickDetector } from "./rageClick.js";
import { normalizeOptions, RumBuffer } from "./rumBuffer.js";
import type { BrowserRuntime, FlushReason, InitJayTraceOptions, JayTraceClient, JayTraceNetworkOptions } from "./types.js";

// window.__jayTraceClient 전역 타입 선언은 types.ts에 있다 (모든 서브패스에서 보이도록).

// Default selectors observed when captureViews is enabled without an explicit
// selectors list: common semantic/landmark elements plus the two data hooks.
// data-jaytrace-view is always observed on top of whatever list is used.
const DEFAULT_VIEW_SELECTORS = ["main", "section", "article", "h1", "h2", "h3", "[data-jaytrace-view]", "[data-testid]"];

class NoopJayTraceClient implements JayTraceClient {
  readonly traceparent = "";
  addAction(): void {}
  log(): void {}
  addEvent(): void {}
  headers(headers?: HeadersInit): HeadersInit {
    return headers ?? {};
  }
  async traceNetwork<T>({ run, headers }: JayTraceNetworkOptions<T>): Promise<T> {
    return run(headers ?? {});
  }
  setUser(): void {}
  async flush(): Promise<void> {}
  restore(): void {}
}

class InternalJayTraceClient implements JayTraceClient {
  readonly traceparent: string;
  private readonly rootTraceparent: Traceparent;
  private readonly buffer: RumBuffer;
  private readonly fetchInstrumentation: FetchInstrumentation;
  private readonly xhrInstrumentation: XhrInstrumentation;
  private readonly errorHandlers: ErrorHandlers;
  private readonly replay: ReplayWebController | null;
  private readonly rageClickDetector: RageClickDetector;
  private readonly onClick: (event: MouseEvent) => void;
  private readonly onScroll: () => void;
  private readonly onPopState: () => void;
  private readonly onPageHide: () => void;
  private readonly onLoad: () => void;
  private readonly onVisibilityChange: () => void;
  private readonly restoreHistory: () => void;
  private readonly restorePerformanceObserver: () => void;
  private readonly restoreViewObserver: () => void;
  private readonly restoreConsole: () => void;
  private readonly traceOrigins: string[];
  private readonly replayNetworkOrigins: string[];
  private restored = false;
  private navigationTimingRecorded = false;
  private lastScrollAt = 0;
  private lastPath = "";

  constructor(
    private readonly runtime: BrowserRuntime,
    private readonly options: InitJayTraceOptions
  ) {
    const normalized = normalizeOptions(options);
    // Adopt a caller-supplied W3C traceparent (e.g. the SSR root injected via a
    // meta tag) so the first client load joins the server's trace; fall back to
    // a freshly generated root when absent or malformed.
    this.rootTraceparent = parseTraceparent(options.traceparent) ?? createTraceparent();
    this.traceparent = this.rootTraceparent.value;
    // A caller-supplied sessionId pins a fixed session (no rotation); otherwise a
    // session manager rotates on 15min idle / 4h max duration. Resolving it (touch)
    // is the record of activity, so wire the getter — not a frozen value — downstream.
    const getSessionId = createSessionIdGetter(normalized.sessionId, this.runtime.window, () => normalized.now().getTime());
    this.traceOrigins = normalized.traceOrigins?.map(origin => origin.replace(/\/$/, "")) ?? [];
    this.replayNetworkOrigins = normalized.replay?.networkOrigins?.map(origin => origin.replace(/\/$/, "")) ?? [];

    const fetchImpl = normalized.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error("JayTrace requires fetch to send RUM payloads");
    }

    this.buffer = new RumBuffer({
      apiKey: normalized.apiKey,
      endpoint: normalized.endpoint,
      service: normalized.service,
      traceId: this.rootTraceparent.traceId,
      getSessionId,
      spanId: this.rootTraceparent.spanId,
      traceparent: this.rootTraceparent.value,
      release: normalized.release,
      environment: normalized.environment,
      maxEvents: normalized.maxEvents,
      flushTimeoutMs: normalized.flushTimeoutMs,
      fetchImpl: (input, init) => fetchImpl(input, markInternalRequest(init)),
      now: normalized.now,
      getLocation: () => this.runtime.window.location,
      getUserAgent: () => this.runtime.window.navigator.userAgent,
      redaction: normalized.redaction
    });

    this.rageClickDetector = new RageClickDetector({
      threshold: normalized.rageClickThreshold,
      windowMs: normalized.rageClickWindowMs,
      radiusPx: normalized.rageClickRadiusPx
    });

    this.fetchInstrumentation = instrumentFetch({
      rootTraceparent: this.rootTraceparent,
      traceOrigins: normalized.traceOrigins,
      addTimeline: (text, severity, data) => {
        this.recordNetwork(text, severity, false, data);
      },
      getSessionId,
      captureBody: normalized.captureBody,
      redaction: normalized.redaction
    });
    this.xhrInstrumentation = instrumentXhr({
      rootTraceparent: this.rootTraceparent,
      traceOrigins: normalized.traceOrigins,
      addTimeline: (text, severity, data) => {
        this.recordNetwork(text, severity, false, data);
      },
      getSessionId,
      now: () => normalized.now().getTime(),
      captureBody: normalized.captureBody,
      redaction: normalized.redaction
    });

    this.errorHandlers = installErrorHandlers(this.runtime.window, {
      addError: (text, error) => {
        this.buffer.addError(text, error);
        this.replay?.markError(text);
      },
      flush: () => void this.flush("error")
    });

    this.replay = startReplayWeb({
      ...normalized.replay,
      traceId: this.rootTraceparent.traceId,
      sessionId: getSessionId(),
      traceparent: this.rootTraceparent.value,
      metadata: {
        release: normalized.release,
        environment: normalized.environment,
        userAgent: this.runtime.window.navigator.userAgent,
        url: this.runtime.window.location.href
      },
      now: normalized.now,
      flush: async (document: ReplayDocument, reason: "error" | "manual") => {
        await this.flushReplay(document, reason);
      },
      sendSegment: (segment: ReplayV2SegmentDocument) => this.sendReplaySegment(segment)
    });

    this.onClick = (event) => this.handleClick(event, normalized.now, normalized.rageClickWindowMs);
    this.onScroll = () => this.handleScroll(normalized.now);
    this.onPopState = () => this.recordNavigation("popstate");
    this.onPageHide = () => void this.flush("manual");
    this.onLoad = () => this.recordNavigationTiming();
    this.onVisibilityChange = () => {
      if (this.runtime.document.visibilityState === "hidden") {
        void this.flush("manual");
      }
    };
    this.restoreHistory = this.patchHistory();
    this.restorePerformanceObserver = this.observeLongTasks();
    this.restoreViewObserver = normalized.captureViews ? this.observeViews(normalized.captureViews) : () => {};
    this.restoreConsole = normalized.captureConsole ? this.patchConsole(normalized.captureConsole) : () => {};

    this.runtime.document.addEventListener("click", this.onClick, true);
    this.runtime.document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.runtime.window.addEventListener("scroll", this.onScroll, { passive: true });
    this.runtime.window.addEventListener("popstate", this.onPopState);
    this.runtime.window.addEventListener("pagehide", this.onPageHide);
    if (this.runtime.document.readyState === "complete") {
      this.onLoad();
    } else {
      this.runtime.window.addEventListener("load", this.onLoad, { once: true });
    }

    this.recordNavigation("page loaded");
  }

  addEvent(event: Parameters<JayTraceClient["addEvent"]>[0]): void {
    try {
      this.buffer.add(redact(event));
    } catch {
      // isolation: SDK bookkeeping must never throw into the host caller
    }
  }

  addAction(name: string, context?: Record<string, unknown>): void {
    try {
      const text = actionLine(name, context, this.options.redaction);
      this.buffer.addText("log", text, "info");
      this.replay?.recordAction(text);
    } catch {
      // isolation
    }
  }

  log(level: "debug" | "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void {
    try {
      const text = `log ${message}`;
      const data = context ? redact(context, this.options.redaction) : undefined;
      // level "error" records with error severity but is NOT a flush trigger —
      // only thrown exceptions drive the error flush, so this goes through the
      // plain buffer sink (unlike recordNetwork).
      this.buffer.addText("log", text, level, data);
      this.replay?.recordAction(text);
    } catch {
      // isolation: host logging must never throw back into the caller
    }
  }

  headers(headers?: HeadersInit): HeadersInit {
    try {
      return {
        ...headersObject(headers),
        traceparent: createChildTraceparent(this.rootTraceparent).value
      };
    } catch {
      // isolation: still hand back usable headers so the host request proceeds
      return headersObject(headers);
    }
  }

  async traceNetwork<T>({ method, url, run, status, headers }: JayTraceNetworkOptions<T>): Promise<T> {
    const startedAt = Date.now();
    // SDK bookkeeping around the user callback is isolated; the user's `run`
    // rejection (and `run` itself) must propagate untouched.
    let shouldTrace = false;
    let nextHeaders: HeadersInit;
    try {
      shouldTrace = shouldTraceUrl(url, this.traceOrigins, this.runtime.window.location.origin);
      nextHeaders = shouldTrace ? this.headers(headers) : headersObject(headers);
    } catch {
      nextHeaders = headers ?? {};
    }

    let result: T;
    try {
      result = await run(nextHeaders);
    } catch (error) {
      this.recordNetwork(networkText(method, url, undefined, Date.now() - startedAt, error instanceof Error ? error.message : String(error)), "error", shouldTrace);
      throw error;
    }

    try {
      const statusCode = status?.(result);
      this.recordNetwork(networkText(method, url, statusCode, Date.now() - startedAt), statusCode && statusCode >= 500 ? "error" : "info", shouldTrace);
    } catch {
      // isolation: a throwing status extractor / bookkeeping must not lose the result
    }
    return result;
  }

  setUser(user: Parameters<JayTraceClient["setUser"]>[0]): void {
    try {
      this.buffer.setUser(user);
      this.replay?.setUser(user as Record<string, string | number | boolean | null | undefined> | null);
    } catch {
      // isolation
    }
  }

  async flush(reason: FlushReason): Promise<void> {
    try {
      await this.buffer.flush(reason);
      if (reason === "manual") {
        await this.replay?.flush("manual");
      }
    } catch {
      // isolation: flush is frequently fired as void (pagehide/visibility/error) —
      // a rejection here would surface as an unhandled rejection in the host loop
    }
  }

  restore(): void {
    if (this.restored) {
      return;
    }

    this.restored = true;
    // Each teardown step is isolated so one failure never skips the rest and
    // restore() never throws into the host caller.
    this.safe(() => this.runtime.document.removeEventListener("click", this.onClick, true));
    this.safe(() => this.runtime.document.removeEventListener("visibilitychange", this.onVisibilityChange));
    this.safe(() => this.runtime.window.removeEventListener("scroll", this.onScroll));
    this.safe(() => this.runtime.window.removeEventListener("popstate", this.onPopState));
    this.safe(() => this.runtime.window.removeEventListener("pagehide", this.onPageHide));
    this.safe(() => this.runtime.window.removeEventListener("load", this.onLoad));
    this.safe(this.restoreHistory);
    this.safe(this.restorePerformanceObserver);
    this.safe(this.restoreViewObserver);
    this.safe(this.restoreConsole);
    this.safe(() => this.errorHandlers.restore());
    this.safe(() => this.fetchInstrumentation.restore());
    this.safe(() => this.xhrInstrumentation.restore());
    this.safe(() => this.replay?.stop());
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // isolation
    }
  }

  private handleClick(event: MouseEvent, now: () => Date, rageClickWindowMs: number): void {
    try {
      const selector = describeTarget(event.target);
      const sample: PointerSample = {
        selector,
        x: event.clientX,
        y: event.clientY,
        at: now().getTime()
      };
      const result = this.rageClickDetector.record(sample);

      this.buffer.addText("click", `click ${selector} x=${event.clientX} y=${event.clientY}`, "info");

      if (result.detected) {
        this.buffer.addText("rage_click", `rage-click ${selector} count=${result.count} withinMs=${rageClickWindowMs}`, "error");
        this.replay?.markError(`rage-click ${selector}`);
        void this.flush("rage_click");
      }
    } catch {
      // isolation: click runs inside a host DOM listener
    }
  }

  private async flushReplay(document: ReplayDocument, reason: "error" | "manual"): Promise<void> {
    await this.buffer.sendPayload({
      apiKey: this.options.apiKey,
      reason,
      document
    });
  }

  // v2 replay segments reuse the flush POST transport (sendPayload = plain fetch, no keepalive — segments are large).
  private async sendReplaySegment(segment: ReplayV2SegmentDocument): Promise<void> {
    await this.buffer.sendPayload({
      apiKey: this.options.apiKey,
      reason: "segment",
      document: segment
    });
  }

  private recordNetwork(text: string, severity?: "error" | "warn" | "info", forceReplay = false, data?: Record<string, unknown>): void {
    // Central network sink — also the callback handed to instrumentFetch/instrumentXhr,
    // so it must never throw back into a patched fetch/xhr and break host requests.
    try {
      this.buffer.addText("fetch", text, severity, data);
      if (forceReplay || shouldRecordReplayNetwork(text, this.replayNetworkOrigins)) {
        this.replay?.recordNetwork(text);
      }
      if (severity === "error") {
        void this.flush("error");
        void this.replay?.flush("error");
      }
    } catch {
      // isolation
    }
  }

  private handleScroll(now: () => Date): void {
    try {
      const current = now().getTime();
      if (current - this.lastScrollAt < 1000) {
        return;
      }

      this.lastScrollAt = current;
      this.buffer.addText("scroll", `scroll y=${Math.round(this.runtime.window.scrollY)} path=${this.safePath()}`, "info");
    } catch {
      // isolation: scroll runs inside a host DOM listener
    }
  }

  private patchHistory(): () => void {
    const history = this.runtime.window.history;
    if (!history) {
      return () => {};
    }

    const pushState = history.pushState.bind(history);
    const replaceState = history.replaceState.bind(history);
    history.pushState = (...args) => {
      const result = pushState(...args);
      this.recordNavigation("pushState");
      return result;
    };
    history.replaceState = (...args) => {
      const result = replaceState(...args);
      this.recordNavigation("replaceState");
      return result;
    };

    return () => {
      history.pushState = pushState;
      history.replaceState = replaceState;
    };
  }

  private patchConsole(config: boolean | Array<"error" | "warn" | "log" | "info">): () => void {
    const consoleRef = (this.runtime.window as unknown as { console?: Console }).console ?? globalThis.console;
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
    // Re-entrancy guard: SDK bookkeeping (or a patched console called from
    // inside a handler) must never recurse into a second timeline record.
    let inHandler = false;

    // Flood control: a dev-mode React warning (e.g. a missing list key) can fire
    // once per rendered item and drown the rolling timeline buffer in duplicate
    // console lines. Per session we record only the FIRST occurrence of each
    // distinct serialized text, count the rest, and leave a single "(repeated
    // xN)" summary when the repetition ends. Distinct unique texts are capped so
    // even varied noise can't monopolise the buffer.
    const severityFor = (method: string): "error" | "warn" | "info" =>
      method === "error" ? "error" : method === "warn" ? "warn" : "info";
    const messageCounts = new Map<string, number>();
    const maxKeys = 200; // Map key ceiling (memory cap); beyond this new distinct texts are dropped.
    const maxUnique = 30; // distinct recorded texts per session before capture mutes.
    let uniqueRecorded = 0;
    let muted = false;
    // The most recently repeated text, flushed as a summary when the next
    // distinct text is recorded.
    let pendingRepeat: { method: string; count: number; head: string } | null = null;
    const flushPendingRepeat = (): void => {
      if (pendingRepeat && pendingRepeat.count >= 3) {
        this.buffer.addText(
          "log",
          `console.${pendingRepeat.method} (repeated x${pendingRepeat.count}) ${pendingRepeat.head}`,
          severityFor(pendingRepeat.method)
        );
      }
      pendingRepeat = null;
    };

    for (const method of methods) {
      const original = (consoleRef as unknown as Record<string, unknown>)[method];
      if (typeof original !== "function") {
        continue;
      }
      const originalFn = original as (...args: unknown[]) => unknown;
      originals.set(method, originalFn);

      const severity: "error" | "warn" | "info" = severityFor(method);
      const patched = (...args: unknown[]): unknown => {
        // The host's original console call always runs first, untouched.
        const result = originalFn.apply(consoleRef, args);
        if (!inHandler) {
          inHandler = true;
          try {
            const serialized = serializeConsoleArgs(args);
            // Key on the first 200 chars only so a giant unique-suffixed message
            // can't bloat the dedupe Map; the recorded event keeps the full text.
            const key = serialized.slice(0, 200);
            const existing = messageCounts.get(key);
            if (existing !== undefined) {
              // Seen before: count it, hold it as the pending repeat, record nothing.
              messageCounts.set(key, existing + 1);
              pendingRepeat = { method, count: existing + 1, head: serialized.slice(0, 80) };
            } else if (messageCounts.size >= maxKeys) {
              // Dedupe Map is full — drop the new distinct text entirely (no key added).
            } else {
              messageCounts.set(key, 1);
              if (muted) {
                // Capture already muted: only the count above is kept.
              } else if (uniqueRecorded >= maxUnique) {
                flushPendingRepeat();
                muted = true;
                this.buffer.addText("log", `console capture muted (${maxUnique} unique messages reached)`, "warn");
              } else {
                // A new distinct text closes any pending repeat run, then records.
                flushPendingRepeat();
                this.buffer.addText("log", `console.${method} ${serialized}`, severity);
                uniqueRecorded += 1;
              }
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
        (consoleRef as unknown as Record<string, unknown>)[method] = patched;
      } catch {
        // isolation: a non-writable console method is silently skipped
        originals.delete(method);
      }
    }

    return () => {
      for (const [method, originalFn] of originals) {
        try {
          (consoleRef as unknown as Record<string, unknown>)[method] = originalFn;
        } catch {
          // isolation: restore is best-effort
        }
      }
    };
  }

  private recordNavigation(reason: string): void {
    // Invoked from onPopState and from the patched history.pushState/replaceState
    // wrappers — a throw here would propagate into the host's history call.
    try {
      const path = this.safePath();
      if (path === this.lastPath) {
        return;
      }

      this.lastPath = path;
      this.buffer.addText("navigation", `${reason} ${path}`, "info");
    } catch {
      // isolation
    }
  }

  private observeLongTasks(): () => void {
    const Observer = globalThis.PerformanceObserver;
    if (!Observer) {
      return () => {};
    }

    try {
      const observer = new Observer((list: PerformanceObserverEntryList) => {
        try {
          for (const entry of list.getEntries()) {
            const text = `long_task durationMs=${Math.round(entry.duration)} startMs=${Math.round(entry.startTime)} path=${this.safePath()}`;
            this.buffer.addText("performance", text, "warn");
            this.replay?.recordPerformance(text);
          }
        } catch {
          // isolation: PerformanceObserver callback runs on the host loop
        }
      });
      observer.observe({ type: "longtask", buffered: true });
      return () => observer.disconnect();
    } catch {
      return () => {};
    }
  }

  private recordNavigationTiming(): void {
    // Runs from the host 'load' listener.
    try {
      if (this.navigationTimingRecorded) {
        return;
      }

      this.navigationTimingRecorded = true;
      const navigation = globalThis.performance?.getEntriesByType?.("navigation")?.[0] as PerformanceNavigationTiming | undefined;
      if (!navigation || !Number.isFinite(navigation.duration) || navigation.duration <= 0) {
        return;
      }

      const parts = [
        `navigation_timing durationMs=${Math.round(navigation.duration)}`,
        timingDelta("ttfbMs", navigation.responseStart, navigation.requestStart),
        timingValue("domContentLoadedMs", navigation.domContentLoadedEventEnd),
        `path=${this.safePath()}`
      ].filter(Boolean);
      const text = parts.join(" ");
      this.buffer.addText("performance", text, "info");
      this.replay?.recordPerformance(text);
    } catch {
      // isolation
    }
  }

  private safePath(): string {
    const location = this.runtime.window.location;
    return `${location.pathname}${location.hash}`;
  }

  private observeViews(config: boolean | { selectors?: string[]; minRatio?: number; auto?: boolean }): () => void {
    const Observer = globalThis.IntersectionObserver;
    const MutObserver = globalThis.MutationObserver;
    if (!Observer || !MutObserver) {
      return () => {};
    }

    // Selector set: an explicit selectors list is used verbatim, otherwise the
    // built-in default set. data-jaytrace-view is always observed on top.
    const baseSelectors = typeof config === "object" && Array.isArray(config.selectors) ? config.selectors : DEFAULT_VIEW_SELECTORS;
    const combinedSelector = [...new Set(["[data-jaytrace-view]", ...baseSelectors])].join(",");
    const minRatio = typeof config === "object" && typeof config.minRatio === "number" ? config.minRatio : 0.5;
    // Large-block auto-detection defaults on whenever the feature is active.
    const auto = !(typeof config === "object" && config.auto === false);

    // Two-level dedupe: WeakSet blocks re-recording the same element, Set blocks
    // re-recording the same resolved name across different elements this session.
    const seenElements = new WeakSet<Element>();
    const seenNames = new Set<string>();
    const maxViews = 100;
    let recorded = 0;

    // Observe-target cap (independent of the record cap): protects against a
    // page that keeps growing large blocks; new targets past 200 are ignored.
    const maxObserved = 200;
    const observedElements = new WeakSet<Element>();
    let observedCount = 0;

    const matchesCombined = (element: Element): boolean => {
      try {
        return element.matches(combinedSelector);
      } catch {
        return false;
      }
    };

    // A block element counts as a "large" view candidate when its rect covers
    // >=25% of the viewport. script/style/body/html are never candidates.
    const excludedAutoTags = new Set(["SCRIPT", "STYLE", "BODY", "HTML"]);
    const isLargeBlock = (element: Element): boolean => {
      try {
        if (excludedAutoTags.has(element.tagName)) {
          return false;
        }
        const viewportArea = (this.runtime.window.innerWidth || 0) * (this.runtime.window.innerHeight || 0);
        if (viewportArea <= 0) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width * rect.height >= viewportArea * 0.25;
      } catch {
        return false;
      }
    };

    const intersectionObserver = new Observer(
      (entries) => {
        try {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.intersectionRatio >= minRatio) {
              const target = entry.target;
              if (seenElements.has(target)) continue;
              seenElements.add(target);
              intersectionObserver.unobserve(target);

              const name = viewName(target);
              if (seenNames.has(name)) continue;
              seenNames.add(name);

              this.buffer.addText("view", name, "info");
              recorded += 1;
              if (recorded >= maxViews) {
                intersectionObserver.disconnect();
                mutationObserver.disconnect();
                return;
              }
            }
          }
        } catch {
          // isolation
        }
      },
      { threshold: minRatio }
    );

    // Central observe gate so the 200-target cap and dedupe hold everywhere.
    const observeElement = (element: Element): void => {
      if (observedElements.has(element) || observedCount >= maxObserved) {
        return;
      }
      observedElements.add(element);
      observedCount += 1;
      intersectionObserver.observe(element);
    };

    const observeNodes = (node: Node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (matchesCombined(element)) {
          observeElement(element);
        }
        try {
          const children = element.querySelectorAll(combinedSelector);
          Array.from(children).forEach((child) => observeElement(child as Element));
        } catch {
          // isolation: an invalid selector must not break the whole observer
        }
        if (auto) {
          // Cost control: large-block detection touches only this node and its
          // direct children, never the whole subtree.
          if (isLargeBlock(element)) {
            observeElement(element);
          }
          try {
            for (const child of Array.from(element.children)) {
              if (isLargeBlock(child)) {
                observeElement(child);
              }
            }
          } catch {
            // isolation
          }
        }
      }
    };

    const mutationObserver = new MutObserver((mutations) => {
      try {
        for (const mutation of mutations) {
          if (mutation.type === "childList") {
            Array.from(mutation.addedNodes).forEach(observeNodes);
          } else if (mutation.type === "attributes" && mutation.attributeName === "data-jaytrace-view") {
            const target = mutation.target as Element;
            if (target.hasAttribute("data-jaytrace-view") && !seenElements.has(target)) {
              observeElement(target);
            }
          }
        }
      } catch {
        // isolation
      }
    });

    observeNodes(this.runtime.document.documentElement);
    mutationObserver.observe(this.runtime.document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-jaytrace-view"]
    });

    return () => {
      intersectionObserver.disconnect();
      mutationObserver.disconnect();
    };
  }
}

// Resolves a stable, human-readable view name by attribute priority, falling
// back to tag + trimmed text so selector-targeted elements without any id
// attribute still yield a meaningful label.
function viewName(element: Element): string {
  const attributes = ["data-jaytrace-view", "data-testid", "id", "aria-label"];
  for (const attribute of attributes) {
    const value = element.getAttribute(attribute);
    if (value) {
      return value;
    }
  }
  const tag = element.tagName.toLowerCase();
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
  return text ? `${tag}: ${text}` : tag;
}

function timingValue(name: string, value: number): string {
  return Number.isFinite(value) && value >= 0 ? `${name}=${Math.round(value)}` : "";
}

function timingDelta(name: string, end: number, start: number): string {
  const duration = end - start;
  return Number.isFinite(duration) && duration >= 0 ? `${name}=${Math.round(duration)}` : "";
}

function shouldRecordReplayNetwork(text: string, allowedOrigins: string[]): boolean {
  const url = /\b(?:fetch|xhr)\s+\S+\s+(\S+)/.exec(text)?.[1];
  if (!url) {
    return false;
  }
  if (url.startsWith("/")) {
    return true;
  }
  try {
    return allowedOrigins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

function shouldTraceUrl(url: string | URL, traceOrigins: string[], currentOrigin: string): boolean {
  const value = String(url);
  if (value.startsWith("/")) {
    return true;
  }
  try {
    const origin = new URL(value).origin;
    return origin === currentOrigin || traceOrigins.includes(origin);
  } catch {
    return false;
  }
}

function actionLine(name: string, context?: Record<string, unknown>, redaction?: { enabled?: boolean; sensitiveKeys?: string[] }): string {
  const safeContext = context ? safeJson(redact(context, redaction)) : "";
  return `action ${name}${safeContext ? ` ${safeContext}` : ""}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

// Safe serialization of console arguments: primitives stringify directly,
// objects are JSON-encoded and capped at 500 chars each, and the joined line
// is capped at 2,000 chars so a single log entry can't bloat the payload.
function serializeConsoleArgs(args: unknown[]): string {
  const parts = args.map((arg) => {
    if (typeof arg === "string") {
      return arg;
    }
    if (arg === null || arg === undefined || typeof arg !== "object") {
      return String(arg);
    }
    const json = safeJson(arg);
    return json.length > 500 ? json.slice(0, 500) : json;
  });
  const joined = parts.join(" ");
  return joined.length > 2000 ? joined.slice(0, 2000) : joined;
}

// Builds the session-id resolver handed to the buffer/instrumentation. An explicit
// sessionId pins a fixed session; otherwise a Datadog-style manager rotates on
// 15min idle / 4h max duration, persisting state to sessionStorage when available.
function createSessionIdGetter(explicitSessionId: string | undefined, windowRef: Window, now: () => number): () => string {
  if (explicitSessionId) {
    return () => explicitSessionId;
  }
  const manager = createSessionManager({
    storage: createSessionStorage(windowRef),
    generateId: () => createTraceparent().traceId,
    now
  });
  return () => manager.touch();
}

const SESSION_STORAGE_KEY = "jaytrace.session";

function createSessionStorage(windowRef: Window): SessionStorage | undefined {
  let storage: Storage | undefined;
  try {
    storage = windowRef.sessionStorage;
  } catch {
    // Access itself can throw under privacy mode — fall back to an in-memory session.
    return undefined;
  }
  if (!storage) {
    return undefined;
  }
  const store = storage;
  return {
    load(): SessionState | undefined {
      const raw = store.getItem(SESSION_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as SessionState) : undefined;
    },
    save(state: SessionState): void {
      store.setItem(SESSION_STORAGE_KEY, JSON.stringify(state));
    }
  };
}

export function initJayTrace(options: InitJayTraceOptions): JayTraceClient {
  if (options.enabled === false) {
    return new NoopJayTraceClient();
  }

  if (!options.apiKey.trim()) {
    throw new Error("JayTrace apiKey is required");
  }

  const runtime = getBrowserRuntime();
  runtime.window.__jayTraceClient?.restore();

  const client = new InternalJayTraceClient(runtime, options);
  runtime.window.__jayTraceClient = client;
  return client;
}

function getBrowserRuntime(): BrowserRuntime {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("JayTrace browser SDK can only run in a browser runtime");
  }

  return {
    window,
    document
  };
}

function headersObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers;
}

function networkText(method: string, url: string | URL, status: number | undefined, durationMs: number, error?: string): string {
  return [
    `${method.toUpperCase()} ${String(url)}`,
    status ? `status=${status}` : "",
    `durationMs=${Math.max(0, Math.round(durationMs))}`,
    error ? `error=${error}` : ""
  ].filter(Boolean).join(" ");
}
