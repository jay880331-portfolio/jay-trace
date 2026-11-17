import type { Context } from "@opentelemetry/api";
import { hrTimeToMilliseconds } from "@opentelemetry/core";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { JayTraceSeverity } from "@jaytrace/core";

import { toSpanLite } from "./converter.js";
import type { TraceBuffer } from "./trace-buffer.js";

/** Feeds every started/ended span into the shared buffer. */
export class JayTraceSpanProcessor implements SpanProcessor {
  constructor(private readonly buffer: TraceBuffer) {}

  onStart(span: Span, _parentContext: Context): void {
    // OTel calls processors bare: anything thrown here escapes into the app's tracer.
    try {
      const parent = span.parentSpanContext;
      this.buffer.onSpanStart(span.spanContext().spanId, parent?.spanId, parent?.isRemote ?? false);
    } catch (error) {
      warn("onStart", error);
    }
  }

  onEnd(span: ReadableSpan): void {
    // Thrown here it would surface out of the app's own span.end() call.
    try {
      this.buffer.onSpanEnd(toSpanLite(span));
    } catch (error) {
      warn("onEnd", error);
    }
  }

  async forceFlush(): Promise<void> {
    await this.buffer.drain();
  }

  async shutdown(): Promise<void> {
    await this.buffer.drain();
  }
}

/** Attaches log records to the buffered root of the span they were emitted under. */
export class JayTraceLogRecordProcessor implements LogRecordProcessor {
  constructor(private readonly buffer: TraceBuffer) {}

  onEmit(logRecord: SdkLogRecord): void {
    // Thrown here it would surface out of the app's logger.emit() call.
    try {
      this.buffer.onLog(logRecord.spanContext?.spanId, {
        atMs: hrTimeToMilliseconds(logRecord.hrTime),
        severity: toSeverity(logRecord.severityNumber),
        text: toText(logRecord.body)
      });
    } catch (error) {
      warn("onEmit", error);
    }
  }

  async forceFlush(): Promise<void> {
    await this.buffer.drain();
  }

  async shutdown(): Promise<void> {
    await this.buffer.drain();
  }
}

// SeverityNumber buckets: 1-4 TRACE, 5-8 DEBUG, 9-12 INFO, 13-16 WARN, 17-20 ERROR, 21+ FATAL.
function toSeverity(severityNumber: number | undefined): JayTraceSeverity {
  if (severityNumber === undefined) {
    return "info";
  }
  if (severityNumber >= 21) {
    return "fatal";
  }
  if (severityNumber >= 17) {
    return "error";
  }
  if (severityNumber >= 13) {
    return "warn";
  }
  if (severityNumber >= 9) {
    return "info";
  }
  return "debug";
}

const UNSERIALIZABLE = "[unserializable log body]";

function toText(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  if (body === undefined || body === null) {
    return "";
  }
  // No String(body) fallback: a hostile toString would throw right back out of the catch.
  try {
    return JSON.stringify(body) ?? UNSERIALIZABLE;
  } catch {
    return UNSERIALIZABLE;
  }
}

function warn(where: string, error: unknown): void {
  process.stderr.write(`[jaytrace] processor ${where} failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
}
