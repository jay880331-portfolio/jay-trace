import { createChildTraceparent, redact, type Traceparent } from "@jaytrace/core";

export interface XhrInstrumentation {
  restore(): void;
}

export interface InstrumentXhrOptions {
  rootTraceparent: Traceparent;
  traceOrigins?: string[];
  addTimeline: (text: string, severity?: "error" | "warn" | "info", data?: Record<string, unknown>) => void;
  getSessionId?: () => string;
  now?: () => number;
  captureBody?: boolean | { maxBytes?: number };
  redaction?: { enabled?: boolean; sensitiveKeys?: string[] };
}

type XhrState = {
  method: string;
  url: string;
  startedAt: number;
  traceHeaderSet: boolean;
};

const states = new WeakMap<XMLHttpRequest, XhrState>();

export function instrumentXhr(options: InstrumentXhrOptions): XhrInstrumentation {
  const ctor = globalThis.XMLHttpRequest;
  if (!ctor?.prototype) {
    return { restore: () => undefined };
  }

  const now = options.now ?? (() => Date.now());
  const originalOpen = ctor.prototype.open;
  const originalSend = ctor.prototype.send;
  const originalSetRequestHeader = ctor.prototype.setRequestHeader;

  ctor.prototype.open = function open(this: XMLHttpRequest, method: string, url: string | URL) {
    try {
      states.set(this, {
        method: method.toUpperCase(),
        url: String(url),
        startedAt: 0,
        traceHeaderSet: false
      });
    } catch {
      // isolation: bookkeeping must never block the host's real xhr.open
    }
    return originalOpen.apply(this, arguments as unknown as Parameters<XMLHttpRequest["open"]>);
  };

  ctor.prototype.setRequestHeader = function setRequestHeader(this: XMLHttpRequest, name: string, value: string) {
    if (name.toLowerCase() === "traceparent") {
      const state = states.get(this);
      if (state) {
        state.traceHeaderSet = true;
      }
    }
    return originalSetRequestHeader.call(this, name, value);
  };

  ctor.prototype.send = function send(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    let requestData: Record<string, unknown> | undefined;
    const captureBodyOpt = options.captureBody;
    const maxBytes = typeof captureBodyOpt === "object" ? (captureBodyOpt.maxBytes ?? 8192) : 8192;

    try {
      if (captureBodyOpt && body) {
        if (typeof body === "string") {
          requestData = { requestBody: parseIfJson(body.length > maxBytes ? body.slice(0, maxBytes) + "[truncated]" : body) };
        } else {
          requestData = { requestBody: "[unsupported]" };
        }
      }
    } catch {
      // isolation
    }

    // All bookkeeping (timing, trace-header injection, listener wiring) is isolated
    // so a bug here never prevents the host's real xhr.send from running.
    try {
      const state = states.get(this);
      if (state) {
        state.startedAt = now();
        if (!state.traceHeaderSet && shouldTrace(state.url, options.traceOrigins ?? [])) {
          originalSetRequestHeader.call(this, "traceparent", createChildTraceparent(options.rootTraceparent).value);
          const sessionId = options.getSessionId?.();
          if (sessionId) {
            originalSetRequestHeader.call(this, "x-jaytrace-session", sessionId);
          }
        }
        let finished = false;
        const finish = (kind: "loadend" | "error" | "abort") => {
          try {
            if (finished) {
              return;
            }
            finished = true;
            const status = typeof this.status === "number" ? this.status : 0;
            const severity = kind !== "loadend" || status >= 500 ? "error" : status >= 400 ? "warn" : "info";
            const suffix = kind === "loadend" ? "" : ` ${kind}`;

            let data = requestData;
            if (captureBodyOpt && kind === "loadend") {
              const contentType = this.getResponseHeader("content-type");
              if (shouldCaptureBody(contentType)) {
                let text: string | null = null;
                if (this.responseType === "" || this.responseType === "text") {
                  text = this.responseText;
                } else if (this.responseType === "json" && this.response) {
                  text = typeof this.response === "string" ? this.response : JSON.stringify(this.response);
                }
                
                if (text) {
                  if (text.length > maxBytes) {
                    text = text.slice(0, maxBytes) + "[truncated]";
                  }
                  data = { ...data, responseBody: parseIfJson(text) };
                } else {
                  data = { ...data, responseBody: "[unsupported]" };
                }
              } else if (contentType) {
                data = { ...data, responseBody: "[unsupported]" };
              }
            }

            if (data) {
              data = redact(data, options.redaction) as Record<string, unknown>;
            }

            options.addTimeline(
              `xhr ${state.method} ${safeUrl(state.url)} status=${status} durationMs=${Math.max(0, now() - state.startedAt)}${suffix}`,
              severity,
              data
            );
          } catch {
            // isolation: xhr event listeners run on the host loop
          }
        };
        this.addEventListener("loadend", () => finish("loadend"), { once: true });
        this.addEventListener("error", () => finish("error"), { once: true });
        this.addEventListener("abort", () => finish("abort"), { once: true });
      }
    } catch {
      // isolation
    }
    return originalSend.call(this, body);
  };

  return {
    restore() {
      ctor.prototype.open = originalOpen;
      ctor.prototype.send = originalSend;
      ctor.prototype.setRequestHeader = originalSetRequestHeader;
    }
  };
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value, globalThis.location?.href);
    return `${url.origin === globalThis.location?.origin ? "" : url.origin}${url.pathname}`;
  } catch {
    return value.split("?")[0] ?? value;
  }
}

function shouldTrace(value: string, traceOrigins: string[]): boolean {
  try {
    const url = new URL(value, globalThis.location?.href);
    return url.origin === globalThis.location?.origin || traceOrigins.map(origin => origin.replace(/\/$/, "")).includes(url.origin);
  } catch {
    return false;
  }
}

function shouldCaptureBody(contentType: string | null): boolean {
  if (!contentType) return false;
  const mime = contentType.toLowerCase();
  return mime.includes("application/json") || mime.includes("text/") || mime.includes("application/x-www-form-urlencoded");
}

function parseIfJson(text: string): unknown {
  if (text === "[unsupported]") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
