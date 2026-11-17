import { CallHandler, ExecutionContext, HttpException, Inject, Injectable, NestInterceptor } from "@nestjs/common";
import { defer, Observable, tap } from "rxjs";

import { createRequestContext, JayTraceContextService, nodeRuntime, readSessionHeader } from "./context.js";
import { JAYTRACE_EXPORTER, JAYTRACE_OPTIONS } from "./tokens.js";
import type { JayTraceError } from "@jaytrace/core";
import type { HttpLikeRequest, HttpLikeResponse, JayTraceExporter, JayTraceModuleOptions } from "./types.js";

@Injectable()
export class JayTraceInterceptor implements NestInterceptor {
  constructor(
    private readonly context: JayTraceContextService,
    @Inject(JAYTRACE_OPTIONS) private readonly options: JayTraceModuleOptions,
    @Inject(JAYTRACE_EXPORTER) private readonly exporter: JayTraceExporter
  ) {}

  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = executionContext.switchToHttp();
    const request = http.getRequest<HttpLikeRequest>();
    const response = http.getResponse<HttpLikeResponse>();
    const source = this.context.get()
      ? next.handle()
      : defer(() =>
          this.context.run(
            createRequestContext(getTraceparent(request.headers), request.method, request.originalUrl ?? request.url, this.options, readSessionHeader(request.headers)),
            () => next.handle()
          )
        );

    return source.pipe(
      tap({
        next: () => {
          const statusCode = response.statusCode ?? 200;
          this.context.addEvent("request", `response ${statusCode}`, statusCode >= 500 ? "error" : "info");
          // Integrated mode: the node span processor already exports this request.
          if (statusCode >= 500 && !nodeRuntime()) {
            const document = this.context.createBackDocument(this.options, undefined, statusCode);
            if (document && this.context.claimBackExport()) {
              this.exporter.export({ side: "back", document });
            }
          }
        },
        error: (exception: unknown) => {
          // Non-HttpException errors become 500 responses, but the exception filter has not
          // run yet here, so response.statusCode still holds the pre-error default.
          const statusCode = exception instanceof HttpException ? exception.getStatus() : 500;
          if (statusCode < 500 || nodeRuntime()) {
            return;
          }
          const error = toJayTraceError(exception);
          const document = this.createErrorDocument(request, error, statusCode);
          if (document && this.context.claimBackExport()) {
            this.exporter.export({ side: "back", document });
          }
        }
      })
    );
  }

  private createErrorDocument(request: HttpLikeRequest, error: JayTraceError, statusCode: number) {
    this.context.addEvent("error", `${error.name} ${error.message}`, "error");
    const existing = this.context.createBackDocument(this.options, error, statusCode);
    if (existing) {
      return existing;
    }

    return this.context.run(
      createRequestContext(getTraceparent(request.headers), request.method, request.originalUrl ?? request.url, this.options, readSessionHeader(request.headers)),
      () => {
        this.context.addEvent("error", `${error.name} ${error.message}`, "error");
        return this.context.createBackDocument(this.options, error, statusCode);
      }
    );
  }
}

function getTraceparent(headers: HttpLikeRequest["headers"]): string | undefined {
  const value = headers?.traceparent;
  return Array.isArray(value) ? value[0] : value;
}

function toJayTraceError(exception: unknown): JayTraceError {
  if (exception instanceof Error) {
    const maybeCode = "code" in exception ? String(exception.code) : undefined;
    return {
      name: exception.name,
      message: exception.message,
      stack: exception.stack,
      code: maybeCode
    };
  }

  return {
    name: "UnknownError",
    message: String(exception)
  };
}
