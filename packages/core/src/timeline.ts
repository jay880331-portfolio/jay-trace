import type { CreateTimelineDocumentInput, JayTraceTimelineDocument, TimelineEvent } from "./types.js";
import { redact } from "./redaction.js";

export function createTimelineEvent(input: Omit<TimelineEvent, "at"> & { at?: Date | string }): TimelineEvent {
  return {
    at: formatOffset(input.at ?? new Date()),
    kind: input.kind,
    severity: input.severity,
    text: input.text.trim()
  };
}

export function createTimelineDocument(input: CreateTimelineDocumentInput): JayTraceTimelineDocument {
  const startedAt = input.startedAt ?? new Date();
  const document: JayTraceTimelineDocument = {
    schema: "jaytrace.timeline.v1",
    service: input.service,
    side: input.side,
    traceId: input.traceId,
    sessionId: input.sessionId,
    spanId: input.spanId,
    traceparent: input.traceparent,
    startedAt: startedAt.toISOString(),
    endedAt: input.endedAt?.toISOString(),
    summary: input.summary.trim(),
    timeline: input.events.map(formatTimelineLine),
    events: input.events,
    context: input.context,
    error: input.error
  };

  return redact(stripUndefined(document));
}

export function formatTimelineLine(event: TimelineEvent): string {
  const severity = event.severity ? ` ${event.severity}` : "";
  return `${event.at} ${event.kind}${severity} ${event.text}`.trim();
}

export function summarizeTimeline(events: TimelineEvent[], fallback = "No timeline events captured."): string {
  const critical = events.find((event) => event.severity === "fatal" || event.severity === "error");
  if (critical) {
    return critical.text;
  }

  return events.at(-1)?.text ?? fallback;
}

function formatOffset(value: Date | string): string {
  if (typeof value === "string") {
    return value;
  }

  return value.toISOString();
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(stripUndefined) as T;
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        output[key] = stripUndefined(item);
      }
    }
    return output as T;
  }

  return value;
}
