import {
  createChildTraceparent,
  createTimelineDocument,
  createTimelineEvent,
  createTraceparent,
  parseTraceparent,
  redact,
  summarizeTimeline,
  type TimelineEvent,
  type Traceparent
} from "@jaytrace/core";

// Runtime absence of `process` is handled by readEnv's try/catch.
declare const process:
  | {
      env?: Record<string, string | undefined>;
    }
  | undefined;

const INSTANCE_ID = Math.random().toString(36).slice(2, 8);
const ssrDebug = (...args: unknown[]): void => {
  if (process?.env?.JAYTRACE_SSR_DEBUG === "1") {
    console.log(`[jaytrace-ssr:${INSTANCE_ID}]`, ...args);
  }
};

/**
 * Next.js server-side fetch instrumentation with a "render window" request
 * correlation strategy.
 *
 * A Next app loads `@jaytrace/browser/next/server` as two distinct module
 * instances: one from `instrumentation.ts` register() (owns the fetch patch and
 * the buffers) and one from the RSC bundle that renders the root layout (calls
 * getJayTraceSSRTraceparent). Module-scope state is not shared between them, so
 * the single source of truth lives on globalThis under a well-known Symbol —
 * both instances read/write the same object, and `globalThis` Symbol.for
 * registries are shared across instances even though `react` / `next/headers`
 * copies are not.
 *
 * The correlation approach is "first-toucher mints": whoever touches the render
 * root first in a given render — the root layout's getJayTraceSSRTraceparent()
 * or the first server fetch (RSC prefetch in a nested layout, route handler, ...)
 * — mints a fresh root and opens a short "render window" on the shared state.
 * Everyone else in that window reuses it. This is deliberate: in a real Next
 * render a nested layout's SSR fetch often runs BEFORE the root layout's getter,
 * so the getter cannot be assumed to mint first. With first-toucher minting the
 * getter and the fetches converge on one root regardless of execution order, so
 * the request's meta traceparent and its SSR fetch events land on one trace.
 * This replaces an earlier react.cache()-based request scope: react's cache()
 * does not memoize across the two webpack module instances, so it fragmented
 * every SSR fetch into its own single-event trace.
 *
 * LIMITATION: the render window is process-wide, not truly request-scoped.
 * Different requests / background fetches that overlap within the window
 * (default 5s) can be attributed to the same trace. This is acceptable for
 * local / low-concurrency QA, which is the intended target. High-concurrency
 * production SSR tracing needs an integration with a real request-scoped API
 * (AsyncLocalStorage or a framework request context).
 */

export interface RegisterJayTraceNextOptions {
  captureBody?: boolean | { maxBytes?: number };
  service?: string;
  endpoint?: string;
  apiKey?: string;
  enabled?: boolean;
  /** test-only hook: shorten the per-trace flush debounce window (ms). */
  flushDebounceMs?: number;
  /** test-only hook: shorten the render window opened by getJayTraceSSRTraceparent (ms). */
  renderWindowMs?: number;
}

const STATE = Symbol.for("jaytrace.next.ssr.state");
const INTERNAL_HEADER = "x-jaytrace-internal";
const DEFAULT_DEBOUNCE_MS = 3000;
const MAX_BATCH_EVENTS = 100;
const DEFAULT_BODY_MAX_BYTES = 8192;
// How long a render window stays open after the first toucher (getter or fetch)
// mints its root. Long enough to cover a single render's nested SSR fetches,
// short enough that a later unrelated fetch does not adopt a stale root.
const RENDER_WINDOW_MS = 5000;

// The single cross-instance state object, shared by every module instance that
// loads this file in the process (see the STATE symbol note above).
interface SsrState {
  // The current render window: the root minted by the first toucher (the
  // getter or the first server fetch) and when it stops applying. Anything that
  // touches the root while `expiresAt > now` reuses it.
  renderRoot: { traceparent: string; expiresAt: number } | null;
  // fetch-patch guard: both module instances may call registerJayTraceNext, but
  // globalThis.fetch must be wrapped exactly once.
  registered: boolean;
  // test-only: overrides RENDER_WINDOW_MS for the window, set by
  // registerJayTraceNext. Undefined means use the constant.
  renderWindowMs?: number;
}

function getSsrState(): SsrState {
  const store = globalThis as Record<PropertyKey, unknown>;
  let state = store[STATE] as SsrState | undefined;
  if (!state) {
    state = { renderRoot: null, registered: false };
    store[STATE] = state;
  }
  return state;
}

/**
 * First-toucher mints the render root. If a render window is open (renderRoot
 * present and not expired) its traceparent is reused — the expiry is NOT
 * refreshed, so the window stays anchored to its first touch. Otherwise a fresh
 * root is minted, stored, and a new window opened. Both the root-layout getter
 * and any server fetch route through this, so whoever runs first mints and the
 * rest converge on the same root regardless of render execution order.
 */
function ensureRenderRoot(): { traceparent: string; reused: boolean } {
  const state = getSsrState();
  const now = Date.now();
  if (state.renderRoot && state.renderRoot.expiresAt > now) {
    return { traceparent: state.renderRoot.traceparent, reused: true };
  }
  const root = createTraceparent();
  const windowMs = state.renderWindowMs ?? RENDER_WINDOW_MS;
  state.renderRoot = { traceparent: root.value, expiresAt: now + windowMs };
  return { traceparent: root.value, reused: false };
}

/**
 * Root selection for a server-originated fetch:
 *  - if the caller already set a `traceparent` header, join that trace (its
 *    traceId is used as-is; propagation is left untouched);
 *  - else route through ensureRenderRoot() — mint the render root if this fetch
 *    is the first toucher, or reuse the open window's root otherwise.
 */
function resolveTraceRoot(request: Request): Traceparent {
  const existing = parseTraceparent(request.headers.get("traceparent"));
  if (existing) {
    ssrDebug("resolveRoot", { source: "header", traceparent: existing.value });
    return existing;
  }
  const { traceparent, reused } = ensureRenderRoot();
  const parsed = parseTraceparent(traceparent);
  if (parsed) {
    ssrDebug("resolveRoot", {
      source: reused ? "renderRoot(reused)" : "renderRoot(minted)",
      traceparent: parsed.value
    });
    return parsed;
  }
  // Defensive: a freshly minted/stored traceparent should always parse. If it
  // somehow does not, mint a bare root so the fetch is never dropped.
  const fallback = createTraceparent();
  ssrDebug("resolveRoot", { source: "renderRoot(minted)", traceparent: fallback.value });
  return fallback;
}

/**
 * Returns the render root traceparent (W3C string) for the current SSR render,
 * or null in a non-Next runtime. First-toucher semantics: if a server fetch in
 * this render already minted the root, this reuses it; otherwise it mints one
 * and opens the render window. Calling it more than once per render is safe —
 * repeat calls within the window reuse the same root rather than splitting.
 *
 * Wire the first client load onto this SSR trace by rendering, in the root
 * layout `<head>`:
 *
 *   <meta name="jaytrace-traceparent" content={(await getJayTraceSSRTraceparent()) ?? ""} />
 *
 * initJayTraceNext reads that tag; an empty content string is ignored and the
 * client generates its own root instead. Server fetches in the same render
 * (nested-layout RSC prefetch, route handlers) converge on the same root, so the
 * meta tag, the client RUM trace and the SSR fetch events all share one trace.
 *
 * Works even when registerJayTraceNext was never called (it only manages the
 * window; the fetch patch is what also touches it).
 */
export async function getJayTraceSSRTraceparent(): Promise<string | null> {
  try {
    const { traceparent, reused } = ensureRenderRoot();
    ssrDebug("getter", { reused, traceparent });
    return traceparent;
  } catch {
    // Non-Next runtime or a failure minting the root.
    return null;
  }
}

interface TraceBatch {
  traceId: string;
  traceparent: string;
  events: TimelineEvent[];
  startedAt: Date;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Patches the Node server's `globalThis.fetch` so server-originated HTTP
 * requests (RSC prefetch, route handlers, ...) are captured as JayTrace
 * timeline documents. Call once from Next.js `instrumentation.ts` `register()`.
 *
 * No-op in the browser, when already registered, or when no collector endpoint
 * can be resolved. Never throws and never alters the host fetch result.
 */
export function registerJayTraceNext(options: RegisterJayTraceNextOptions = {}): void {
  // Node-only: the browser SDK (initJayTrace) owns client-side fetch.
  if (typeof window !== "undefined") {
    return;
  }
  if (options.enabled === false) {
    return;
  }

  const state = getSsrState();
  if (state.registered) {
    return;
  }

  const env = readEnv();
  const resolvedEndpoint = options.endpoint ?? env.JAYTRACE_ENDPOINT ?? env.NEXT_PUBLIC_JAYTRACE_ENDPOINT;
  ssrDebug("register", { registered: state.registered, endpoint: !!resolvedEndpoint });
  // Without an endpoint we cannot ship anything — stay a silent no-op, never throw.
  if (!resolvedEndpoint) {
    return;
  }
  const endpoint: string = resolvedEndpoint;
  const apiKey =
    options.apiKey ??
    env.JAYTRACE_API_KEY ??
    env.NEXT_PUBLIC_JAYTRACE_QA_API_KEY ??
    env.NEXT_PUBLIC_JAYTRACE_API_KEY ??
    "local-dev-key";
  const service = `${options.service ?? env.NEXT_PUBLIC_JAYTRACE_SERVICE ?? "web"}-ssr`;

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    return;
  }

  state.registered = true;
  // Publish the render-window length so the getter (possibly a different module
  // instance) honors the same (test-overridable) window.
  state.renderWindowMs = options.renderWindowMs ?? RENDER_WINDOW_MS;

  const debounceMs = options.flushDebounceMs ?? DEFAULT_DEBOUNCE_MS;
  const captureBody = options.captureBody;
  const maxBytes = typeof captureBody === "object" ? captureBody.maxBytes ?? DEFAULT_BODY_MAX_BYTES : DEFAULT_BODY_MAX_BYTES;

  const batches = new Map<string, TraceBatch>();

  function bufferEvent(root: Traceparent, event: TimelineEvent): void {
    let batch = batches.get(root.traceId);
    if (!batch) {
      batch = { traceId: root.traceId, traceparent: root.value, events: [], startedAt: new Date() };
      batches.set(root.traceId, batch);
    }
    batch.events.push(event);

    if (batch.events.length >= MAX_BATCH_EVENTS) {
      void flushBatch(root.traceId);
      return;
    }

    if (batch.timer) {
      clearTimeout(batch.timer);
    }
    batch.timer = setTimeout(() => {
      void flushBatch(root.traceId);
    }, debounceMs);
    // Never keep the Node process alive just to flush telemetry.
    (batch.timer as unknown as { unref?: () => void }).unref?.();
  }

  async function flushBatch(traceId: string): Promise<void> {
    const batch = batches.get(traceId);
    if (!batch || batch.events.length === 0) {
      return;
    }
    batches.delete(traceId);
    if (batch.timer) {
      clearTimeout(batch.timer);
    }

    const document = createTimelineDocument({
      service,
      side: "back",
      traceId: batch.traceId,
      traceparent: batch.traceparent,
      startedAt: batch.startedAt,
      endedAt: new Date(),
      summary: summarizeTimeline(batch.events, "Next.js server timeline captured."),
      events: batch.events
    });

    await postToCollector(JSON.stringify({ apiKey, reason: "manual", document }));
  }

  async function postToCollector(body: string, attempt = 0): Promise<void> {
    try {
      // Use the untouched original fetch + internal header so our own POST is
      // never re-instrumented (recursion guard).
      await originalFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INTERNAL_HEADER]: "1"
        },
        body
      });
    } catch {
      if (attempt < 1) {
        await postToCollector(body, attempt + 1);
      }
      // Give up silently after a single retry — telemetry must never surface.
    }
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // A bug in our bookkeeping must never break the host's request. If we cannot
    // even inspect the request, fall back to the untouched original call.
    let request: Request;
    try {
      request = new Request(input as RequestInfo, init);
    } catch {
      return originalFetch(input as RequestInfo, init);
    }

    // Skip our own collector traffic and any request the host marked internal.
    if (request.headers.get(INTERNAL_HEADER) === "1" || isCollectorUrl(request.url, endpoint)) {
      return originalFetch(input as RequestInfo, init);
    }

    let root: Traceparent;
    try {
      root = resolveTraceRoot(request);
    } catch {
      const { traceparent } = ensureRenderRoot();
      root = parseTraceparent(traceparent) ?? createTraceparent();
    }

    // Propagate the trace to the downstream service.
    let outgoing = request;
    try {
      if (!request.headers.has("traceparent")) {
        const headers = new Headers(request.headers);
        headers.set("traceparent", createChildTraceparent(root).value);
        outgoing = new Request(request, { headers });
      }
    } catch {
      outgoing = request;
    }

    const startedAt = Date.now();
    let requestData: Record<string, unknown> | undefined;
    if (captureBody) {
      try {
        const bodyText = await captureBodyText(outgoing.clone(), maxBytes);
        if (bodyText) {
          requestData = { requestBody: parseIfJson(bodyText) };
        }
      } catch {
        // isolation
      }
    }

    try {
      const response = await originalFetch(outgoing);
      // Isolate the timeline write: the real response must pass through even if it throws.
      try {
        let data = requestData;
        if (captureBody) {
          const bodyText = await captureBodyText(response.clone(), maxBytes);
          if (bodyText) {
            data = { ...data, responseBody: parseIfJson(bodyText) };
          }
        }
        if (data) {
          data = redact(data) as Record<string, unknown>;
        }
        bufferEvent(
          root,
          buildEvent(
            `fetch ${outgoing.method} ${safeUrl(outgoing.url)} status=${response.status} durationMs=${Date.now() - startedAt}`,
            response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
            Date.now() - startedAt,
            data
          )
        );
      } catch {
        // isolation
      }
      return response;
    } catch (error) {
      // Isolate bookkeeping so it never masks/replaces the host's real fetch error.
      try {
        let data = requestData;
        if (data) {
          data = redact(data) as Record<string, unknown>;
        }
        bufferEvent(
          root,
          buildEvent(
            `fetch ${outgoing.method} ${safeUrl(outgoing.url)} failed durationMs=${Date.now() - startedAt} error=${errorName(error)}`,
            "error",
            Date.now() - startedAt,
            data
          )
        );
      } catch {
        // isolation
      }
      throw error;
    }
  }) as typeof fetch;
}

function buildEvent(
  text: string,
  severity: TimelineEvent["severity"],
  durationMs: number,
  data?: Record<string, unknown>
): TimelineEvent {
  const event = createTimelineEvent({ kind: "fetch", severity, text });
  event.durationMs = durationMs;
  if (data) {
    event.data = data;
  }
  return event;
}

function isCollectorUrl(value: string, endpoint: string): boolean {
  try {
    const target = new URL(value);
    const collector = new URL(endpoint);
    return target.origin === collector.origin && target.pathname === collector.pathname;
  } catch {
    return value === endpoint || value.startsWith(endpoint);
  }
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
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

function readEnv(): Record<string, string | undefined> {
  try {
    return typeof process === "undefined" ? {} : process?.env ?? {};
  } catch {
    return {};
  }
}
