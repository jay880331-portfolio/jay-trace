import {
  createTimelineDocument,
  createTimelineEvent,
  getTraceId,
  parseTraceparent,
  redact,
  summarizeTimeline,
  type JayTraceError,
  type JayTraceTimelineDocument,
  type TimelineEvent
} from "@jaytrace/core";

export type TimelineFlushReason = "error" | "manual";

export interface TimelineBufferOptions {
  apiKey: string;
  endpoint: string;
  service: string;
  traceId: string;
  sessionId?: string;
  /** Active-session getter — resolved when a document is built so rotated sessions are stamped. Falls back to `sessionId`. */
  getSessionId?: () => string;
  traceparent: string;
  maxEvents?: number;
  fetchImpl: typeof fetch;
  now?: () => Date;
  redaction?: { enabled?: boolean; sensitiveKeys?: string[] };
}

const DEFAULT_MAX_EVENTS = 80;

/**
 * Rolling timeline.v1 buffer for React Native sessions — the event-stream mirror
 * of the browser SDK's RumBuffer. Records click/navigation/fetch/view/error/
 * performance events and POSTs a `jaytrace.timeline.v1` document (side "front")
 * so the console event stream is populated for RN traces, not just replay frames.
 */
export class TimelineBuffer {
  private readonly startedAt: Date;
  private readonly events: TimelineEvent[] = [];
  private readonly maxEvents: number;
  private readonly now: () => Date;
  private readonly traceId: string;
  private readonly spanId?: string;
  private user?: NonNullable<JayTraceTimelineDocument["user"]>;
  private error?: JayTraceError;
  private flushing = false;
  private pendingFlushReason?: TimelineFlushReason;

  constructor(private readonly options: TimelineBufferOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.startedAt = this.now();
    // Root traceparent's traceId is authoritative; fall back to the provided id.
    this.traceId = getTraceId(options.traceparent) ?? options.traceId;
    this.spanId = parseTraceparent(options.traceparent)?.spanId;
  }

  add(event: TimelineEvent): void {
    this.events.push(redact(event, this.options.redaction));
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  addText(
    kind: TimelineEvent["kind"],
    text: string,
    severity?: TimelineEvent["severity"],
    data?: Record<string, unknown>
  ): void {
    const event = createTimelineEvent({
      at: this.elapsed(),
      kind,
      severity,
      text
    });
    if (data) {
      event.data = data;
    }
    this.add(event);
  }

  addError(text: string, error?: JayTraceError): void {
    this.addText("error", text, "error");
    this.error = error ?? this.error;
  }

  setUser(user: NonNullable<JayTraceTimelineDocument["user"]> | null): void {
    this.user = user ?? undefined;
  }

  hasEvents(): boolean {
    return this.events.length > 0;
  }

  snapshot(): JayTraceTimelineDocument {
    const doc = createTimelineDocument({
      service: this.options.service,
      side: "front",
      traceId: this.traceId,
      sessionId: this.options.getSessionId?.() ?? this.options.sessionId,
      spanId: this.spanId,
      traceparent: this.options.traceparent,
      startedAt: this.startedAt,
      endedAt: this.now(),
      summary: summarizeTimeline(this.events, "React Native timeline captured."),
      events: this.events,
      context: {
        user: this.user as Record<string, unknown> | undefined
      },
      error: this.error
    });
    if (this.user) {
      doc.user = this.user;
    }
    return doc;
  }

  async flush(reason: TimelineFlushReason): Promise<void> {
    // Re-entrant flushes merge into a single pending follow-up (browser parity):
    // a flush requested mid-send runs once when the in-flight POST settles.
    if (this.flushing) {
      this.pendingFlushReason = reason;
      return;
    }

    if (this.events.length === 0) {
      return;
    }

    this.flushing = true;
    const body = JSON.stringify({
      apiKey: this.options.apiKey,
      reason,
      document: redact(this.snapshot(), this.options.redaction)
    });

    try {
      await this.post(body);
    } catch {
      // Silent: one retry, then give up (a dropped RUM doc must not surface).
      try {
        await this.post(body);
      } catch {
      }
    } finally {
      this.flushing = false;
      const pending = this.pendingFlushReason;
      this.pendingFlushReason = undefined;
      if (pending) {
        await this.flush(pending);
      }
    }
  }

  private async post(body: string): Promise<void> {
    await this.options.fetchImpl(this.options.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.traceparent ? { traceparent: this.options.traceparent } : {})
      },
      body
    });
  }

  private elapsed(): string {
    const ms = Math.max(0, this.now().getTime() - this.startedAt.getTime());
    return `${(ms / 1000).toFixed(3)}s`;
  }
}
