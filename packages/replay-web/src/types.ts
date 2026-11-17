import type { ReplayDocument, ReplayMetadata, ReplayMode, ReplayV2SegmentDocument } from "@jaytrace/replay-core";

export interface StartReplayWebOptions {
  traceId: string;
  sessionId?: string;
  traceparent?: string;
  metadata?: ReplayMetadata;
  flush: (document: ReplayDocument, reason: "error" | "manual") => Promise<void> | void;
  enabled?: boolean;
  mode?: ReplayMode;
  sampleRate?: number;
  privacy?: "mask-all" | "mask-inputs" | "allow";
  maskText?: boolean;
  maskInputs?: boolean;
  maxEvents?: number;
  maxDurationMs?: number;
  maxSnapshotBytes?: number;
  now?: () => Date;
  // v2 rrweb raw-event capture (all optional — v1 callers compile unchanged)
  engine?: "rrweb" | "snapshot";
  segmentFlushMs?: number;
  maxSegmentBytes?: number;
  maxSessionMs?: number;
  idlePauseMs?: number;
  sendSegment?: (segment: ReplayV2SegmentDocument) => void | Promise<void>;
  /** Test-only: injects a deterministic random source for sampling decisions. Defaults to Math.random. */
  random?: () => number;
}

export interface ReplayWebController {
  readonly engine: "rrweb" | "snapshot";
  markError(text: string): void;
  recordAction(text: string): void;
  recordNetwork(text: string): void;
  recordPerformance(text: string): void;
  setUser(user: ReplayMetadata | null): void;
  flush(reason: "error" | "manual"): Promise<void>;
  stop(): void;
}

export interface NormalizedReplayWebOptions {
  enabled: boolean;
  engine: "rrweb" | "snapshot";
  sampled: boolean;
  mode: Exclude<ReplayMode, "off">;
  maskText: boolean;
  maskInputs: boolean;
  maxEvents: number;
  maxDurationMs: number;
  maxSnapshotBytes: number;
  segmentFlushMs: number;
  maxSegmentBytes: number;
  maxSessionMs: number;
  idlePauseMs: number;
  now: () => Date;
}
