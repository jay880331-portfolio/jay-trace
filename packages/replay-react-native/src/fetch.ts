import { createChildTraceparent, redact } from "@jaytrace/core";
import type { ReactNativeReplayClient } from "./types.js";

const DEFAULT_CAPTURE_BODY_BYTES = 8192;

export interface JayTraceFetchOptions {
  traceparent?: string;
  traceOrigins?: string[];
  fetch?: typeof fetch;
  now?: () => number;
  /** Capture request/response bodies (off by default). JSON/text/form-urlencoded only. */
  captureBody?: boolean | { maxBytes?: number };
  /** Redaction applied to captured bodies before they reach the replay buffer. */
  redaction?: { enabled?: boolean; sensitiveKeys?: string[] };
  /** Active-session getter — stamps `x-jaytrace-session` alongside the traceparent so the backend inherits the session. */
  getSessionId?: () => string;
}

export function createJayTraceFetch(
  client: ReactNativeReplayClient | null,
  options: JayTraceFetchOptions = {}
): typeof fetch {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("JayTrace fetch wrapper requires fetch");
  }
  const now = options.now ?? (() => Date.now());
  const captureBodyOpt = options.captureBody;
  const maxBytes = typeof captureBodyOpt === "object" ? (captureBodyOpt.maxBytes ?? DEFAULT_CAPTURE_BODY_BYTES) : DEFAULT_CAPTURE_BODY_BYTES;

  return async (input, init) => {
    // SDK bookkeeping (trace-header injection, timing) must never stop the real
    // request from running: if any of it throws, fall back to the untouched init.
    let startedAt = 0;
    let shouldRecord = false;
    let nextInit = init;
    try {
      startedAt = now();
      shouldRecord = shouldTrace(input, options.traceOrigins);
      // A fresh child span per request (parity with the browser SDK): the root is
      // options.traceparent, and each request injects a new child so distinct
      // requests carry distinct spanIds.
      nextInit = withTraceparent(input, init, options.traceparent, options.traceOrigins, options.getSessionId);
    } catch {
      startedAt = 0;
      shouldRecord = false;
      nextInit = init;
    }

    let requestBody: unknown;
    if (captureBodyOpt && shouldRecord) {
      try {
        // A Request input must be cloned (constructing a new Request from it would
        // disturb the body the real fetch still needs); a string/URL input carries
        // its re-readable body on nextInit, so build a throwaway Request to probe.
        const probe = input instanceof Request ? input.clone() : new Request(input as RequestInfo, nextInit);
        const bodyText = await captureBodyText(probe, maxBytes);
        if (bodyText) {
          requestBody = parseIfJson(bodyText);
        }
      } catch {
        // isolation: body capture must never break the real request
      }
    }

    try {
      const response = await fetchImpl(input, nextInit);
      // Recording is isolated so a throw here can't turn a real response into a
      // rejection.
      try {
        if (shouldRecord) {
          let responseBody: unknown;
          if (captureBodyOpt) {
            try {
              const bodyText = await captureBodyText(response.clone(), maxBytes);
              if (bodyText) {
                responseBody = parseIfJson(bodyText);
              }
            } catch {
              // isolation
            }
          }
          void client?.recordNetwork({
            method: methodOf(input, nextInit),
            url: urlOf(input),
            status: response.status,
            durationMs: now() - startedAt,
            ...capturedBodies(captureBodyOpt, requestBody, responseBody, options.redaction)
          }).catch(() => undefined);
        }
      } catch {
      }
      return response;
    } catch (error) {
      try {
        if (shouldRecord) {
          void client?.recordNetwork({
            method: methodOf(input, nextInit),
            url: urlOf(input),
            durationMs: now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
            ...capturedBodies(captureBodyOpt, requestBody, undefined, options.redaction)
          }).catch(() => undefined);
        }
      } catch {
      }
      throw error; // pass the user's fetch rejection through untouched
    }
  };
}

function capturedBodies(
  captureBodyOpt: boolean | { maxBytes?: number } | undefined,
  requestBody: unknown,
  responseBody: unknown,
  redaction: { enabled?: boolean; sensitiveKeys?: string[] } | undefined
): { requestBody?: unknown; responseBody?: unknown } {
  if (!captureBodyOpt || (requestBody === undefined && responseBody === undefined)) {
    return {};
  }
  const data = redact({ requestBody, responseBody }, redaction);
  const out: { requestBody?: unknown; responseBody?: unknown } = {};
  if (requestBody !== undefined) {
    out.requestBody = data.requestBody;
  }
  if (responseBody !== undefined) {
    out.responseBody = data.responseBody;
  }
  return out;
}

function shouldCaptureBody(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }
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
  if (text === "[unsupported]") {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function withTraceparent(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  traceparent: string | undefined,
  traceOrigins: string[] | undefined,
  getSessionId: (() => string) | undefined
): RequestInit | undefined {
  if (!traceparent || !shouldTrace(input, traceOrigins)) {
    return init;
  }
  return {
    ...init,
    headers: {
      ...(input instanceof Request ? headersObject(input.headers) : {}),
      ...headersObject(init?.headers),
      traceparent: createChildTraceparent(traceparent).value,
      // Same gate as traceparent: the backend inherits the RUM session from this header.
      ...(getSessionId ? { "x-jaytrace-session": getSessionId() } : {})
    }
  };
}

function shouldTrace(input: RequestInfo | URL, traceOrigins: string[] | undefined): boolean {
  if (!traceOrigins?.length) {
    return true;
  }
  try {
    return traceOrigins.map(origin => origin.replace(/\/$/, "")).includes(new URL(urlOf(input)).origin);
  } catch {
    return false;
  }
}

export function headersObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers;
}

function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  return init?.method ?? (input instanceof Request ? input.method : "GET");
}

function urlOf(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}
