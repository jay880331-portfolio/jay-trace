import {
  createTimelineDocument,
  createTimelineEvent,
  redact,
  summarizeTimeline,
  type JayTraceError,
  type JayTraceTimelineDocument,
  type TimelineEvent
} from "@jaytrace/core";

import type { FlushReason, InitJayTraceOptions, JayTraceRumPayload } from "./types.js";

export interface RumBufferOptions {
  apiKey: string;
  endpoint: string;
  service: string;
  traceId: string;
  sessionId?: string;
  // Preferred over the static `sessionId`: resolved per document so an idle/max-duration
  // rotation is reflected in each snapshot. Calling it also records session activity.
  getSessionId?: () => string;
  traceparent: string;
  spanId: string;
  release?: string;
  environment?: string;
  maxEvents: number;
  flushTimeoutMs: number;
  fetchImpl: typeof fetch;
  now: () => Date;
  getLocation: () => Location | null;
  getUserAgent: () => string;
  redaction?: { enabled?: boolean; sensitiveKeys?: string[] };
}

export class RumBuffer {
  private readonly startedAt: Date;
  private readonly events: TimelineEvent[] = [];
  private user?: NonNullable<JayTraceTimelineDocument["user"]>;
  private error?: JayTraceError;
  private flushing = false;
  private pendingFlushReason?: FlushReason;

  constructor(private readonly options: RumBufferOptions) {
    this.startedAt = options.now();
  }

  add(event: TimelineEvent): void {
    this.events.push(redact(event, this.options.redaction));
    if (this.events.length > this.options.maxEvents) {
      this.events.shift();
    }
  }

  addText(kind: TimelineEvent["kind"], text: string, severity?: TimelineEvent["severity"], data?: Record<string, unknown>): void {
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

  snapshot(): JayTraceTimelineDocument {
    const doc = createTimelineDocument({
      service: this.options.service,
      side: "front",
      traceId: this.options.traceId,
      sessionId: this.options.getSessionId?.() ?? this.options.sessionId,
      spanId: this.options.spanId,
      traceparent: this.options.traceparent,
      startedAt: this.startedAt,
      endedAt: this.options.now(),
      summary: summarizeTimeline(this.events, "Browser timeline captured."),
      events: this.events,
      context: {
        url: this.options.getLocation()?.href,
        userAgent: this.options.getUserAgent(),
        release: this.options.release,
        environment: this.options.environment,
        user: this.user as Record<string, unknown> | undefined
      },
      error: this.error
    });
    if (this.user) {
      doc.user = this.user;
    }
    return doc;
  }

  async flush(reason: FlushReason): Promise<void> {
    if (this.flushing) {
      this.pendingFlushReason = reason;
      return;
    }

    if (this.events.length === 0) {
      return;
    }

    this.flushing = true;
    const payload: JayTraceRumPayload = {
      apiKey: this.options.apiKey,
      reason,
      document: this.snapshot()
    };

    const body = JSON.stringify(redactPayloadDocument(payload, this.options.redaction));

    try {
      await withTimeout(
        this.options.fetchImpl(this.options.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            traceparent: this.options.traceparent
          },
          body,
          ...keepaliveInit(body)
        }),
        this.options.flushTimeoutMs
      );
    } catch {
    } finally {
      this.flushing = false;
      const pending = this.pendingFlushReason;
      this.pendingFlushReason = undefined;
      if (pending) {
        await this.flush(pending);
      }
    }
  }

  async sendPayload(payload: JayTraceRumPayload): Promise<void> {
    try {
      await withTimeout(
        this.options.fetchImpl(this.options.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            traceparent: this.options.traceparent
          },
          body: JSON.stringify(redactPayloadDocument(payload, this.options.redaction))
        }),
        this.options.flushTimeoutMs
      );
    } catch {
    }
  }

  private elapsed(): string {
    const ms = Math.max(0, this.options.now().getTime() - this.startedAt.getTime());
    return `${(ms / 1000).toFixed(3)}s`;
  }
}

function keepaliveInit(body: string): Pick<RequestInit, "keepalive"> {
  return byteLength(body) <= 60_000 ? { keepalive: true } : {};
}

function redactPayloadDocument(payload: JayTraceRumPayload, redaction?: { enabled?: boolean; sensitiveKeys?: string[] }): JayTraceRumPayload {
  const document = payload.document;
  if ("schema" in document && document.schema === "jaytrace.replay.v2") {
    // rrwebEvents are masked at record time (maskTextSelector/maskAllInputs),
    // so re-redacting here would only walk deep FullSnapshot nodes into
    // "[MaxDepth]" stubs. Redact everything else, pass rrwebEvents through.
    const { rrwebEvents, ...rest } = document;
    return { ...payload, document: { ...redact(rest, redaction), rrwebEvents } };
  }

  return {
    ...payload,
    document: redact(document, redaction)
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function normalizeOptions(options: InitJayTraceOptions): Required<Pick<
  InitJayTraceOptions,
  "endpoint" | "service" | "maxEvents" | "flushTimeoutMs" | "rageClickWindowMs" | "rageClickThreshold" | "rageClickRadiusPx" | "now"
>> &
  InitJayTraceOptions {
  return {
    ...options,
    endpoint: options.endpoint ?? "/jaytrace/rum",
    service: options.service ?? "web",
    maxEvents: options.maxEvents ?? 80,
    flushTimeoutMs: options.flushTimeoutMs ?? 2000,
    rageClickWindowMs: options.rageClickWindowMs ?? 1200,
    rageClickThreshold: options.rageClickThreshold ?? 4,
    rageClickRadiusPx: options.rageClickRadiusPx ?? 24,
    now: options.now ?? (() => new Date()),
    captureViews: options.captureViews ?? false,
    captureBody: options.captureBody,
    redaction: options.redaction
  };
}

async function withTimeout(response: Promise<Response>, timeoutMs: number): Promise<Response> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("JayTrace RUM flush timed out")), timeoutMs);
  });

  try {
    return await Promise.race([response, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
