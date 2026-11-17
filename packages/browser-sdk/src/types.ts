import type { JayTraceTimelineDocument, TimelineEvent } from "@jaytrace/core";
import type { ReplayDocument, ReplayOptions, ReplayV2SegmentDocument } from "@jaytrace/replay-core";

// 전역 선언은 모든 서브패스(/next 포함) 타입 체인이 지나는 이 파일에 둔다.
// 소비자는 캐스팅 없이 window.__jayTraceClient?.log(...) 로 쓸 수 있다.
declare global {
  interface Window {
    __jayTraceClient?: JayTraceClient;
  }
}

export interface BrowserReplayOptions extends ReplayOptions {
  maxSnapshotBytes?: number;
  networkOrigins?: string[];
  // v2 rrweb raw-event capture (optional — v1 callers unchanged). sampleRate is inherited from ReplayOptions.
  engine?: "rrweb" | "snapshot";
  segmentFlushMs?: number;
  maxSegmentBytes?: number;
  maxSessionMs?: number;
  idlePauseMs?: number;
}

export interface InitJayTraceOptions {
  enabled?: boolean;
  apiKey: string;
  endpoint?: string;
  service?: string;
  release?: string;
  environment?: string;
  sessionId?: string;
  maxEvents?: number;
  flushTimeoutMs?: number;
  rageClickWindowMs?: number;
  rageClickThreshold?: number;
  rageClickRadiusPx?: number;
  traceOrigins?: string[];
  replay?: BrowserReplayOptions;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  captureBody?: boolean | { maxBytes?: number };
  /**
   * Record element views into the timeline. `true` and an object without an
   * explicit `selectors` list both observe the built-in default selector set;
   * an explicit `selectors` list is used as-is (with `[data-jaytrace-view]`
   * always included). `auto` (default `true` whenever captureViews is active)
   * also observes selector-unmatched elements whose rendered area covers at
   * least a quarter of the viewport, catching large views without markup.
   */
  captureViews?: boolean | { selectors?: string[]; minRatio?: number; auto?: boolean };
  /**
   * Capture host `console` calls into the timeline as `log` events. `true` is
   * shorthand for `["error"]`; an array selects which console methods to patch.
   * The original console call always runs untouched. Default off.
   */
  captureConsole?: boolean | Array<"error" | "warn" | "log" | "info">;
  redaction?: { enabled?: boolean; sensitiveKeys?: string[] };
  /**
   * W3C traceparent to adopt as the client root, joining an existing trace
   * (e.g. the SSR root propagated via a `jaytrace-traceparent` meta tag).
   * Ignored when absent or not a valid traceparent — the SDK then generates
   * its own root.
   */
  traceparent?: string;
}

export interface JayTraceClient {
  readonly traceparent: string;
  addAction(name: string, context?: Record<string, unknown>): void;
  log(level: "debug" | "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void;
  addEvent(event: TimelineEvent): void;
  headers(headers?: HeadersInit): HeadersInit;
  traceNetwork<T>(options: JayTraceNetworkOptions<T>): Promise<T>;
  setUser(user: NonNullable<JayTraceTimelineDocument["user"]> | null): void;
  flush(reason: FlushReason): Promise<void>;
  restore(): void;
}

export interface JayTraceNetworkOptions<T> {
  method: string;
  url: string | URL;
  run: (headers: HeadersInit) => Promise<T>;
  status?: (result: T) => number | undefined;
  headers?: HeadersInit;
}

export type FlushReason = "error" | "rage_click" | "manual";

export interface JayTraceRumPayload {
  apiKey: string;
  // "segment" is a transport-only reason for v2 replay segments; it is not a flush() semantic.
  reason: FlushReason | "segment";
  document: JayTraceTimelineDocument | ReplayDocument | ReplayV2SegmentDocument;
}

export interface BrowserRuntime {
  window: Window;
  document: Document;
}
