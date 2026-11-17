import { hrTimeToMilliseconds } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  createTimelineDocument,
  createTimelineEvent,
  type JayTraceSeverity,
  type JayTraceTimelineDocument,
  type TimelineEvent
} from "@jaytrace/core";

import type { JayTraceExportOptions } from "./exporter-types.js";

/** ReadableSpan reduced to what the mapping needs — keeps the conversion testable without an OTel runtime. */
export interface SpanLite {
  name: string;
  /** SpanKind: 0 INTERNAL, 1 SERVER, 2 CLIENT, 3 PRODUCER, 4 CONSUMER */
  kind: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, unknown>;
  /** SpanStatusCode: 0 UNSET, 1 OK, 2 ERROR */
  statusCode: number;
  statusMessage?: string;
  /** span events — only `exception` ones are read (for the stack trace) */
  events?: SpanEventLite[];
}

export interface SpanEventLite {
  name: string;
  attributes?: Record<string, unknown>;
}

/**
 * TimelineEvent plus the span-shaped detail the console needs to draw a waterfall.
 * All additive and optional, so a consumer written against TimelineEvent keeps working.
 */
export interface BackTimelineEvent extends TimelineEvent {
  spanId?: string;
  parentSpanId?: string;
  /** root = 0, +1 per parent hop; 1 when the parent never reached this document */
  depth?: number;
  attrs?: Record<string, string | number>;
}

export interface LogLite {
  atMs: number;
  severity: JayTraceSeverity;
  text: string;
}

const SPAN_KIND_SERVER = 1;
const SPAN_KIND_CLIENT = 2;
const SPAN_KIND_PRODUCER = 3;
const SPAN_KIND_CONSUMER = 4;

const DEFAULT_SLOW_QUERY_THRESHOLD_MS = 300;
const DEFAULT_SLOW_REQUEST_THRESHOLD_MS = 3000;
const SPAN_STATUS_ERROR = 2;

/** Attributes worth carrying per event. A whitelist, not a filter: span attributes are unbounded. */
const EVENT_ATTR_KEYS = [
  "http.route",
  "http.method",
  "http.status_code",
  "http.response.status_code",
  "url.path",
  "db.system",
  "db.name",
  "server.address",
  "net.peer.name",
  "rpc.system",
  "rpc.method",
  "messaging.destination"
] as const;
const ATTR_VALUE_MAX_CHARS = 512;
const STACK_MAX_CHARS = 8 * 1024;
const MAX_DEPTH_WALK = 64;
const BYTES_PER_MB = 1024 * 1024;

/** The only OTel-aware function: everything downstream works on SpanLite. */
export function toSpanLite(span: ReadableSpan): SpanLite {
  const spanContext = span.spanContext();
  return {
    name: span.name,
    kind: span.kind as number,
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    startMs: hrTimeToMilliseconds(span.startTime),
    endMs: hrTimeToMilliseconds(span.endTime),
    attributes: { ...span.attributes },
    statusCode: span.status.code as number,
    statusMessage: span.status.message,
    events: span.events?.length ? span.events.map((event) => ({ name: event.name, attributes: event.attributes })) : undefined
  };
}

/** First attribute that is actually set, walking the keys in order (new semconv name first). */
export function attr(attributes: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = attributes[key];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

/**
 * Maps one span onto a timeline event. Spans we have no mapping for (nestjs-core
 * INTERNAL plumbing and friends) return null so the timeline stays readable.
 */
export function spanToEvent(root: SpanLite, span: SpanLite, options: JayTraceExportOptions): BackTimelineEvent | null {
  const event: BackTimelineEvent | null = mapSpan(root, span, options);
  if (!event) {
    return null;
  }
  event.spanId = span.spanId;
  event.parentSpanId = span.parentSpanId;
  event.attrs = pickAttrs(span.attributes);
  return event;
}

function mapSpan(root: SpanLite, span: SpanLite, options: JayTraceExportOptions): TimelineEvent | null {
  const at = elapsed(span.startMs, root.startMs);
  const durationMs = Math.max(0, span.endMs - span.startMs);

  const statement = asText(attr(span.attributes, "db.statement", "db.query.text"));
  if (statement) {
    return withDuration(createTimelineEvent({ at, kind: "db", text: statement }), durationMs, options.slowQueryThresholdMs ?? DEFAULT_SLOW_QUERY_THRESHOLD_MS);
  }

  if (span.kind === SPAN_KIND_SERVER) {
    const method = asText(attr(span.attributes, "http.request.method", "http.method")) ?? "REQUEST";
    const route = asText(attr(span.attributes, "http.route", "url.path", "http.target")) ?? "/";
    return withDuration(
      createTimelineEvent({ at, kind: "request", severity: "info", text: `request ${method} ${route}` }),
      durationMs,
      options.slowRequestThresholdMs ?? DEFAULT_SLOW_REQUEST_THRESHOLD_MS
    );
  }

  if (span.kind === SPAN_KIND_CONSUMER) {
    // amqplib puts pattern/queue into the span name, so it carries the routing info already.
    return withDuration(
      createTimelineEvent({ at, kind: "request", severity: "info", text: messageSubject(span.name) }),
      durationMs,
      options.slowRequestThresholdMs ?? DEFAULT_SLOW_REQUEST_THRESHOLD_MS
    );
  }

  if (span.kind === SPAN_KIND_CLIENT) {
    const method = asText(attr(span.attributes, "http.request.method", "http.method"));
    const url = asText(attr(span.attributes, "url.full", "http.url"));
    if (method || url) {
      const status = asText(attr(span.attributes, "http.response.status_code", "http.status_code"));
      const text = [method, url, status].filter(Boolean).join(" ");
      return withDuration(createTimelineEvent({ at, kind: "fetch", text }), durationMs, options.slowRequestThresholdMs ?? DEFAULT_SLOW_REQUEST_THRESHOLD_MS);
    }
    return null;
  }

  if (span.kind === SPAN_KIND_PRODUCER) {
    return withDuration(createTimelineEvent({ at, kind: "queue", text: `publish ${span.name}` }), durationMs, options.slowRequestThresholdMs ?? DEFAULT_SLOW_REQUEST_THRESHOLD_MS);
  }

  // INTERNAL (nestjs-core plumbing) and anything unknown: noise, drop it.
  return null;
}

/** Roots worth counting for latency stats: an incoming request or a consumed message. */
export function isTrackedRoot(root: SpanLite): boolean {
  return root.kind === SPAN_KIND_SERVER || root.kind === SPAN_KIND_CONSUMER;
}

/**
 * Aggregation label for a tracked root: `METHOD /template/route` for SERVER (GET and POST on one
 * path have their own latency profile), the message subject for CONSUMER. undefined when no
 * template route is on the span — the caller decides what to call that.
 *
 * Unlike the document's own `route`, url.path is deliberately not a fallback here: one histogram
 * key per `/users/42` would blow the per-window route budget on the first minute of traffic.
 */
export function rootRouteLabel(root: SpanLite): string | undefined {
  if (root.kind === SPAN_KIND_CONSUMER) {
    return messageSubject(root.name);
  }
  const route = asText(attr(root.attributes, "http.route"));
  if (route === undefined) {
    return undefined;
  }
  // Same "REQUEST" stand-in the document summary uses, so both read alike.
  const method = asText(attr(root.attributes, "http.request.method", "http.method")) ?? "REQUEST";
  return `${method.toUpperCase()} ${route}`;
}

/** Whether a root span counts as failed — checked before building a document, and inside it. */
export function isFailedRoot(root: SpanLite): boolean {
  const httpStatus = asNumber(attr(root.attributes, "http.response.status_code", "http.status_code"));
  return root.statusCode === SPAN_STATUS_ERROR || (httpStatus !== undefined && httpStatus >= 500);
}

/**
 * Root span + children + collected logs -> one back-side timeline document.
 * Never throws: unmappable spans are skipped, unknown attribute values fall back to defaults.
 */
export function buildBackDocument(input: {
  root: SpanLite;
  children: SpanLite[];
  logs: LogLite[];
  options: JayTraceExportOptions;
  truncatedCount: number;
}): JayTraceTimelineDocument {
  const { root, children, logs, options, truncatedCount } = input;

  const spans = [root, ...children];
  const parents = new Map(spans.map((span) => [span.spanId, span.parentSpanId]));

  const timed: { atMs: number; event: TimelineEvent }[] = [];
  for (const span of spans) {
    const event = spanToEvent(root, span, options);
    if (event) {
      event.depth = depthOf(span.spanId, root.spanId, parents);
      timed.push({ atMs: span.startMs, event });
    }
  }
  for (const log of logs) {
    timed.push({
      atMs: log.atMs,
      event: createTimelineEvent({ at: elapsed(log.atMs, root.startMs), kind: "log", severity: log.severity, text: log.text })
    });
  }
  timed.sort((left, right) => left.atMs - right.atMs);

  const method = asText(attr(root.attributes, "http.request.method", "http.method"));
  const route = asText(attr(root.attributes, "http.route", "url.path", "http.target"));
  const httpStatus = asNumber(attr(root.attributes, "http.response.status_code", "http.status_code"));

  const error = isFailedRoot(root)
    ? { name: "SpanError", message: root.statusMessage ?? `status ${httpStatus ?? "unknown"}`, stack: exceptionStack(spans) }
    : undefined;

  const subject = root.kind === SPAN_KIND_CONSUMER ? messageSubject(root.name) : `${method ?? "REQUEST"} ${route ?? ""}`;
  const summary = error ? `${subject} failed: ${error.name} ${error.message}` : `${subject} completed`;

  return createTimelineDocument({
    service: options.service ?? "api",
    side: "back",
    traceId: root.traceId,
    // @jaytrace/nestjs stamps these on the root span when it detects init: they are the
    // request-shaped details OTel instrumentation has no attribute for.
    sessionId: asText(root.attributes["jaytrace.session_id"]),
    spanId: root.spanId,
    startedAt: new Date(root.startMs),
    endedAt: new Date(root.endMs),
    summary: summary.replace(/\s+/g, " ").trim(),
    events: timed.map((entry) => entry.event),
    context: {
      // @jaytrace/nestjs setContext() in integrated mode. Spread first: the standard keys below win.
      ...contextPatch(root),
      environment: options.environment,
      release: options.release,
      route,
      method,
      statusCode: httpStatus,
      requestBody: asText(root.attributes["jaytrace.request_body"]),
      responseBody: asText(root.attributes["jaytrace.response_body"]),
      truncated: truncatedCount > 0 ? truncatedCount : undefined,
      host: hostInfo()
    },
    error
  });
}

/** Whitelisted attributes only, strings capped: span attributes carry whole SQL statements and URLs. */
function pickAttrs(attributes: Record<string, unknown>): Record<string, string | number> | undefined {
  const picked: Record<string, string | number> = {};
  for (const key of EVENT_ATTR_KEYS) {
    const value = attributes[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      picked[key] = value;
    } else if (typeof value === "string" && value.length > 0) {
      picked[key] = value.slice(0, ATTR_VALUE_MAX_CHARS);
    }
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/** root = 0, +1 per parent hop. A parent missing from this document puts its child at 1. */
function depthOf(spanId: string, rootSpanId: string, parents: Map<string, string | undefined>): number {
  let current = spanId;
  let depth = 0;
  // ponytail: bounded walk — a cyclic parent chain would otherwise spin forever.
  while (current !== rootSpanId && depth < MAX_DEPTH_WALK) {
    const parent = parents.get(current);
    if (parent === undefined || !parents.has(parent)) {
      return depth + 1;
    }
    current = parent;
    depth += 1;
  }
  return depth;
}

/** First `exception` span event carrying a stack, root first: that is the one that failed the request. */
function exceptionStack(spans: SpanLite[]): string | undefined {
  for (const span of spans) {
    for (const event of span.events ?? []) {
      const stack = event.attributes?.["exception.stacktrace"];
      if (typeof stack === "string" && stack.length > 0) {
        return stack.slice(0, STACK_MAX_CHARS);
      }
    }
  }
  return undefined;
}

/** Which pod served this, and how much memory it was holding — measured once per document. */
function hostInfo(): { pod?: string; rssMb?: number; heapUsedMb?: number } | undefined {
  const host: { pod?: string; rssMb?: number; heapUsedMb?: number } = {};
  const pod = process.env.HOSTNAME;
  if (pod) {
    host.pod = pod;
  }
  try {
    const memory = process.memoryUsage();
    host.rssMb = Math.round(memory.rss / BYTES_PER_MB);
    host.heapUsedMb = Math.round(memory.heapUsed / BYTES_PER_MB);
  } catch {
    // Not every runtime exposes memoryUsage; the pod name alone is still worth having.
  }
  return Object.keys(host).length > 0 ? host : undefined;
}

/** JSON patch stamped by @jaytrace/nestjs setContext(); anything unparseable is dropped. */
function contextPatch(root: SpanLite): Record<string, unknown> {
  const raw = root.attributes["jaytrace.context_patch"];
  if (typeof raw !== "string") {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// createTimelineEvent only carries at/kind/severity/text, so timing lands here (same as nestjs context.ts).
/**
 * amqplib names consumer spans after the queue, so the reader needs the `MSG ` marker added here —
 * but @jaytrace/nestjs already names its spans `MSG <pattern>`, and prefixing twice reads as
 * "MSG MSG shop.get.stores".
 */
function messageSubject(name: string): string {
  return name.startsWith("MSG ") ? name : `MSG ${name}`;
}

function withDuration(event: TimelineEvent, durationMs: number, thresholdMs: number): TimelineEvent {
  event.durationMs = durationMs;
  if (durationMs > thresholdMs) {
    event.slow = true;
  }
  return event;
}

function elapsed(atMs: number, startMs: number): string {
  return `${(Math.max(0, atMs - startMs) / 1000).toFixed(3)}s`;
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? value : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
