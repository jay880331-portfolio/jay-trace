import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context as otelContext, propagation, trace, type Span } from "@opentelemetry/api";
import { finalize, Observable, tap } from "rxjs";

import { nodeRuntime } from "./context.js";

const MAX_PATTERN_LENGTH = 120;

/**
 * Payload-based trace propagation for transports OTel does not instrument (Nest TCP, Redis,
 * custom). The caller puts a `traceparent` field in the message payload — `currentTraceparent()`
 * from `@jaytrace/node` builds it — and this interceptor reopens it as a remote parent, so the
 * consumer span is a root for TraceBuffer and produces a back document.
 *
 * Register it app-wide: `app.useGlobalInterceptors(new JayTraceRpcInterceptor())` or APP_INTERCEPTOR.
 */
@Injectable()
export class JayTraceRpcInterceptor implements NestInterceptor {
  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Standalone mode has no span processor, so a span here would export nowhere.
    if (executionContext.getType() !== "rpc" || !nodeRuntime()) {
      return next.handle();
    }

    let span: Span | undefined;
    try {
      const rpc = executionContext.switchToRpc();
      const data = rpc.getData<{ traceparent?: unknown } | undefined>();
      const traceparent = typeof data?.traceparent === "string" ? data.traceparent : undefined;
      // No traceparent: still worth a span — it just starts its own trace.
      const parent = traceparent ? propagation.extract(ROOT_CONTEXT, { traceparent }) : ROOT_CONTEXT;

      span = trace.getTracer("@jaytrace/nestjs").startSpan(`MSG ${readPattern(executionContext)}`, { kind: SpanKind.CONSUMER }, parent);
      const active = span;

      // Nest's `handle()` is AsyncResource-bound at call time, so the handler and everything it
      // awaits run under this context — addEvent/console/DB spans land beneath the consumer span.
      return otelContext.with(trace.setSpan(parent, active), () => next.handle()).pipe(
        tap({
          error: (exception: unknown) => {
            active.recordException(exception instanceof Error ? exception : String(exception));
            active.setStatus({
              code: SpanStatusCode.ERROR,
              message: exception instanceof Error ? exception.message : String(exception)
            });
          }
        }),
        finalize(() => active.end())
      );
    } catch {
      // The bridge never breaks the message: fall through, but do not leak a half-open span.
      span?.end();
      return next.handle();
    }
  }
}

/** RMQ/TCP contexts expose `getPattern()`; anything else falls back to the handler name. */
function readPattern(executionContext: ExecutionContext): string {
  const rpcContext = executionContext.switchToRpc().getContext<{ getPattern?: () => unknown } | undefined>();
  const pattern = typeof rpcContext?.getPattern === "function" ? rpcContext.getPattern() : executionContext.getHandler().name;
  return stringifyPattern(pattern).slice(0, MAX_PATTERN_LENGTH);
}

/** `@MessagePattern({ cmd: "sum" })` hands back an object — String() would flatten it to [object Object]. */
function stringifyPattern(pattern: unknown): string {
  if (typeof pattern === "string") {
    return pattern;
  }

  try {
    return JSON.stringify(pattern) ?? "unknown";
  } catch {
    return "unknown";
  }
}
