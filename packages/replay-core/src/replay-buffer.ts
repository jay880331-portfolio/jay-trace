import { createReplayDocument, formatReplayLine } from "./replay-document.js";
import type {
  CreateReplayDocumentInput,
  ReplayDocument,
  ReplayEvent,
  ReplayEventKind,
  ReplayFrame,
  ReplayMetadata,
  ReplayMutation,
  ReplayMode,
  ReplayPlatform
} from "./types.js";

export interface ReplayBufferOptions {
  platform: ReplayPlatform;
  traceId: string;
  sessionId?: string;
  traceparent?: string;
  metadata?: ReplayMetadata;
  mode: Exclude<ReplayMode, "off">;
  maxEvents: number;
  maxDurationMs: number;
  now?: () => Date;
}

export class ReplayBuffer {
  private readonly startedAt: Date;
  private readonly events: ReplayEvent[] = [];
  private readonly frames: ReplayFrame[] = [];
  private readonly mutations: ReplayMutation[] = [];
  private readonly metadata: ReplayMetadata = {};
  private readonly now: () => Date;

  constructor(private readonly options: ReplayBufferOptions) {
    this.now = options.now ?? (() => new Date());
    this.startedAt = this.now();
    this.setMetadata(options.metadata);
  }

  add(kind: ReplayEventKind, text: string): ReplayEvent {
    const event = {
      at: this.elapsed(),
      kind,
      text
    };
    this.events.push(event);
    this.trim();
    return event;
  }

  addFrame(kind: ReplayEventKind, text: string, frame: Omit<ReplayFrame, "at" | "kind" | "text">): void {
    const at = this.elapsed();
    this.events.push({ at, kind, text });
    this.frames.push({ at, kind, text, ...frame });
    this.trim();
  }

  addFrameForEvent(event: ReplayEvent, frame: Omit<ReplayFrame, "at" | "kind" | "text">): void {
    this.frames.push({ at: event.at, kind: event.kind, text: event.text, ...frame });
    this.trim();
  }

  addMutation(mutation: Omit<ReplayMutation, "at">): void {
    this.mutations.push({ at: this.elapsed(), ...mutation });
    this.trim();
  }

  setMetadata(metadata?: ReplayMetadata): void {
    if (!metadata) {
      return;
    }
    for (const [key, value] of Object.entries(metadata)) {
      this.metadata[key] = value;
    }
  }

  deleteMetadataPrefix(prefix: string): void {
    for (const key of Object.keys(this.metadata)) {
      if (key.startsWith(prefix)) {
        delete this.metadata[key];
      }
    }
  }

  hasEvents(): boolean {
    return this.events.length > 0;
  }

  clear(): void {
    this.events.length = 0;
    this.frames.length = 0;
    this.mutations.length = 0;
  }

  lines(): string[] {
    return this.events.map(formatReplayLine);
  }

  document(): ReplayDocument {
    const input: CreateReplayDocumentInput = {
      platform: this.options.platform,
      traceId: this.options.traceId,
      sessionId: this.options.sessionId,
      traceparent: this.options.traceparent,
      metadata: this.metadata,
      mode: this.options.mode,
      startedAt: this.startedAt,
      endedAt: this.now(),
      events: this.events,
      frames: this.frames,
      mutations: this.mutations
    };
    return createReplayDocument(input);
  }

  private trim(): void {
    const cutoff = this.now().getTime() - this.options.maxDurationMs;
    while (this.events.length > this.options.maxEvents) {
      this.events.shift();
    }
    while (this.frames.length > this.options.maxEvents) {
      this.frames.shift();
    }
    while (this.mutations.length > this.options.maxEvents) {
      this.mutations.shift();
    }

    while (this.events[0] && absoluteTime(this.startedAt, this.events[0].at) < cutoff) {
      this.events.shift();
    }
    while (this.frames[0] && absoluteTime(this.startedAt, this.frames[0].at) < cutoff) {
      this.frames.shift();
    }
    while (this.mutations[0] && absoluteTime(this.startedAt, this.mutations[0].at) < cutoff) {
      this.mutations.shift();
    }
  }

  private elapsed(): string {
    const ms = Math.max(0, this.now().getTime() - this.startedAt.getTime());
    return `${(ms / 1000).toFixed(3)}s`;
  }
}

function absoluteTime(startedAt: Date, offset: string): number {
  const seconds = Number.parseFloat(offset.replace("s", ""));
  return startedAt.getTime() + Math.round(seconds * 1000);
}
