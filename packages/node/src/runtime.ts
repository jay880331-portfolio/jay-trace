import { isSpanContextValid, trace } from "@opentelemetry/api";

import type { TraceBuffer } from "./trace-buffer.js";

export interface JayTraceStatus {
  /** True once env produced a real exporter (S3 or file). */
  configured: boolean;
  service?: string;
  droppedSpans: number;
  /** Documents thrown away because the exporter was still unconfigured when they were built. */
  droppedDocuments: number;
}

export interface JayTraceNodeRuntime {
  buffer: TraceBuffer;
  /** Re-reads env; returns whether an exporter is in place now. */
  start(): boolean;
  status(): JayTraceStatus;
}

const JAYTRACE_GLOBAL: unique symbol = Symbol.for("jaytrace.node");

// Lives on globalThis, not in module scope: a dual ESM/CJS load or two copies of the package
// under different node_modules paths must still see the one runtime that init actually booted.
const globalRef = globalThis as typeof globalThis & { [JAYTRACE_GLOBAL]?: JayTraceNodeRuntime };

/** The runtime `@jaytrace/node/init` installed, or undefined when init was never imported. */
export function getJayTraceRuntime(): JayTraceNodeRuntime | undefined {
  return globalRef[JAYTRACE_GLOBAL];
}

export function setJayTraceRuntime(runtime: JayTraceNodeRuntime): void {
  globalRef[JAYTRACE_GLOBAL] = runtime;
}

/**
 * Forces the lazy exporter to re-read env — call it right after secrets are injected
 * (the host app loads them after boot). Optional: every export retries on its own anyway.
 */
export function startJayTrace(): boolean {
  return getJayTraceRuntime()?.start() ?? false;
}

/**
 * W3C traceparent for the active span, for transports OTel does not instrument (Nest TCP):
 * put it in the RPC payload and `JayTraceRpcInterceptor` reopens it on the other side.
 * Undefined when no span is active. Never throws — callers sit on the request path.
 */
export function currentTraceparent(): string | undefined {
  try {
    const spanContext = trace.getActiveSpan()?.spanContext();
    // An all-zero (invalid) span context is what a non-recording/dropped span carries — sending it
    // downstream would only start a broken trace.
    if (!spanContext || !isSpanContextValid(spanContext)) {
      return undefined;
    }
    return `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags.toString(16).padStart(2, "0")}`;
  } catch {
    return undefined;
  }
}

export function getJayTraceStatus(): JayTraceStatus {
  return getJayTraceRuntime()?.status() ?? { configured: false, droppedSpans: 0, droppedDocuments: 0 };
}
