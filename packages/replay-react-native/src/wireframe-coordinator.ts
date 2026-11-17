import {
  ReplaySegmenter,
  ErrorTailBuffer,
  decideReplaySampling,
  type ReplayMetadata,
  type ReplayV2SegmentDocument,
  type WireframeFrame
} from "@jaytrace/replay-core";
import { buildWireframeFrame } from "./wireframe.js";
import type { ReactNativeViewTreeNode } from "./types.js";

// ponytail: ErrorTailBuffer cap mirrors Phase 2 (spec: 2000 frames). Not a
// constructor knob — no caller needs to tune it, and one number beats a param.
const ERROR_TAIL_MAX = 2000;
// Byte cap on the buffered error tail: the on-error segment must fit inside the
// collector's ~1MB per-request budget with room to spare for envelope/metadata,
// so cap the drained frames at 768KiB regardless of the 2000-frame ceiling.
const ERROR_TAIL_MAX_BYTES = 786_432;

export interface ReactNativeWireframeCoordinatorOptions {
  /** 0..1 fraction. Values >= 1 always sample (decideReplaySampling), so a legacy 100 also means "always". */
  sampleRate: number;
  segmentFlushMs: number;
  maxSegmentBytes: number;
  maxSessionMs: number;
  /** Accepted for API completeness — the periodic capture timer lives in init.ts, not the coordinator. */
  wireframeIntervalMs: number;
  maskText: boolean;
  sessionId: string;
  traceId: string;
  traceparent?: string;
  metadata?: Record<string, unknown>;
  sendSegment: (doc: ReplayV2SegmentDocument) => void;
  now?: () => Date;
  random?: () => number;
}

export type WireframeViewport = { width: number; height: number };
export type WireframePointer = { x: number; y: number; kind: "tap" | "move" };

/**
 * Framework-free capture coordinator. Turns RN view-tree snapshots into
 * `jaytrace.replay.v2` wireframe segments via replay-core's `ReplaySegmenter`
 * (when sampled) or buffers them in an `ErrorTailBuffer` for on-error promotion
 * (when not sampled). No react-native imports — timers/AppState wiring lives in
 * init.ts and drives `capture()` from the outside.
 *
 * atMs convention: each segment's frames carry atMs relative to THAT segment's
 * own startedAt (matches wireframeFrames.mjs / WireframePlayer, which re-bases
 * per-segment onto the session start). The segment start is the timestamp of its
 * first added frame, so that frame's atMs is 0.
 */
export class ReactNativeWireframeCoordinator {
  private readonly options: ReactNativeWireframeCoordinatorOptions;
  private readonly now: () => Date;
  private readonly segmenter: ReplaySegmenter;
  private readonly errorTail: ErrorTailBuffer;
  private readonly baseMetadata: ReplayMetadata;
  readonly sampled: boolean;

  private lastHash: string | null = null;
  private segmentStartMs: number | null = null;
  private tailStartMs: number | null = null;
  private stopped = false;

  constructor(options: ReactNativeWireframeCoordinatorOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.sampled = decideReplaySampling(options.sampleRate, options.random);
    this.segmenter = new ReplaySegmenter({
      flushMs: options.segmentFlushMs,
      maxBytes: options.maxSegmentBytes,
      maxSessionMs: options.maxSessionMs,
      now: this.now
    });
    this.errorTail = new ErrorTailBuffer({ maxEvents: ERROR_TAIL_MAX, maxBytes: ERROR_TAIL_MAX_BYTES });
    this.baseMetadata = {
      ...toReplayMetadata(options.metadata),
      "replay.sampled": String(this.sampled)
    };
  }

  capture(root: ReactNativeViewTreeNode, viewport: WireframeViewport, pointer?: WireframePointer): void {
    if (this.stopped) {
      return;
    }
    const nowMs = this.now().getTime();
    // Build with atMs 0; the real atMs is assigned after dedup once we know the
    // segment baseline (so a deduped leading frame doesn't skew the baseline).
    const frame = buildWireframeFrame(root, { maskText: this.options.maskText, atMs: 0, viewport, pointer });
    const hash = hashFrame(frame);
    if (hash === this.lastHash) {
      return;
    }
    this.lastHash = hash;

    if (this.sampled) {
      if (this.segmentStartMs === null) {
        this.segmentStartMs = nowMs;
      }
      frame.atMs = nowMs - this.segmentStartMs;
      const result = this.segmenter.add(frame);
      if (result === "flush") {
        this.flushSegment();
      } else if (result === "session-ended") {
        this.flushSegment();
        this.stopped = true;
      }
    } else {
      if (this.tailStartMs === null) {
        this.tailStartMs = nowMs;
      }
      frame.atMs = nowMs - this.tailStartMs;
      this.errorTail.add(frame);
    }
  }

  /** Drain the error tail into a seq-0 error segment (no-op when sampled or empty). */
  promoteErrorTail(): void {
    if (this.sampled) {
      return;
    }
    const frames = this.errorTail.drainTail() as WireframeFrame[];
    if (frames.length === 0) {
      return;
    }
    const startedAt = new Date(this.tailStartMs ?? this.now().getTime());
    const endedAt = this.now();
    this.tailStartMs = null;
    // Re-prime after draining: the drained tail's last frame is gone, so the next
    // captured frame — even an identical one — must not be dedup-dropped against a
    // stale hash. The coordinator holds no snapshot to force an immediate keyframe,
    // so resetting lastHash is the strongest re-prime available here; the next
    // capture() call re-establishes the tail baseline.
    this.lastHash = null;
    this.options.sendSegment(
      this.assembleDoc(0, frames, startedAt, endedAt, { ...this.baseMetadata, "replay.reason": "error" })
    );
  }

  /** Send any buffered (not-yet-flushed) sampled frames as a segment. No-op otherwise. */
  flushPending(): void {
    if (this.sampled) {
      this.flushSegment();
    }
  }

  dispose(): void {
    if (this.stopped) {
      return;
    }
    this.flushSegment();
    this.stopped = true;
  }

  private flushSegment(): void {
    const drained = this.segmenter.drain();
    if (!drained) {
      return;
    }
    this.segmentStartMs = null; // next added frame starts a fresh segment
    this.options.sendSegment(
      this.assembleDoc(drained.seq, drained.events as WireframeFrame[], drained.startedAt, drained.endedAt, this.baseMetadata)
    );
  }

  private assembleDoc(
    seq: number,
    wireframeFrames: WireframeFrame[],
    startedAt: Date,
    endedAt: Date,
    metadata: ReplayMetadata
  ): ReplayV2SegmentDocument {
    return {
      schema: "jaytrace.replay.v2",
      engine: "wireframe",
      platform: "react-native",
      traceId: this.options.traceId,
      sessionId: this.options.sessionId,
      // Spread is exempt from excess-property checks; traceparent is harmless
      // extra metadata for the collector (which keys off traceId).
      ...(this.options.traceparent ? { traceparent: this.options.traceparent } : {}),
      seq,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      metadata,
      wireframeFrames
    };
  }
}

function hashFrame(frame: WireframeFrame): string {
  // Cheap structural hash: nodes + pointer (atMs/viewport excluded — a static
  // screen re-measured at a new time must still dedup, but a tap must not).
  return JSON.stringify({ nodes: frame.nodes, pointer: frame.pointer });
}

function toReplayMetadata(metadata: Record<string, unknown> | undefined): ReplayMetadata {
  const out: ReplayMetadata = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    out[key] =
      value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)
        ? (value as string | number | boolean | null | undefined)
        : String(value);
  }
  return out;
}
