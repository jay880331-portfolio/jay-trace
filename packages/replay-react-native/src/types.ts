import type { ReplayDocument, ReplayMetadata, ReplayMode, ReplayPrivacy } from "@jaytrace/replay-core";

export type ReactNativeReplayEngine = "wireframe" | "screenshot" | "event";

export interface ReactNativeScreenshotFrame {
  image: string;
  mediaType?: string;
  width?: number;
  height?: number;
}

export interface InitJayTraceReactNativeReplayOptions {
  apiKey: string;
  endpoint: string;
  traceId: string;
  sessionId?: string;
  /** Active-session getter — resolved at document-creation time so rotated sessions are stamped correctly. Falls back to `sessionId`. */
  getSessionId?: () => string;
  traceparent?: string;
  metadata?: ReplayMetadata;
  /** Service name stamped onto the timeline.v1 document (defaults to "react-native"). */
  service?: string;
  /** Emit a timeline.v1 event-stream document alongside the replay document (off by default; the one-line client enables it). */
  captureTimeline?: boolean;
  /** Rolling timeline event cap before the oldest events are dropped (default 80). */
  maxTimelineEvents?: number;
  /**
   * Capture host `console` output as timeline `log` events (off by default).
   * `true` is shorthand for `["error"]`; an array selects the methods to patch.
   */
  captureConsole?: boolean | Array<"error" | "warn" | "log" | "info">;
  enabled?: boolean;
  mode?: ReplayMode;
  sampleRate?: number;
  privacy?: ReplayPrivacy;
  maskText?: boolean;
  maskInputs?: boolean;
  maxEvents?: number;
  maxDurationMs?: number;
  maxScreenshotBytes?: number;
  /** Redaction applied to uploaded replay documents (defaults on; opt-out via enabled:false). */
  redaction?: { enabled?: boolean; sensitiveKeys?: string[] };
  // --- v2 wireframe replay (Phase 3) ---
  engine?: ReactNativeReplayEngine;
  wireframeIntervalMs?: number;
  segmentFlushMs?: number;
  maxSegmentBytes?: number;
  maxSessionMs?: number;
  screenshot?: () => ReactNativeScreenshotFrame | Promise<ReactNativeScreenshotFrame | null> | null;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface ReactNativeNetworkEvent {
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  error?: string;
  /** Captured (already redacted) request body, attached when captureBody is enabled. */
  requestBody?: unknown;
  /** Captured (already redacted) response body, attached when captureBody is enabled. */
  responseBody?: unknown;
}

export type ReactNativeViewTreePropPrimitive = string | number | boolean | null | undefined;

export interface ReactNativeViewTreeNode {
  type: string;
  key?: string;
  // A nested object value is used for the RN `style` prop (e.g. { backgroundColor, borderRadius, fontSize, color }).
  props?: Record<string, ReactNativeViewTreePropPrimitive | Record<string, ReactNativeViewTreePropPrimitive>>;
  children?: ReactNativeViewTreeNode[];
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface ReactNativeCrashMetadata {
  message?: string;
  stack?: string;
  deviceModel?: string;
  osName?: string;
  osVersion?: string;
  appVersion?: string;
  buildNumber?: string;
  nativeCrashId?: string;
}

export interface ReactNativeReplayClient {
  setUser(user: ReplayMetadata | null): void;
  recordScreen(name: string): void;
  recordScreenEnd(name: string, durationMs: number): void;
  recordComponentMount(name: string): void;
  recordComponentUnmount(name: string, durationMs: number): void;
  recordViewTreeSnapshot(snapshot: ReactNativeViewTreeNode): void;
  recordAction(name: string, detail?: string): void;
  recordTap(target: string, x?: number, y?: number): void;
  recordInput(target: string): void;
  recordScroll(target: string, offset?: number): void;
  recordPerformance(name: string, durationMs: number, detail?: string): void;
  recordGesture(name: string, detail?: string): void;
  /** Records an element-exposure ("view") event. Name-deduped once per session, capped at 100 per session. */
  recordView(name: string): void;
  /**
   * Records a custom log timeline event (`log <message>`). `context` is redacted
   * before attach. Level "error" records error severity but is NOT a flush trigger.
   */
  log(level: "debug" | "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void;
  recordNetwork(event: ReactNativeNetworkEvent): Promise<void>;
  recordError(error: unknown, options?: { fatal?: boolean }): Promise<void>;
  recordNativeCrash(metadata: ReactNativeCrashMetadata): Promise<void>;
  flush(reason: "error" | "manual"): Promise<void>;
  snapshot(): ReplayDocument;
  /** Restores any global patches installed by this client (currently the captureConsole console patch). */
  restore(): void;
}
