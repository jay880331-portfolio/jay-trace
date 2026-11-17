import type { ReplayV2SegmentDocument } from "./types.js";

export interface ReplaySegmenterOptions {
  flushMs: number;
  maxBytes: number;
  maxSessionMs: number;
  now?: () => Date;
}

export type SegmenterAddResult = "buffered" | "flush" | "session-ended";

export class ReplaySegmenter {
  private readonly options: ReplaySegmenterOptions;
  private readonly now: () => Date;
  private readonly sessionStartedAt: number;
  private events: unknown[] = [];
  private bytes = 0;
  private segmentStartedAt: number;
  private nextSeq = 0;
  private ended = false;

  constructor(options: ReplaySegmenterOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.sessionStartedAt = this.now().getTime();
    this.segmentStartedAt = this.sessionStartedAt;
  }

  get seq(): number {
    return this.nextSeq;
  }

  add(event: unknown): SegmenterAddResult {
    if (this.ended) {
      return "session-ended";
    }

    const current = this.now().getTime();
    if (this.events.length === 0) {
      this.segmentStartedAt = current;
    }
    this.events.push(event);
    this.bytes += byteEstimate(event);

    // ponytail: push the event before checking maxSessionMs so the final
    // event that trips the session end is still part of the drained tail,
    // not silently dropped.
    if (current - this.sessionStartedAt >= this.options.maxSessionMs) {
      this.ended = true;
      return "session-ended";
    }

    if (this.bytes >= this.options.maxBytes || current - this.segmentStartedAt >= this.options.flushMs) {
      return "flush";
    }
    return "buffered";
  }

  drain(): { seq: number; events: unknown[]; startedAt: Date; endedAt: Date } | null {
    if (this.events.length === 0) {
      return null;
    }
    const drained = {
      seq: this.nextSeq,
      events: this.events,
      startedAt: new Date(this.segmentStartedAt),
      endedAt: this.now()
    };
    this.nextSeq += 1;
    this.events = [];
    this.bytes = 0;
    this.segmentStartedAt = this.now().getTime();
    return drained;
  }
}

export function decideReplaySampling(sampleRate: number, random: () => number = Math.random): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  return random() < sampleRate;
}

export class ErrorTailBuffer {
  private readonly maxEvents: number;
  private readonly maxBytes?: number;
  private items: Array<{ event: unknown; bytes: number }> = [];
  private bytes = 0;

  constructor(options: { maxEvents: number; maxBytes?: number }) {
    this.maxEvents = options.maxEvents;
    this.maxBytes = options.maxBytes;
  }

  add(event: unknown): void {
    const bytes = byteEstimate(event);
    this.items.push({ event, bytes });
    this.bytes += bytes;
    // Evict oldest-first past either cap, but never the last remaining item: a
    // single oversized event is sent as-is since the client cannot split it.
    // Dropping old events can truncate the rrweb full snapshot, but the console
    // has a v1 fallback so this is acceptable.
    while (
      this.items.length > 1 &&
      (this.items.length > this.maxEvents ||
        (this.maxBytes !== undefined && this.bytes > this.maxBytes))
    ) {
      const evicted = this.items.shift()!;
      this.bytes -= evicted.bytes;
    }
  }

  drainTail(): unknown[] {
    const tail = this.items.map((item) => item.event);
    this.items = [];
    this.bytes = 0;
    return tail;
  }
}

export function isReplayV2SegmentDocument(value: unknown): value is ReplayV2SegmentDocument {
  if (typeof value !== "object" || value === null) return false;
  const doc = value as Record<string, unknown>;
  if (
    !(
      doc.schema === "jaytrace.replay.v2" &&
      (doc.engine === "rrweb" || doc.engine === "wireframe") &&
      (doc.platform === "web" || doc.platform === "react-native" || doc.platform === "flutter") &&
      typeof doc.traceId === "string" && /^[0-9a-f]{32}$/.test(doc.traceId) &&
      typeof doc.sessionId === "string" && doc.sessionId.length > 0 &&
      typeof doc.seq === "number" && Number.isInteger(doc.seq) && doc.seq >= 0 &&
      typeof doc.startedAt === "string" &&
      typeof doc.endedAt === "string"
    )
  ) {
    return false;
  }

  if (doc.engine === "rrweb") {
    return Array.isArray(doc.rrwebEvents);
  }

  // engine === "wireframe"
  return Array.isArray(doc.wireframeFrames) && doc.wireframeFrames.every(isWireframeFrame);
}

function isWireframeFrame(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    typeof frame.atMs === "number" &&
    typeof frame.viewport === "object" && frame.viewport !== null &&
    Array.isArray(frame.nodes)
  );
}

function byteEstimate(event: unknown): number {
  try {
    return JSON.stringify(event)?.length ?? 64;
  } catch {
    return 64;
  }
}
