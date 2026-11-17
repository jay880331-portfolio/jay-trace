import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INVALID_SPAN_CONTEXT, ROOT_CONTEXT, TraceFlags, context as otelContext, trace as otelTrace } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import type { AnyValueMap } from "@opentelemetry/api-logs";
import type { SdkLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, Span } from "@opentelemetry/sdk-trace-base";
import type { JayTraceTimelineDocument } from "@jaytrace/core";

import {
  attr,
  buildBackDocument,
  buildS3Key,
  currentTraceparent,
  isFailedRoot,
  JayTraceLogRecordProcessor,
  JayTraceMetrics,
  JayTraceSpanProcessor,
  S3JayTraceExporter,
  spanToEvent,
  type BackTimelineEvent,
  type ExportInput,
  type SpanLite
} from "./index.js";
import { patchConsole } from "./console-patch.js";
import { createNodeDbIndexer, resetSharedPool, type DbIndexerPool, type DbIndexerPoolConfig } from "./db-indexer.js";
import { isIgnoredHttpPath, parseInstrumentDisable, resolveNodeOptions } from "./env.js";
import { FileJayTraceExporter } from "./file-exporter.js";
import { bucketIndex, createRouteStats, LATENCY_BUCKETS_MS } from "./route-stats.js";
import { TraceBuffer } from "./trace-buffer.js";

// back-{service} side lands in the object key verbatim.
const key = buildS3Key({
  prefix: "stage",
  traceId: "abc123",
  side: "back-shop-api",
  timestamp: new Date("2026-08-04T00:00:00.000Z")
});
assert.ok(key.startsWith("stage/2026/08/04/abc123/back-shop-api-"), "back-{service} s3 key");

// The exporter constructs without Nest (no S3 call).
const exporter = new S3JayTraceExporter(
  { apiKey: "k", s3: { bucket: "b", region: "ap-northeast-2" } },
  new JayTraceMetrics()
);
assert.equal(typeof exporter.export, "function");

// --- converter: OTel spans -> jaytrace timeline ---
const opts = { apiKey: "k", service: "shop-api", s3: { bucket: "b", region: "r" } };
const httpRoot: SpanLite = {
  name: "GET /users/:id",
  kind: 1,
  traceId: "t1",
  spanId: "s1",
  startMs: 1000,
  endMs: 1400,
  attributes: { "http.request.method": "GET", "http.route": "/users/:id", "http.response.status_code": 500 },
  statusCode: 2,
  statusMessage: "boom"
};
const dbChild: SpanLite = {
  name: "SELECT",
  kind: 2,
  traceId: "t1",
  spanId: "s2",
  startMs: 1100,
  endMs: 1500,
  attributes: { "db.statement": "SELECT * FROM users WHERE id = ?" },
  statusCode: 0
};

assert.equal(attr(httpRoot.attributes, "http.request.method", "http.method"), "GET");

const dbEvent = spanToEvent(httpRoot, dbChild, opts);
assert.equal(dbEvent?.kind, "db");
assert.equal(dbEvent?.slow, true); // 400ms > default 300ms

const doc = buildBackDocument({
  root: httpRoot,
  children: [dbChild],
  logs: [{ atMs: 1200, severity: "error", text: "user lookup failed" }],
  options: opts,
  truncatedCount: 0
});
assert.equal(doc.side, "back");
assert.equal(doc.service, "shop-api");
assert.equal(doc.traceId, "t1");
assert.equal(doc.context?.statusCode, 500);
assert.ok(doc.error);
assert.deepEqual(
  (doc.events ?? []).map((event) => event.kind),
  ["request", "db", "log"]
);

assert.equal(doc.sessionId, undefined); // nothing stamped the root, so no session join key

// @jaytrace/nestjs stamps these three on the root span once it detects init.
const bridgedRoot: SpanLite = {
  ...httpRoot,
  attributes: {
    ...httpRoot.attributes,
    "jaytrace.session_id": "sess-1",
    "jaytrace.request_body": '{"id":42,"password":"redacted"}',
    "jaytrace.response_body": '{"ok":false}'
  }
};
const bridgedDoc = buildBackDocument({ root: bridgedRoot, children: [], logs: [], options: opts, truncatedCount: 0 });
assert.equal(bridgedDoc.sessionId, "sess-1");
assert.equal(bridgedDoc.context?.requestBody, '{"id":42,"password":"redacted"}');
assert.equal(bridgedDoc.context?.responseBody, '{"ok":false}');

// setContext() in integrated mode arrives as a JSON patch on the root span.
const patchedRoot: SpanLite = {
  ...httpRoot,
  attributes: { ...httpRoot.attributes, "jaytrace.context_patch": '{"tenantId":"t-1","route":"spoofed"}' }
};
const patchedDoc = buildBackDocument({ root: patchedRoot, children: [], logs: [], options: opts, truncatedCount: 0 });
assert.equal(patchedDoc.context?.tenantId, "t-1");
assert.equal(patchedDoc.context?.route, "/users/:id"); // standard keys win over the patch

const brokenPatchRoot: SpanLite = { ...httpRoot, attributes: { ...httpRoot.attributes, "jaytrace.context_patch": "{not json" } };
assert.equal(buildBackDocument({ root: brokenPatchRoot, children: [], logs: [], options: opts, truncatedCount: 0 }).context?.route, "/users/:id");

const consumerRoot: SpanLite = { ...httpRoot, kind: 4, attributes: {}, name: "get-user process" };
const consumerDoc = buildBackDocument({ root: consumerRoot, children: [], logs: [], options: opts, truncatedCount: 3 });
assert.ok(consumerDoc.events?.[0]?.text.startsWith("MSG "));
assert.equal(consumerDoc.context?.truncated, 3);

// @jaytrace/nestjs already names its spans `MSG <pattern>`: prefixing again reads as "MSG MSG ...".
const prefixedConsumerRoot: SpanLite = { ...httpRoot, kind: 4, attributes: {}, name: "MSG shop.get.stores" };
const prefixedConsumerDoc = buildBackDocument({ root: prefixedConsumerRoot, children: [], logs: [], options: opts, truncatedCount: 0 });
assert.equal(prefixedConsumerDoc.events?.[0]?.text, "MSG shop.get.stores");
assert.ok(prefixedConsumerDoc.summary.startsWith("MSG shop.get.stores "), prefixedConsumerDoc.summary);

// fetch: CLIENT + http attributes, queue: PRODUCER, dropped: INTERNAL
const fetchChild: SpanLite = {
  name: "GET",
  kind: 2,
  traceId: "t1",
  spanId: "s3",
  startMs: 1150,
  endMs: 1250,
  attributes: {
    "http.request.method": "GET",
    "url.full": "https://api.example.com/x",
    "http.response.status_code": 502
  },
  statusCode: 2
};
assert.equal(spanToEvent(httpRoot, fetchChild, opts)?.kind, "fetch");

const publishChild: SpanLite = {
  name: "get-user send",
  kind: 3,
  traceId: "t1",
  spanId: "s4",
  startMs: 1050,
  endMs: 1060,
  attributes: {},
  statusCode: 0
};
const queueEvent = spanToEvent(httpRoot, publishChild, opts);
assert.equal(queueEvent?.kind, "queue");
assert.ok(queueEvent?.text.startsWith("publish "));

const internalChild: SpanLite = {
  name: "UsersController.find",
  kind: 0,
  traceId: "t1",
  spanId: "s5",
  startMs: 1010,
  endMs: 1300,
  attributes: {},
  statusCode: 0
};
assert.equal(spanToEvent(httpRoot, internalChild, opts), null);

// express layer spans are INTERNAL too: they exist so the matched route reaches the SERVER span
// as http.route, and must never show up as timeline events themselves.
const expressLayer: SpanLite = {
  ...internalChild,
  spanId: "s6",
  name: "request handler - /pay",
  attributes: { "express.type": "request_handler", "express.name": "/pay", "http.route": "/pay" }
};
assert.equal(spanToEvent(httpRoot, expressLayer, opts), null, "express layer span must not become an event");
const middlewareLayer: SpanLite = { ...expressLayer, spanId: "s7", name: "middleware - jsonParser", attributes: { "express.type": "middleware" } };
assert.equal(spanToEvent(httpRoot, middlewareLayer, opts), null, "express middleware span must not become an event");

// --- span detail: depth, whitelisted attrs, exception stack (all additive to the v1 schema) ---

// depth walks the parent chain: root 0, child 1, grandchild 2; a parent outside the document falls back to 1.
const level1: SpanLite = { ...dbChild, spanId: "d1", parentSpanId: "s1", attributes: { "db.statement": "SELECT 1" } };
const level2: SpanLite = { ...dbChild, spanId: "d2", parentSpanId: "d1", attributes: { "db.statement": "SELECT 2" } };
const orphanChild: SpanLite = { ...dbChild, spanId: "d3", parentSpanId: "gone", attributes: { "db.statement": "SELECT 3" } };
const nestedDoc = buildBackDocument({
  root: httpRoot,
  children: [level1, level2, orphanChild],
  logs: [],
  options: opts,
  truncatedCount: 0
});
assert.deepEqual(
  ((nestedDoc.events ?? []) as BackTimelineEvent[]).map((event) => [event.spanId, event.parentSpanId, event.depth]),
  [
    ["s1", undefined, 0],
    ["d1", "s1", 1],
    ["d2", "d1", 2],
    ["d3", "gone", 1]
  ]
);

// attrs: whitelist only, values capped, non string/number dropped, empty -> no attrs key at all.
const attrChild: SpanLite = {
  ...dbChild,
  spanId: "a1",
  attributes: {
    "db.statement": "SELECT * FROM users",
    "db.system": "mysql",
    "http.status_code": 500,
    "http.route": "x".repeat(600),
    "db.statement.params": "not whitelisted",
    "server.address": { host: "nope" },
    "rpc.system": true
  }
};
const attrEvent = spanToEvent(httpRoot, attrChild, opts);
assert.deepEqual(Object.keys(attrEvent?.attrs ?? {}).sort(), ["db.system", "http.route", "http.status_code"]);
assert.equal(attrEvent?.attrs?.["http.status_code"], 500);
assert.equal((attrEvent?.attrs?.["http.route"] as string).length, 512, "attr strings are capped at 512 chars");
assert.equal(spanToEvent(httpRoot, publishChild, opts)?.attrs, undefined, "no whitelisted attribute -> no attrs");
assert.ok(!("attrs" in (nestedDoc.events?.[1] ?? {})), "attrs is stripped from the document, not sent as null");

// error.stack comes from the first exception span event; without one the field stays absent.
const throwingChild: SpanLite = {
  ...dbChild,
  spanId: "e1",
  events: [{ name: "exception", attributes: { "exception.stacktrace": "Error: boom\n    at handler (app.js:1:1)" } }]
};
const stackDoc = buildBackDocument({ root: httpRoot, children: [throwingChild], logs: [], options: opts, truncatedCount: 0 });
assert.ok(stackDoc.error?.stack?.startsWith("Error: boom"), stackDoc.error?.stack);
assert.ok(!("stack" in (doc.error ?? {})), "no exception event -> no stack field");

// 8KB cap: a runaway stack must not blow up the document.
const hugeStack: SpanLite = {
  ...throwingChild,
  events: [{ name: "exception", attributes: { "exception.stacktrace": "y".repeat(20000) } }]
};
assert.equal(
  buildBackDocument({ root: httpRoot, children: [hugeStack], logs: [], options: opts, truncatedCount: 0 }).error?.stack?.length,
  8 * 1024
);

// context.host: pod from HOSTNAME (absent when unset), memory always measured.
const hostname = process.env.HOSTNAME;
process.env.HOSTNAME = "sample-shop-api-7d9";
const hostDoc = buildBackDocument({ root: httpRoot, children: [], logs: [], options: opts, truncatedCount: 0 });
const host = hostDoc.context?.host as { pod?: string; rssMb?: number; heapUsedMb?: number };
assert.equal(host?.pod, "sample-shop-api-7d9");
assert.ok(Number.isInteger(host?.rssMb) && (host?.rssMb ?? 0) > 0, "rssMb is a whole number of MB");
assert.ok(Number.isInteger(host?.heapUsedMb));
delete process.env.HOSTNAME;
assert.equal((buildBackDocument({ root: httpRoot, children: [], logs: [], options: opts, truncatedCount: 0 }).context?.host as { pod?: string }).pod, undefined);
if (hostname !== undefined) {
  process.env.HOSTNAME = hostname;
}

// --- trace buffer: span/log accumulation per local root ---
const exported: ExportInput[] = [];
const fakeExporter = {
  export: (input: ExportInput) => {
    exported.push(input);
  }
};
const buffer = new TraceBuffer({ options: opts, exporter: fakeExporter, exportPolicy: "errors" });

// A healthy request is not exported under the "errors" policy.
buffer.onSpanStart("r1", undefined, false);
buffer.onSpanEnd({
  ...httpRoot,
  spanId: "r1",
  statusCode: 0,
  attributes: { "http.request.method": "GET", "http.route": "/ok", "http.response.status_code": 200 }
});
assert.equal(exported.length, 0);

// Failing root + child + log -> one document, side carries the service.
buffer.onSpanStart("r2", undefined, false);
buffer.onSpanStart("c1", "r2", false);
buffer.onLog("c1", { atMs: 1200, severity: "error", text: "boom" });
buffer.onSpanEnd({ ...dbChild, spanId: "c1" });
buffer.onSpanEnd({ ...httpRoot, spanId: "r2" });
assert.equal(exported.length, 1);
assert.equal(exported[0]?.side, "back-shop-api");
const exportedDoc = exported[0]?.document as JayTraceTimelineDocument;
assert.deepEqual(
  (exportedDoc.events ?? []).map((event) => event.kind),
  ["request", "db", "log"]
);

// A remote parent (RMQ consume) starts a new local root.
buffer.onSpanStart("r3", "remote-parent", true);
buffer.onSpanEnd({ ...consumerRoot, spanId: "r3", statusCode: 2 });
assert.equal(exported.length, 2);

// Past the per-root cap events are counted as truncated; children outliving their root are dropped.
const capped = new TraceBuffer({ options: opts, exporter: fakeExporter, exportPolicy: "all", maxEventsPerRoot: 1 });
capped.onSpanStart("r4", undefined, false);
capped.onSpanStart("c2", "r4", false);
capped.onLog("c2", { atMs: 1200, severity: "info", text: "kept" });
capped.onSpanEnd({ ...dbChild, spanId: "c2" });
capped.onSpanEnd({ ...httpRoot, spanId: "r4", statusCode: 0, attributes: {} });
assert.equal((exported[2]?.document as JayTraceTimelineDocument).context?.truncated, 1);
capped.onSpanEnd({ ...dbChild, spanId: "c2" });
assert.equal(capped.droppedSpans, 1);

// --- route stats hook: every tracked root is counted, whether or not it is exported ---
const counted: Array<[string | undefined, string | undefined, number, boolean]> = [];
const statsBuffer = new TraceBuffer({
  options: opts,
  // Its own exporter: the shared `exported` array is indexed by position further down.
  exporter: { export: () => undefined },
  exportPolicy: "errors",
  stats: {
    record: (service, route, durationMs, failed) => {
      counted.push([service, route, durationMs, failed]);
    }
  }
});
statsBuffer.onSpanStart("st1", undefined, false);
statsBuffer.onSpanEnd({
  ...httpRoot,
  spanId: "st1",
  statusCode: 0,
  attributes: { "http.request.method": "get", "http.route": "/users/:id", "http.response.status_code": 200 }
});
statsBuffer.onSpanStart("st2", undefined, false);
statsBuffer.onSpanEnd({ ...consumerRoot, spanId: "st2", statusCode: 2 });
statsBuffer.onSpanStart("st3", undefined, false);
statsBuffer.onSpanEnd({ ...httpRoot, kind: 2, spanId: "st3", statusCode: 0, attributes: {} });
statsBuffer.onSpanStart("st4", undefined, false);
statsBuffer.onSpanEnd({ ...httpRoot, spanId: "st4", statusCode: 0, attributes: { "http.route": "/orders" } });
statsBuffer.onSpanStart("st5", undefined, false);
statsBuffer.onSpanEnd({ ...httpRoot, spanId: "st5", statusCode: 0, attributes: {} });
assert.deepEqual(counted, [
  // A healthy request produces no document under "errors" — but it is the p95 denominator.
  // GET and POST on one path have their own latency profile, so the method is part of the key.
  ["shop-api", "GET /users/:id", 400, false],
  ["shop-api", "MSG get-user process", 400, true],
  // st3 is a CLIENT root (stray fire-and-forget work): not a route, not counted.
  ["shop-api", "REQUEST /orders", 400, false],
  // No template route at all: the collector files it under __unknown__.
  ["shop-api", undefined, 400, false]
]);

// Export policy is decided from the root alone, before any document is built.
assert.equal(isFailedRoot(httpRoot), true); // span status ERROR
assert.equal(isFailedRoot({ ...httpRoot, statusCode: 0 }), true); // http 500
assert.equal(
  isFailedRoot({ ...httpRoot, statusCode: 0, attributes: { "http.response.status_code": 200 } }),
  false
);

// OTel calls processors bare, so nothing they touch may throw back into the app.
const spanProcessor = new JayTraceSpanProcessor(buffer);
const logProcessor = new JayTraceLogRecordProcessor(buffer);
assert.doesNotThrow(() => spanProcessor.onStart({} as Span, ROOT_CONTEXT));
assert.doesNotThrow(() => spanProcessor.onEnd({} as ReadableSpan)); // toSpanLite hits a missing spanContext()
assert.doesNotThrow(() => logProcessor.onEmit({} as SdkLogRecord)); // hrTime missing

// Log body that throws from both toJSON and toString: neither the serializer nor the fallback may escape.
const hostileBody: AnyValueMap = {};
const boom = () => {
  throw new Error("hostile log body");
};
Object.defineProperty(hostileBody, "toJSON", { value: boom });
Object.defineProperty(hostileBody, "toString", { value: boom });

// The record still has to land as a log event: if toText escaped, onEmit would bail and lose it.
const guarded = new TraceBuffer({ options: opts, exporter: fakeExporter, exportPolicy: "all" });
guarded.onSpanStart("r5", undefined, false);
assert.doesNotThrow(() =>
  new JayTraceLogRecordProcessor(guarded).onEmit({
    hrTime: [1, 200000000],
    body: hostileBody,
    spanContext: { traceId: "t1", spanId: "r5", traceFlags: TraceFlags.SAMPLED }
  } as SdkLogRecord)
);
guarded.onSpanEnd({ ...httpRoot, spanId: "r5" });
assert.ok(
  ((exported[3]?.document as JayTraceTimelineDocument).events ?? []).some((event) => event.kind === "log")
);

// --- console patch: original still runs, emit sees the formatted text, unpatch restores ---
const captured: Array<{ severity: string; text: string }> = [];
const unpatch = patchConsole((severity, text) => {
  captured.push({ severity, text });
});
console.error("bad thing", { code: 500 });
unpatch();
console.error("not captured");
assert.equal(captured.length, 1);
assert.equal(captured[0]?.severity, "error");
assert.ok(captured[0]?.text.includes("bad thing"));

// A console call made from inside emit stays on the original method — no recursion.
const reentrantTexts = new Array<string>();
const unpatchGuard = patchConsole((_severity, text) => {
  reentrantTexts.push(text);
  console.log("from inside emit");
});
console.log("outer");
unpatchGuard();
assert.equal(reentrantTexts.length, 1);

// --- file exporter: one json file per document under {dir}/{s3 key} ---
const dir = mkdtempSync(join(tmpdir(), "jt-"));
const fileExporter = new FileJayTraceExporter(dir, opts);
fileExporter.export({ side: "back-shop-api", document: exportedDoc });
await fileExporter.drain?.();
assert.equal(
  readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".json")).length,
  1
);

// --- env: init must degrade to "not configured" instead of throwing ---
assert.equal(resolveNodeOptions({}), null);
const resolved = resolveNodeOptions({
  JAYTRACE_API_KEY: "k",
  JAYTRACE_BUCKET: "b",
  AWS_REGION: "ap-northeast-2",
  JAYTRACE_SERVICE: "shop-api",
  JAYTRACE_EXPORT: "slow",
  JAYTRACE_EXPORT_DIR: "/tmp/jt"
});
assert.equal(resolved?.exportPolicy, "slow");
assert.equal(resolved?.exportDir, "/tmp/jt");
assert.equal(resolved?.options.service, "shop-api");

// Defaults: unknown policy falls back to "errors", service to "api", prefix to NODE_ENV.
const defaulted = resolveNodeOptions({
  JAYTRACE_API_KEY: "k",
  JAYTRACE_BUCKET: "b",
  AWS_REGION: "r",
  JAYTRACE_EXPORT: "nonsense",
  NODE_ENV: "stage"
});
assert.equal(defaulted?.exportPolicy, "errors");
assert.equal(defaulted?.options.service, "api");
assert.equal(defaulted?.options.s3.prefix, "stage");
assert.equal(defaulted?.exportDir, undefined);

assert.deepEqual([...parseInstrumentDisable({ JAYTRACE_INSTRUMENT_DISABLE: "pg, winston" })], ["pg", "winston"]);
assert.deepEqual([...parseInstrumentDisable({ JAYTRACE_INSTRUMENT_DISABLE: "pg, bogus" })], ["pg"]);
assert.deepEqual([...parseInstrumentDisable({})], []);
assert.deepEqual([...parseInstrumentDisable({ JAYTRACE_INSTRUMENT_DISABLE: "express" })], ["express"]);

// --- JAYTRACE_HTTP_IGNORE_PATHS: k8s probes must not become spans at all ---
const httpIgnoreEnv = process.env.JAYTRACE_HTTP_IGNORE_PATHS;

// Unset: nothing is ignored, and a garbage url is still safe.
delete process.env.JAYTRACE_HTTP_IGNORE_PATHS;
assert.equal(isIgnoredHttpPath("/health"), false, "unset → ignore nothing");
assert.equal(isIgnoredHttpPath(undefined), false);

// Exact entry matches only itself; the trailing-* entry matches the whole subtree.
process.env.JAYTRACE_HTTP_IGNORE_PATHS = "/health, /probe*";
assert.equal(isIgnoredHttpPath("/health"), true, "exact match");
assert.equal(isIgnoredHttpPath("/health/ready"), false, "exact entry is not a prefix");
assert.equal(isIgnoredHttpPath("/probe"), true, "prefix entry matches the bare path");
assert.equal(isIgnoredHttpPath("/probe/live"), true, "prefix entry matches below it");
assert.equal(isIgnoredHttpPath("/users/1"), false);
// The query string is dropped before comparing, so ?ts=1 does not defeat an exact entry.
assert.equal(isIgnoredHttpPath("/health?ts=1"), true, "querystring stripped");
assert.equal(isIgnoredHttpPath(undefined), false, "no url → never ignored");

// Lazy: the host app injects secrets with Object.assign(process.env) after boot, so a value read
// once at bootstrap would be the wrong one. Changing env between calls must take effect.
process.env.JAYTRACE_HTTP_IGNORE_PATHS = "/health*";
assert.equal(isIgnoredHttpPath("/health/ready"), true, "env re-read between calls");
process.env.JAYTRACE_HTTP_IGNORE_PATHS = "";
assert.equal(isIgnoredHttpPath("/health"), false, "cleared env stops ignoring");

if (httpIgnoreEnv === undefined) {
  delete process.env.JAYTRACE_HTTP_IGNORE_PATHS;
} else {
  process.env.JAYTRACE_HTTP_IGNORE_PATHS = httpIgnoreEnv;
}

// The buffer takes late-arriving env: options and policy are swapped in once the exporter configures.
const late = new TraceBuffer({
  options: { apiKey: "", s3: { bucket: "", region: "" } },
  exporter: fakeExporter,
  exportPolicy: "errors"
});
late.updateOptions(opts, "all");
late.onSpanStart("r6", undefined, false);
late.onSpanEnd({ ...httpRoot, spanId: "r6", statusCode: 0, attributes: {} }); // healthy, exported only under "all"
assert.equal(exported.at(-1)?.side, "back-shop-api");

// --- currentTraceparent: the client side of the payload-based RPC bridge ---
assert.equal(currentTraceparent(), undefined, "no active span → no traceparent");

// @opentelemetry/api ships a no-op context manager, so an active span needs a real one.
let activeContext = ROOT_CONTEXT;
otelContext.setGlobalContextManager({
  active: () => activeContext,
  with(ctx, fn, thisArg, ...args) {
    const previous = activeContext;
    activeContext = ctx;
    try {
      return fn.call(thisArg, ...args);
    } finally {
      activeContext = previous;
    }
  },
  bind: (_ctx, target) => target,
  enable() {
    return this;
  },
  disable() {
    return this;
  }
});

const bridgeTraceId = "1111111111111111111111111111111a";
const bridgeSpanId = "222222222222222b";
const bridgeSpan = otelTrace.wrapSpanContext({ traceId: bridgeTraceId, spanId: bridgeSpanId, traceFlags: TraceFlags.SAMPLED });
otelContext.with(otelTrace.setSpan(otelContext.active(), bridgeSpan), () => {
  assert.equal(currentTraceparent(), `00-${bridgeTraceId}-${bridgeSpanId}-01`, "active span → W3C traceparent");
});
assert.equal(currentTraceparent(), undefined, "traceparent is scoped to the active span");

const invalidSpan = otelTrace.wrapSpanContext(INVALID_SPAN_CONTEXT);
otelContext.with(otelTrace.setSpan(otelContext.active(), invalidSpan), () => {
  assert.equal(currentTraceparent(), undefined, "invalid span context → no traceparent");
});

// --- db indexer: batching, tracing suppression, and a missing mysql2 ---
// Runs last on purpose: it needs the real context manager installed above.
const DB_ENV = {
  JAYTRACE_DB_HOST: "db.internal",
  JAYTRACE_DB_USER: "jaytrace",
  JAYTRACE_DB_PASSWORD: "secret",
  JAYTRACE_DB_DATABASE: "example-org",
  JAYTRACE_DB_BATCH_SIZE: "2"
};

assert.equal(createNodeDbIndexer({}), null, "no JAYTRACE_DB_* env → no indexer");

const queries: Array<{ sql: string; params: unknown[]; suppressed: boolean }> = [];
const fakePool: DbIndexerPool = {
  execute(sql, params) {
    queries.push({ sql, params, suppressed: isTracingSuppressed(otelContext.active()) });
    return Promise.resolve([]);
  }
};
let poolConfig: DbIndexerPoolConfig | undefined;
const indexer = createNodeDbIndexer(DB_ENV, async () => ({
  createPool(config) {
    poolConfig = config;
    return fakePool;
  }
}));
assert.ok(indexer, "JAYTRACE_DB_* env → indexer");

const timelineDoc = {
  schema: "jaytrace.timeline.v1",
  traceId: "t1",
  sessionId: "sess-1",
  service: "shop-api",
  side: "back",
  summary: "GET /users/:id 500",
  user: { id: "u-1", name: "jay" },
  error: { name: "Error", message: "boom" },
  startedAt: "2026-08-04T00:00:00.000Z",
  endedAt: "2026-08-04T00:00:01.000Z"
};

indexer.indexDocument({ key: "stage/2026/08/04/t1/back-a.json", side: "back-shop-api", document: timelineDoc });
assert.equal(queries.length, 0, "one row does not reach the batch size yet");

// Second row fills the batch (JAYTRACE_DB_BATCH_SIZE=2) and flushes without waiting for the timer.
indexer.indexDocument({
  key: "stage/2026/08/04/t2/back-b.json",
  side: "back-shop-api",
  document: { ...timelineDoc, traceId: "t2", error: undefined, events: [{ severity: "warn" }] }
});
await indexer.drain();

assert.equal(queries.length, 1, "both rows go out as one multi-row INSERT");
const insert = queries[0];
assert.ok(insert?.sql.startsWith("INSERT INTO jaytrace_documents"), insert?.sql);
assert.equal(insert?.params.length, 28, "14 bound params per row");
// Never string-interpolated: the credentials-adjacent values only ever travel as params.
assert.equal((insert?.sql.match(/\?/g) ?? []).length, 28);
// The side column takes document.side ("back"), not the S3 filename stem ("back-shop-api"):
// the console pairs front/back documents on `side === "back"` exactly.
assert.deepEqual(insert?.params.slice(0, 8), [
  "t1",
  "sess-1",
  "u-1",
  "jay",
  "shop-api",
  "back",
  "jaytrace.timeline.v1",
  "error"
]);
assert.equal(insert?.params[21], "warning", "second row: warn event, no error → warning");
assert.equal(insert?.params[27], "stage/2026/08/04/t2/back-b.json");
assert.equal(poolConfig?.database, "example-org");
assert.equal(poolConfig?.port, 3306);

// mysql2 is instrumented in the host app: an INSERT that produced a span would feed itself
// (INSERT fails -> error document -> INSERT ...), so the call must run tracing-suppressed.
assert.equal(insert?.suppressed, true, "INSERT runs inside suppressTracing");

// A replay document carries flat user keys in metadata and is never a timeline.
queries.length = 0;
indexer.indexDocument({
  key: "k1",
  side: "replay-web",
  document: { schema: "jaytrace.replay.v2", traceId: "t3", metadata: { "user.id": "u-9", "user.name": "kim" } }
});
await indexer.drain();
assert.deepEqual(queries[0]?.params.slice(2, 4), ["u-9", "kim"]);
assert.equal(queries[0]?.params[7], "ok");
assert.equal(queries[0]?.params[5], "replay-web", "no document.side → the key stem stands in");

// One pool per process: the route-stats flusher and a second indexer reuse the first one, so a
// pod never holds more than DB_CONNECTION_LIMIT connections however many writers there are.
let extraPools = 0;
const secondIndexer = createNodeDbIndexer(DB_ENV, async () => ({
  createPool() {
    extraPools += 1;
    return fakePool;
  }
}));
secondIndexer?.indexDocument({ key: "k4", side: "back", document: timelineDoc });
await secondIndexer?.drain();
assert.equal(extraPools, 0, "the mysql pool is shared, not opened per writer");

// mysql2 absent: warn once, stay quiet, never throw at the caller or the drain.
// The pool memo has to go first, or the fake one above answers for the missing package.
resetSharedPool();
const stderrWrite = process.stderr.write.bind(process.stderr);
const warnings: string[] = [];
process.stderr.write = (chunk: string | Uint8Array): boolean => {
  warnings.push(String(chunk));
  return true;
};
const orphan = createNodeDbIndexer(DB_ENV, () =>
  Promise.reject(Object.assign(new Error("Cannot find package 'mysql2'"), { code: "ERR_MODULE_NOT_FOUND" }))
);
assert.doesNotThrow(() => orphan?.indexDocument({ key: "k2", side: "back", document: timelineDoc }));
await orphan?.drain();
orphan?.indexDocument({ key: "k3", side: "back", document: timelineDoc });
await orphan?.drain();
process.stderr.write = stderrWrite;
assert.deepEqual(warnings, ["[jaytrace] db indexer disabled: mysql2 not installed\n"], warnings.join(""));

// --- route stats: per-route latency histogram, upserted as pod-owned rows ---
// Also runs after the context manager is installed: the queries must be tracing-suppressed.
resetSharedPool();

const statsQueries: Array<{ sql: string; params: unknown[]; suppressed: boolean }> = [];
const statsPool: DbIndexerPool = {
  execute(sql, params) {
    statsQueries.push({ sql, params, suppressed: isTracingSuppressed(otelContext.active()) });
    return Promise.resolve([]);
  }
};
const statsLoader = async () => ({ createPool: () => statsPool });

// Off without a database, and off on request even with one.
assert.equal(createRouteStats({ env: {} }), null, "no JAYTRACE_DB_* env → no stats");
assert.equal(createRouteStats({ env: { ...DB_ENV, JAYTRACE_STATS: "0" } }), null, "JAYTRACE_STATS=0 → off");

// Bucket bounds are inclusive; the 15th slot catches everything past the last bound.
assert.equal(LATENCY_BUCKETS_MS.length, 14, "14 bounds + 1 overflow slot = 15 counts");
assert.equal(bucketIndex(0), 0);
assert.equal(bucketIndex(1), 0);
assert.equal(bucketIndex(1.5), 1);
assert.equal(bucketIndex(100), 6);
assert.equal(bucketIndex(30000), 13);
assert.equal(bucketIndex(30001), 14);

const HOUR_MS = 60 * 60 * 1000;
let statsNow = Date.UTC(2026, 7, 14, 10, 30, 0);
const stats = createRouteStats({
  env: { ...DB_ENV, HOSTNAME: "sample-shop-api-7d9" },
  load: statsLoader,
  now: () => statsNow
});
assert.ok(stats, "JAYTRACE_DB_* env → stats");

stats.record("shop-api", "/users/:id", 1, false);
stats.record("shop-api", "/users/:id", 1.5, false);
stats.record("shop-api", "/users/:id", 30000, true);
stats.record("shop-api", "/users/:id", 30001, false);
stats.record("shop-api", undefined, 5, false);
await stats.flush();

assert.equal(statsQueries.length, 2, "table created once, then one upsert");
assert.ok(statsQueries[0]?.sql.startsWith("CREATE TABLE IF NOT EXISTS jaytrace_route_stats"), statsQueries[0]?.sql);
const upsert = statsQueries[1];
assert.ok(upsert?.sql.startsWith("INSERT INTO jaytrace_route_stats"), upsert?.sql);
assert.ok(upsert?.sql.includes("ON DUPLICATE KEY UPDATE"), upsert?.sql);
assert.equal(upsert?.params.length, 16, "8 bound params per row, two routes");
assert.equal((upsert?.sql.match(/\?/g) ?? []).length, 16);
assert.deepEqual(upsert?.params.slice(0, 8), [
  "shop-api",
  "/users/:id",
  Date.UTC(2026, 7, 14, 10, 0, 0) / 1000, // window_start: the UTC hour, as epoch seconds
  "sample-shop-api-7d9",
  4,
  1,
  60003.5,
  "[1,1,0,0,0,0,0,0,0,0,0,0,0,1,1]"
]);
assert.equal(upsert?.params[9], "__unknown__", "an underivable route is counted, not dropped");
// The host app instruments mysql2: an unsuppressed query of ours would trace itself into a loop.
assert.equal(statsQueries[0]?.suppressed, true, "CREATE TABLE runs inside suppressTracing");
assert.equal(statsQueries[1]?.suppressed, true, "UPSERT runs inside suppressTracing");

await stats.flush();
assert.equal(statsQueries.length, 2, "a window with nothing new is not rewritten");

// Past 200 distinct routes in one window everything collapses into __other__.
statsQueries.length = 0;
for (let index = 0; index < 250; index += 1) {
  stats.record("shop-api", `/r/${index}`, 10, false);
}
await stats.flush();
const cappedRows: unknown[][] = [];
const cappedParams = statsQueries[0]?.params ?? [];
for (let index = 0; index < cappedParams.length; index += 8) {
  cappedRows.push(cappedParams.slice(index, index + 8));
}
// The window already held 2 routes, so 198 of the 250 fit under the cap and 52 land in __other__.
assert.equal(cappedRows.length, 199);
assert.equal(cappedRows.filter((row) => row[1] === "__other__").length, 1);
assert.equal(cappedRows.find((row) => row[1] === "__other__")?.[4], 52, "overflow routes are summed, not dropped");

// A new hour opens a new window; windows past the keep range are dropped once flushed.
assert.equal(stats.windowCount(), 1);
statsNow += HOUR_MS;
stats.record("shop-api", "/users/:id", 10, false);
assert.equal(stats.windowCount(), 2);
await stats.flush();
assert.equal(stats.windowCount(), 2, "the previous window is still inside the keep range");
statsNow += 3 * HOUR_MS;
stats.record("shop-api", "/users/:id", 10, false);
await stats.flush();
assert.equal(stats.windowCount(), 1, "windows past the keep range leave memory");
assert.equal(statsQueries.at(-1)?.params[2], Date.UTC(2026, 7, 14, 14, 0, 0) / 1000, "rotated window_start");
stats.stop();

// A rejected query warns once and drops the window — it must never reach the request path.
resetSharedPool();
const statsWarnings: string[] = [];
process.stderr.write = (chunk: string | Uint8Array): boolean => {
  statsWarnings.push(String(chunk));
  return true;
};
const failing = createRouteStats({
  env: DB_ENV,
  load: async () => ({ createPool: () => ({ execute: () => Promise.reject(new Error("connect ECONNREFUSED")) }) })
});
failing?.record("shop-api", "/x", 5, false);
await failing?.flush();
failing?.record("shop-api", "/x", 5, false);
await failing?.flush();
failing?.stop();

// mysql2 absent: warn once, then stay off for good.
resetSharedPool();
const orphanStats = createRouteStats({
  env: DB_ENV,
  load: () => Promise.reject(Object.assign(new Error("Cannot find package 'mysql2'"), { code: "ERR_MODULE_NOT_FOUND" }))
});
orphanStats?.record("shop-api", "/x", 5, false);
await orphanStats?.flush();
orphanStats?.record("shop-api", "/x", 5, false);
await orphanStats?.flush();
orphanStats?.stop();
process.stderr.write = stderrWrite;
assert.deepEqual(
  statsWarnings,
  [
    "[jaytrace] route stats flush failed: Error: connect ECONNREFUSED\n",
    "[jaytrace] db indexer disabled: mysql2 not installed\n"
  ],
  statsWarnings.join("")
);

console.log("[jaytrace/node] self-check ok");
