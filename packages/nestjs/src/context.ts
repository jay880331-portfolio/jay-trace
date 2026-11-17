import { Injectable } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";
import { trace, type Span } from "@opentelemetry/api";
import {
  createTraceparent,
  createTimelineEvent,
  createTimelineDocument,
  parseTraceparent,
  redact,
  type JayTraceError,
  type JayTraceSeverity,
  type JayTraceTimelineDocument,
  type TimelineEvent
} from "@jaytrace/core";

import type { JayTraceModuleOptions, JayTraceRequestContext } from "./types.js";

const storage = new AsyncLocalStorage<JayTraceRequestContext>();
const DEFAULT_SLOW_QUERY_THRESHOLD_MS = 300;

const JAYTRACE_NODE: unique symbol = Symbol.for("jaytrace.node");

/** The slice of the `@jaytrace/node` runtime this package delegates to — structural on purpose. */
interface JayTraceNodeBridge {
  buffer: {
    onLog(spanId: string | undefined, log: { atMs: number; severity: JayTraceSeverity; text: string }): void;
  };
}

const globalRef = globalThis as typeof globalThis & { [JAYTRACE_NODE]?: JayTraceNodeBridge };

/**
 * The runtime `@jaytrace/node/init` installed, or undefined when it was never imported.
 * Read per call: nothing guarantees init loads before this module.
 */
export function nodeRuntime(): JayTraceNodeBridge | undefined {
  const runtime = globalRef[JAYTRACE_NODE];
  return typeof runtime?.buffer?.onLog === "function" ? runtime : undefined;
}

/**
 * Active OTel span, but only in integrated mode — standalone stays free of any OTel lookup.
 * Never throws: callers sit on the request path.
 */
export function activeSpan(): Span | undefined {
  if (!nodeRuntime()) {
    return undefined;
  }

  try {
    return trace.getActiveSpan();
  } catch {
    return undefined;
  }
}

/**
 * `@jaytrace/node` is running, so the event belongs to whatever OTel span is active:
 * it goes to that buffer, which is the only thing that exports in integrated mode.
 */
function delegateLog(kind: TimelineEvent["kind"], text: string, severity?: JayTraceSeverity): void {
  const runtime = nodeRuntime();
  if (!runtime) {
    return;
  }

  try {
    runtime.buffer.onLog(activeSpan()?.spanContext().spanId, {
      atMs: Date.now(),
      severity: severity ?? "info",
      // The buffer's log shape has no kind field, so it rides along in the text.
      text: `[${kind}] ${text}`
    });
  } catch {
    // Telemetry never breaks the caller.
  }
}

const CONTEXT_PATCH_ATTRIBUTE = "jaytrace.context_patch";

/** Patch already on the span. SDK spans expose `attributes`; the API type does not, hence the cast. */
function readContextPatch(span: Span): Record<string, unknown> {
  const previous = (span as Partial<{ attributes: Record<string, unknown> }>).attributes?.[CONTEXT_PATCH_ATTRIBUTE];
  if (typeof previous !== "string") {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(previous);
    // Unparseable or non-object: the new patch simply replaces it.
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

@Injectable()
export class JayTraceContextService {
  run<T>(context: JayTraceRequestContext, callback: () => T): T {
    return storage.run(context, callback);
  }

  get(): JayTraceRequestContext | undefined {
    return storage.getStore();
  }

  addEvent(kind: TimelineEvent["kind"], text: string, severity?: TimelineEvent["severity"]): void {
    // Runtime first, context second: the middleware still opens a local context in integrated
    // mode, and events landing there would never be exported (the buffer owns that job).
    if (nodeRuntime()) {
      delegateLog(kind, text, severity);
      return;
    }

    const context = this.get();
    if (!context) {
      return;
    }

    context.events.push(
      createTimelineEvent({
        at: elapsed(context.startedAt),
        kind,
        severity,
        text
      })
    );
  }

  setContext(contextPatch: Record<string, unknown>): void {
    // Same bridge as the request/response bodies: in integrated mode the local context is never
    // exported, so the patch rides the root span and the node converter merges it back in.
    const span = nodeRuntime() ? activeSpan() : undefined;
    if (span) {
      try {
        span.setAttribute(CONTEXT_PATCH_ATTRIBUTE, JSON.stringify({ ...readContextPatch(span), ...contextPatch }));
        return;
      } catch {
        // Telemetry never breaks the caller — fall through to the local context.
      }
    }

    const context = this.get();
    if (!context) {
      return;
    }

    context.context = {
      ...context.context,
      ...contextPatch
    };
  }

  createBackDocument(options: JayTraceModuleOptions, error?: JayTraceError, statusCode?: number): JayTraceTimelineDocument | null {
    const context = this.get();
    if (!context) {
      return null;
    }

    const summary = error
      ? `${context.request?.method ?? "REQUEST"} ${context.request?.url ?? ""} failed: ${error.name} ${error.message}`.trim()
      : `${context.request?.method ?? "REQUEST"} ${context.request?.url ?? ""} completed`.trim();

    // error exports happen before the response "finish" listener fires, so backfill duration here
    const requestEvent = context.events.find((event) => event.kind === "request");
    if (requestEvent && requestEvent.durationMs === undefined) {
      const durationMs = Math.max(0, Date.now() - context.startedAt.getTime());
      requestEvent.durationMs = durationMs;
      if (durationMs > (options.slowRequestThresholdMs ?? 3000)) {
        requestEvent.slow = true;
      }
    }

    return createTimelineDocument({
      service: options.service ?? "api",
      side: "back",
      traceId: context.traceId,
      sessionId: context.sessionId,
      spanId: context.spanId,
      traceparent: context.traceparent,
      startedAt: context.startedAt,
      endedAt: new Date(),
      summary,
      events: context.events,
      context: {
        ...context.context,
        environment: options.environment,
        release: options.release,
        route: context.request?.url,
        method: context.request?.method,
        statusCode
      },
      error
    });
  }

  claimBackExport(): boolean {
    const context = this.get();
    if (!context) {
      return true;
    }
    if (context.backExported) {
      return false;
    }
    context.backExported = true;
    return true;
  }
}

// TypeORM logger: logQuery(query, params) { recordQuery(query, { params }); }
// Prisma: prisma.$on("query", event => recordQuery(event.query, { params: event.params, durationMs: event.duration }));
export function recordQuery(query: string, options: { params?: unknown; durationMs?: number } = {}): void {
  const context = storage.getStore();
  if (!context) {
    return;
  }

  const event = createTimelineEvent({
    at: elapsed(context.startedAt),
    kind: "db",
    text: query
  });
  if (options.params !== undefined) {
    event.data = { params: redact(options.params) };
  }
  if (options.durationMs !== undefined) {
    event.durationMs = options.durationMs;
    if (options.durationMs > (context.slowQueryThresholdMs ?? DEFAULT_SLOW_QUERY_THRESHOLD_MS)) {
      event.slow = true;
    }
  }
  context.events.push(event);
}

export function createRequestContext(
  traceparentHeader: string | undefined,
  method?: string,
  url?: string,
  options: Pick<JayTraceModuleOptions, "slowQueryThresholdMs"> = {},
  sessionId?: string
): JayTraceRequestContext {
  const parsed = parseTraceparent(traceparentHeader);
  const created = parsed ?? createTraceparent();

  return {
    traceId: created.traceId,
    spanId: created.spanId,
    traceparent: created.value,
    sessionId,
    startedAt: new Date(),
    slowQueryThresholdMs: options.slowQueryThresholdMs ?? DEFAULT_SLOW_QUERY_THRESHOLD_MS,
    events: [
      createTimelineEvent({
        at: "0.000s",
        kind: "request",
        severity: "info",
        text: `request ${method ?? "UNKNOWN"} ${url ?? "/"}`
      })
    ],
    request: {
      method,
      url
    }
  };
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Reads and validates the `x-jaytrace-session` request header. The value is
 * stamped onto stored documents, so a malformed/hostile header is dropped
 * (returns undefined) rather than persisted.
 */
export function readSessionHeader(headers: Record<string, string | string[] | undefined> | undefined): string | undefined {
  const raw = headers?.["x-jaytrace-session"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && SESSION_ID_PATTERN.test(value) ? value : undefined;
}

function elapsed(startedAt: Date): string {
  const ms = Math.max(0, Date.now() - startedAt.getTime());
  return `${(ms / 1000).toFixed(3)}s`;
}
