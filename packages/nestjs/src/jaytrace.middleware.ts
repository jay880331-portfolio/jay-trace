import { Inject, Injectable, NestMiddleware } from "@nestjs/common";
import type { Span } from "@opentelemetry/api";
import { redact, type TimelineEvent } from "@jaytrace/core";

import { JayTraceContextService, activeSpan, createRequestContext, readSessionHeader } from "./context.js";
import { JAYTRACE_OPTIONS } from "./tokens.js";
import type { HttpLikeRequest, HttpLikeResponse, JayTraceModuleOptions } from "./types.js";

const DEFAULT_BODY_MAX_BYTES = 8192;
const DEFAULT_SLOW_REQUEST_THRESHOLD_MS = 3000;

@Injectable()
export class JayTraceMiddleware implements NestMiddleware {
  constructor(
    private readonly context: JayTraceContextService,
    @Inject(JAYTRACE_OPTIONS) private readonly options: JayTraceModuleOptions
  ) {}

  use(request: HttpLikeRequest, response: HttpLikeResponse, next: () => void): void {
    const traceparent = firstHeader(request.headers?.traceparent);
    const url = request.originalUrl ?? request.url ?? "/";
    const sessionId = readSessionHeader(request.headers);
    const context = createRequestContext(traceparent, request.method, url, this.options, sessionId);
    const requestEvent = context.events[0];

    // Integrated mode: the node span processor exports the document, so anything only this
    // middleware knows has to travel on the root span. Captured here, while the SERVER span
    // is still the active one — the response hooks fire under a deeper span.
    const span = activeSpan();
    setSpanAttribute(span, "jaytrace.session_id", sessionId);

    if (requestEvent && this.options.captureBody) {
      const maxBytes = bodyMaxBytes(this.options.captureBody);
      attachCapturedBody(requestEvent, "requestBody", request.body, maxBytes);
      // Guarded: bodyAttribute redacts a second copy, which is pure waste in standalone mode.
      if (span) {
        setSpanAttribute(span, "jaytrace.request_body", bodyAttribute(request.body, maxBytes));
      }
      hookResponseBody(response, (body) => {
        attachCapturedBody(requestEvent, "responseBody", body, maxBytes);
        if (span) {
          setSpanAttribute(span, "jaytrace.response_body", bodyAttribute(body, maxBytes));
        }
      });
    }

    const finish = () => {
      if (!requestEvent) {
        return;
      }
      const durationMs = Math.max(0, Date.now() - context.startedAt.getTime());
      requestEvent.durationMs = durationMs;
      if (durationMs > (this.options.slowRequestThresholdMs ?? DEFAULT_SLOW_REQUEST_THRESHOLD_MS)) {
        requestEvent.slow = true;
      }
    };
    if (response.once) {
      response.once("finish", finish);
    } else {
      response.on?.("finish", finish);
    }

    // Integrated mode exports under the OTel trace id, so the header has to echo that one —
    // otherwise the front document and the back document never join.
    response.setHeader?.("traceparent", spanTraceparent(span) ?? context.traceparent);
    this.context.run(context, next);
  }
}

function hookResponseBody(response: HttpLikeResponse, onBody: (body: unknown) => void): void {
  let captured = false;
  const capture = (body: unknown) => {
    if (captured) {
      return;
    }
    captured = true;
    onBody(body);
  };

  const json = response.json;
  if (json) {
    response.json = function (this: HttpLikeResponse, body: unknown): unknown {
      capture(body);
      return json.call(this, body);
    };
  }

  const send = response.send;
  if (send) {
    response.send = function (this: HttpLikeResponse, body: unknown): unknown {
      capture(body);
      return send.call(this, body);
    };
  }
}

function attachCapturedBody(
  event: TimelineEvent,
  key: "requestBody" | "responseBody",
  body: unknown,
  maxBytes: number
): void {
  const captured = captureBody(body, maxBytes);
  if (captured === undefined) {
    return;
  }
  event.data = { ...event.data, [key]: captured };
}

function captureBody(body: unknown, maxBytes: number): unknown {
  if (body === undefined) {
    return undefined;
  }

  try {
    return truncateBody(redact(body), maxBytes);
  } catch {
    return "[unserializable]";
  }
}

/** Same captured body, flattened to what a span attribute can hold. */
export function bodyAttribute(body: unknown, maxBytes: number): string | undefined {
  const captured = captureBody(body, maxBytes);
  if (captured === undefined) {
    return undefined;
  }
  if (typeof captured === "string") {
    return captured;
  }

  try {
    return JSON.stringify(captured) ?? undefined;
  } catch {
    return "[unserializable]";
  }
}

/** W3C traceparent of an OTel span. */
function spanTraceparent(span: Span | undefined): string | undefined {
  if (!span) {
    return undefined;
  }

  try {
    const { traceId, spanId, traceFlags } = span.spanContext();
    return `00-${traceId}-${spanId}-${traceFlags.toString(16).padStart(2, "0")}`;
  } catch {
    return undefined;
  }
}

function setSpanAttribute(span: Span | undefined, key: string, value: string | undefined): void {
  if (!span || value === undefined) {
    return;
  }

  try {
    span.setAttribute(key, value);
  } catch {
    // Telemetry never breaks the request.
  }
}

function truncateBody(value: unknown, maxBytes: number): unknown {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) <= maxBytes) {
    return value;
  }

  return Buffer.from(serialized)
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "") + "[truncated]";
}

function bodyMaxBytes(captureBody: true | { maxBytes?: number }): number {
  const configured = typeof captureBody === "object" ? captureBody.maxBytes : undefined;
  return typeof configured === "number" && Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : DEFAULT_BODY_MAX_BYTES;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
