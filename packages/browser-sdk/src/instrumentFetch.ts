import { createChildTraceparent, redact, type Traceparent } from "@jaytrace/core";

export interface FetchInstrumentation {
  restore(): void;
}

export interface InstrumentFetchOptions {
  rootTraceparent: Traceparent;
  traceOrigins?: string[];
  addTimeline: (text: string, severity?: "error" | "warn" | "info", data?: Record<string, unknown>) => void;
  getSessionId?: () => string;
  captureBody?: boolean | { maxBytes?: number };
  redaction?: { enabled?: boolean; sensitiveKeys?: string[] };
}

const JAYTRACE_INTERNAL_HEADER = "x-jaytrace-internal";
const JAYTRACE_SESSION_HEADER = "x-jaytrace-session";

export function instrumentFetch(options: InstrumentFetchOptions): FetchInstrumentation {
  const originalFetch = globalThis.fetch;
  if (!originalFetch) {
    return { restore: () => undefined };
  }

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // A bug in our bookkeeping must never break the host's request. If we cannot
    // even build the traced request, fall back to the untouched original call.
    let request: Request;
    try {
      request = buildRequest(input, init, options.rootTraceparent, options.traceOrigins ?? [], options.getSessionId);
    } catch {
      return originalFetch(input as RequestInfo, init);
    }
    const startedAt = Date.now();
    let requestData: Record<string, unknown> | undefined;
    const captureBodyOpt = options.captureBody;
    const maxBytes = typeof captureBodyOpt === "object" ? (captureBodyOpt.maxBytes ?? 8192) : 8192;

    if (captureBodyOpt) {
      try {
        const bodyText = await captureBodyText(request.clone(), maxBytes);
        if (bodyText) {
          requestData = { requestBody: parseIfJson(bodyText) };
        }
      } catch {
        // isolation
      }
    }

    try {
      const response = await originalFetch(request);
      if (request.headers.get(JAYTRACE_INTERNAL_HEADER) !== "1") {
        // Isolate the timeline write: the real response must pass through even if it throws.
        try {
          let data = requestData;
          if (captureBodyOpt) {
            const bodyText = await captureBodyText(response.clone(), maxBytes);
            if (bodyText) {
              data = { ...data, responseBody: parseIfJson(bodyText) };
            }
          }
          if (data) {
            data = redact(data, options.redaction) as Record<string, unknown>;
          }
          options.addTimeline(
            `fetch ${request.method} ${safeUrl(request.url)} status=${response.status} durationMs=${Date.now() - startedAt}`,
            response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
            data
          );
        } catch {
          // isolation
        }
      }
      return response;
    } catch (error) {
      if (request.headers.get(JAYTRACE_INTERNAL_HEADER) !== "1") {
        // Isolate bookkeeping so it never masks/replaces the host's real fetch error.
        try {
          let data = requestData;
          if (data) {
            data = redact(data, options.redaction) as Record<string, unknown>;
          }
          options.addTimeline(
            `fetch ${request.method} ${safeUrl(request.url)} failed durationMs=${Date.now() - startedAt} error=${errorName(error)}`,
            "error",
            data
          );
        } catch {
          // isolation
        }
      }
      throw error;
    }
  };

  return {
    restore() {
      globalThis.fetch = originalFetch;
    }
  };
}

export function markInternalRequest(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set(JAYTRACE_INTERNAL_HEADER, "1");
  return {
    ...init,
    headers
  };
}

function buildRequest(input: RequestInfo | URL, init: RequestInit | undefined, rootTraceparent: Traceparent, traceOrigins: string[], getSessionId?: () => string): Request {
  const request = new Request(input, init);
  const headers = new Headers(request.headers);

  if (!headers.has("traceparent") && shouldTrace(request.url, traceOrigins)) {
    headers.set("traceparent", createChildTraceparent(rootTraceparent).value);
    const sessionId = getSessionId?.();
    if (sessionId) {
      headers.set(JAYTRACE_SESSION_HEADER, sessionId);
    }
  }

  return new Request(request, { headers });
}

function shouldTrace(value: string, traceOrigins: string[]): boolean {
  try {
    const url = new URL(value, globalThis.location?.href);
    return url.origin === globalThis.location?.origin || traceOrigins.map(origin => origin.replace(/\/$/, "")).includes(url.origin);
  } catch {
    return false;
  }
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value, globalThis.location?.href);
    return `${url.origin === globalThis.location?.origin ? "" : url.origin}${url.pathname}`;
  } catch {
    return value.split("?")[0] ?? value;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function shouldCaptureBody(contentType: string | null): boolean {
  if (!contentType) return false;
  const mime = contentType.toLowerCase();
  return mime.includes("application/json") || mime.includes("text/") || mime.includes("application/x-www-form-urlencoded");
}

async function captureBodyText(cloned: Request | Response, maxBytes: number): Promise<string> {
  const contentType = cloned.headers.get("content-type");
  if (!shouldCaptureBody(contentType)) {
    return "[unsupported]";
  }
  try {
    const text = await cloned.text();
    if (text.length > maxBytes) {
      return text.slice(0, maxBytes) + "[truncated]";
    }
    return text;
  } catch {
    return "[unsupported]";
  }
}

function parseIfJson(text: string): unknown {
  if (text === "[unsupported]") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
