import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject } from "@nestjs/common";
import { redact, type JayTraceError } from "@jaytrace/core";

import { JayTraceContextService, activeSpan, nodeRuntime } from "./context.js";
import { JAYTRACE_EXPORTER, JAYTRACE_OPTIONS } from "./tokens.js";
import type { HttpLikeResponse, JayTraceExporter, JayTraceModuleOptions } from "./types.js";

@Catch()
export class JayTraceExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly context: JayTraceContextService,
    @Inject(JAYTRACE_OPTIONS) private readonly options: JayTraceModuleOptions,
    @Inject(JAYTRACE_EXPORTER) private readonly exporter: JayTraceExporter
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<HttpLikeResponse & { json?: (body: unknown) => void; send?: (body: unknown) => void }>();
    const statusCode = exception instanceof HttpException ? exception.getStatus() : 500;
    const error = toJayTraceError(exception);

    // Integrated mode: the exported document carries the OTel trace id, so the id handed to
    // the client has to be that one or console lookups miss.
    let traceId = spanTraceId() ?? this.context.get()?.traceId;
    // Integrated mode: the node span processor is the single export path for this request.
    const document = statusCode >= 500 && !nodeRuntime() ? this.createErrorDocument(error, statusCode) : null;
    traceId = document?.traceId ?? traceId;
    if (document && this.context.claimBackExport()) {
      this.exporter.export({ side: "back", document });
    }

    if (response && typeof response.statusCode === "number") {
      response.statusCode = statusCode;
    }

    const body = redact({
      statusCode,
      message: statusCode >= 500 ? "Internal server error" : error.message,
      traceId
    });

    if (response?.json) {
      response.json(body);
      return;
    }

    response?.send?.(body);
  }

  private createErrorDocument(error: JayTraceError, statusCode: number) {
    this.context.addEvent("error", `${error.name} ${error.message}`, "error");
    return this.context.createBackDocument(this.options, error, statusCode);
  }
}

function spanTraceId(): string | undefined {
  try {
    return activeSpan()?.spanContext().traceId;
  } catch {
    return undefined;
  }
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
