import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { NotFoundException } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  propagation as otelPropagation,
  trace as otelTrace,
  type Span,
  type Tracer
} from "@opentelemetry/api";
import { createTimelineEvent } from "@jaytrace/core";
import { firstValueFrom, of, throwError } from "rxjs";

import { JayTraceContextService, createRequestContext, nodeRuntime, readSessionHeader, recordQuery } from "./context.js";
import { JayTraceExceptionFilter } from "./jaytrace.exception-filter.js";
import { JayTraceInterceptor } from "./jaytrace.interceptor.js";
import { JayTraceMiddleware, bodyAttribute } from "./jaytrace.middleware.js";
import { JayTraceRpcInterceptor } from "./jaytrace.rpc-interceptor.js";
import { JayTraceHealthController } from "./jaytrace.health-controller.js";
import { JayTraceMetrics } from "./jaytrace.metrics.js";
import { JayTraceModule, resolveJayTraceEnvOptions } from "./jaytrace.module.js";
import { JayTraceRumController } from "./jaytrace.rum-controller.js";
import { buildS3Key } from "./s3-key.js";
import { S3JayTraceExporter } from "./s3-exporter.js";
import { JAYTRACE_EXPORTER, JAYTRACE_OPTIONS } from "./tokens.js";
import type { ExportInput, HttpLikeResponse, JayTraceModuleOptions, JayTraceRequestContext } from "./types.js";

const key = buildS3Key({
  prefix: "prod",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  side: "back",
  timestamp: new Date("2026-07-01T12:34:56.789Z")
});
assert(key === "prod/2026/07/01/4bf92f3577b34da6a3ce929d0e0e4736/back-2026-07-01T12-34-56-789Z.json", "s3 key format");
const replayKey = buildS3Key({
  prefix: "prod",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  side: "replay-web",
  timestamp: new Date("2026-07-01T12:34:56.789Z")
});
assert(replayKey === "prod/2026/07/01/4bf92f3577b34da6a3ce929d0e0e4736/replay-web-2026-07-01T12-34-56-789Z.json", "replay s3 key format");

const asyncModule = JayTraceModule.forRootAsync({
  inject: ["CONFIG"],
  useFactory: () => ({
    apiKey: "server-key",
    s3: {
      bucket: "bucket",
      region: "us-east-1"
    }
  })
});
assert(Boolean(asyncModule.providers?.some(provider => typeof provider === "object" && "provide" in provider && provider.provide === JAYTRACE_OPTIONS)), "async options provider");
assert(Boolean(asyncModule.providers?.some(provider => typeof provider === "object" && "provide" in provider && provider.provide === JAYTRACE_EXPORTER)), "async exporter provider");
assert(!asyncModule.providers?.some(provider => typeof provider === "object" && "provide" in provider && provider.provide === APP_FILTER), "module does not override app exception filters");

const contextService = new JayTraceContextService();
const requestContext = createRequestContext(
  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  "POST",
  "/api/pay"
);

const document = contextService.run(requestContext, () => {
  contextService.setContext({ tenantId: "tenant-1", "user.id": "user-1", token: "secret" });
  contextService.addEvent("db", "db payment.create failed P2002", "error");
  return contextService.createBackDocument(
    {
      apiKey: "server-key",
      service: "api",
      environment: "prod",
      s3: {
        bucket: "bucket",
        region: "us-east-1",
        prefix: "prod"
      }
    },
    {
      name: "PrismaClientKnownRequestError",
      message: "Unique constraint failed",
      code: "P2002"
    },
    500
  );
});

assert(document?.traceId === "4bf92f3577b34da6a3ce929d0e0e4736", "context traceId");
if (!document) {
  throw new Error("self-check failed: document missing");
}
assert(document.timeline.some((line) => line.includes("db payment.create failed P2002")), "backend timeline");
assert(document.context?.statusCode === 500, "status context");
assert(document.context?.tenantId === "tenant-1", "custom context");
assert(document.context?.["user.id"] === "user-1", "custom user context");
assert(document.context?.token === "redacted", "custom context redacted");
assert(document.context?.route === "/api/pay", "base route context wins");

const middlewareContext = new JayTraceContextService();
const middleware = new JayTraceMiddleware(middlewareContext, {
  apiKey: "server-key",
  captureBody: { maxBytes: 64 },
  slowRequestThresholdMs: 5,
  slowQueryThresholdMs: 3,
  s3: { bucket: "bucket", region: "us-east-1" }
});
let responseTraceparent = "";
let responseWritten: unknown;
let finishResponse: (() => void) | undefined;
let middlewareRequestContext: JayTraceRequestContext | undefined;
const middlewareResponse: HttpLikeResponse = {
  setHeader(name, value) {
    if (name.toLowerCase() === "traceparent") {
      responseTraceparent = value;
    }
  },
  on(_event, listener) {
    finishResponse = listener;
  },
  json(body) {
    return this.send?.(JSON.stringify(body));
  },
  send(body) {
    responseWritten = body;
    return this;
  }
};
middleware.use(
  {
    method: "POST",
    url: "/api/pay",
    body: { password: "secret", ok: true },
    headers: {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    }
  },
  middlewareResponse,
  () => {
    const active = middlewareContext.get();
    assert(active?.traceId === "4bf92f3577b34da6a3ce929d0e0e4736", "middleware keeps incoming trace id");
    assert(active?.traceparent === responseTraceparent, "middleware echoes active traceparent");
    middlewareRequestContext = active;
    if (active) {
      active.startedAt = new Date(Date.now() - 20);
    }
    recordQuery("SELECT * FROM payments WHERE id = ?", {
      params: { password: "secret", id: 42 },
      durationMs: 4
    });
    middlewareResponse.json?.({ token: "secret", payload: "x".repeat(100) });
    finishResponse?.();
  }
);
const middlewareRequestEvent = middlewareRequestContext?.events[0];
const capturedRequestBody = middlewareRequestEvent?.data?.requestBody as { password?: unknown } | undefined;
assert(capturedRequestBody?.password === "redacted", "middleware redacts captured request body");
assert(
  typeof middlewareRequestEvent?.data?.responseBody === "string" &&
    middlewareRequestEvent.data.responseBody.endsWith("[truncated]") &&
    !middlewareRequestEvent.data.responseBody.includes("secret"),
  "middleware redacts and truncates captured response body"
);
assert(typeof responseWritten === "string" && responseWritten.includes("secret"), "middleware does not alter response body");
assert((middlewareRequestEvent?.durationMs ?? 0) >= 5, "middleware records request duration");
assert(middlewareRequestEvent?.slow === true, "middleware marks slow request");
const queryEvent = middlewareRequestContext?.events.find(event => event.kind === "db");
const queryParams = queryEvent?.data?.params as { password?: unknown } | undefined;
assert(queryParams?.password === "redacted", "recordQuery redacts params");
assert(queryEvent?.durationMs === 4 && queryEvent.slow === true, "recordQuery records duration and slow marker");

contextService.run(createRequestContext(undefined, "GET", "/dupe"), () => {
  assert(contextService.claimBackExport(), "first back export allowed");
  assert(!contextService.claimBackExport(), "duplicate back export blocked");
});

// x-jaytrace-session propagation: a valid header rides into the back document,
// a malformed/hostile header is dropped before it can be persisted.
const sessionContextService = new JayTraceContextService();
const validSessionContext = createRequestContext(undefined, "GET", "/s", {}, readSessionHeader({ "x-jaytrace-session": "sess_ABC-123456" }));
assert(validSessionContext.sessionId === "sess_ABC-123456", "valid session header captured on context");
const sessionDoc = sessionContextService.run(validSessionContext, () =>
  sessionContextService.createBackDocument({ apiKey: "server-key", s3: { bucket: "bucket", region: "us-east-1" } })
);
assert(sessionDoc?.sessionId === "sess_ABC-123456", "back document stamps inherited session id");
const badSessionContext = createRequestContext(undefined, "GET", "/s", {}, readSessionHeader({ "x-jaytrace-session": "<script>alert(1)</script>" }));
assert(badSessionContext.sessionId === undefined, "malformed session header ignored");

const exported: ExportInput[] = [];
const filterContext = new JayTraceContextService();
const filter = new JayTraceExceptionFilter(
  filterContext,
  {
    apiKey: "server-key",
    apiKeys: ["local-dev-key"],
    service: "api",
    environment: "prod",
    s3: {
      bucket: "bucket",
      region: "us-east-1",
      prefix: "prod"
    }
  },
  {
    export(input: ExportInput) {
      exported.push(input);
    }
  }
);
let notFoundBody: unknown;
filterContext.run(createRequestContext(undefined, "GET", "/favicon.ico"), () => {
  filter.catch(new NotFoundException("Cannot GET /favicon.ico"), {
    switchToHttp: () => ({
      getResponse: () => ({
        statusCode: 200,
        json: (body: unknown) => {
          notFoundBody = body;
        }
      })
    })
  } as never);
});
assert(exported.length === 0, "4xx http exception not exported as backend error");
assert((notFoundBody as { statusCode?: number }).statusCode === 404, "4xx response preserved");

const interceptor = new JayTraceInterceptor(filterContext, {
  apiKey: "server-key",
  service: "api",
  environment: "prod",
  s3: {
    bucket: "bucket",
    region: "us-east-1",
    prefix: "prod"
  }
}, {
  export(input: ExportInput) {
    exported.push(input);
  }
});
try {
  await firstValueFrom(interceptor.intercept({
    switchToHttp: () => ({
      getRequest: () => ({ method: "GET", url: "/favicon.ico", headers: {} }),
      getResponse: () => ({ statusCode: 200 })
    })
  } as never, {
    handle: () => throwError(() => new NotFoundException("Cannot GET /favicon.ico"))
  }));
} catch {
  // expected: interceptor observes the 404 but does not handle the response.
}
assert(exported.length === 0, "4xx interceptor error not exported as backend error");

try {
  await firstValueFrom(interceptor.intercept({
    switchToHttp: () => ({
      getRequest: () => ({ method: "POST", url: "/api/pay", headers: {} }),
      // Express default before the exception filter runs: statusCode is still 200.
      getResponse: () => ({ statusCode: 200 })
    })
  } as never, {
    handle: () => throwError(() => {
      const error = new Error("Unique constraint failed");
      error.name = "PrismaClientKnownRequestError";
      return error;
    })
  }));
} catch {
  // expected: interceptor observes the error but does not handle the response.
}
assert(exported.length === 1, "plain 5xx error exported despite response.statusCode still 200");
assert(exported[0]?.side === "back", "plain 5xx error exported as back document");
const plainErrorDocument = exported[0]?.document;
assert(
  plainErrorDocument?.schema === "jaytrace.timeline.v1" && plainErrorDocument.context?.statusCode === 500,
  "plain 5xx error exported with statusCode 500"
);
exported.length = 0;

const rumController = new JayTraceRumController(
  {
    apiKey: "server-key",
    apiKeys: ["local-dev-key"],
    service: "api",
    environment: "prod",
    maxRumPayloadBytes: 1024,
    maxRumEvents: 2,
    s3: {
      bucket: "bucket",
      region: "us-east-1",
      prefix: "prod"
    }
  },
  {
    export(input: ExportInput) {
      exported.push(input);
    }
  }
);

rumController.ingest({
  apiKey: "server-key",
  reason: "error",
  document: {
    schema: "jaytrace.timeline.v1",
    service: "web",
    side: "front",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    startedAt: "2026-07-01T12:34:56.789Z",
    summary: "front failed",
    timeline: ["0.000s error front failed"]
  }
});
assert(exported.length === 1 && exported[0]?.side === "front", "rum timeline export");

rumController.ingest({
  apiKey: "local-dev-key",
  reason: "error",
  document: {
    schema: "jaytrace.timeline.v1",
    service: "web",
    side: "front",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    startedAt: "2026-07-01T12:34:56.789Z",
    summary: "front failed",
    timeline: ["0.000s error front failed"]
  }
});
assert(exported.length === 2 && exported[1]?.side === "front", "rum apiKeys allowlisted export");

new JayTraceRumController(
  {
    apiKey: "server-key",
    service: "api",
    environment: "prod",
    s3: {
      bucket: "bucket",
      region: "us-east-1",
      prefix: "prod"
    }
  },
  {
    export(input: ExportInput) {
      exported.push(input);
    }
  }
).ingest({
  apiKey: "server-key",
  reason: "error",
  document: {
    schema: "jaytrace.replay.v1",
    platform: "web",
    traceId: "11111111111111111111111111111111",
    mode: "on-error",
    startedAt: "2026-07-01T12:34:56.789Z",
    events: ["0.000s error large dom"],
    frames: [{ at: "0.000s", kind: "error", text: "large dom", html: "x".repeat(300 * 1024) }]
  }
});
assert(exported.at(-1)?.side === "replay-web", "default rum payload accepts dom replay frame");

await assertThrows(() =>
  rumController.ingest({
    apiKey: "server-key",
    reason: "error",
    document: {
      schema: "jaytrace.timeline.v1",
      service: "web",
      side: "front",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      startedAt: "2026-07-01T12:34:56.789Z",
      summary: "x".repeat(1500),
      timeline: ["0.000s error front failed"]
    }
  }),
  "reject oversized rum payload"
);

await assertThrows(() =>
  rumController.ingest({
    apiKey: "wrong-key",
    reason: "error",
    document: {
      schema: "jaytrace.timeline.v1",
      service: "web",
      side: "front",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      startedAt: "2026-07-01T12:34:56.789Z",
      summary: "front failed",
      timeline: ["0.000s error front failed"]
    }
  }),
  "reject api key"
);

await assertThrows(() =>
  rumController.ingest({
    apiKey: "server-key",
    reason: "error",
    document: {
      schema: "jaytrace.timeline.v1",
      service: "web",
      side: "front",
      traceId: "not-a-trace-id",
      startedAt: "2026-07-01T12:34:56.789Z",
      summary: "front failed",
      timeline: ["0.000s error front failed"]
    }
  }),
  "reject invalid traceId"
);

await assertThrows(() =>
  rumController.ingest({
    apiKey: "server-key",
    reason: "error",
    document: {
      schema: "jaytrace.replay.v1",
      platform: "web",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      mode: "on-error",
      startedAt: "2026-07-01T12:34:56.789Z",
      events: ["0.000s click a", "0.001s click b", "0.002s click c"]
    }
  }),
  "reject too many replay events"
);

await assertThrows(() =>
  rumController.ingest({
    apiKey: "server-key",
    reason: "error",
    document: {
      schema: "jaytrace.replay.v1",
      platform: "web",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      mode: "on-error",
      startedAt: "2026-07-01T12:34:56.789Z",
      events: ["0.000s click a"],
      frames: [
        { at: "0.000s", kind: "click", text: "click a" },
        { at: "0.001s", kind: "click", text: "click b" },
        { at: "0.002s", kind: "click", text: "click c" }
      ]
    }
  }),
  "reject too many replay frames"
);

await assertThrows(() =>
  rumController.ingest({
    apiKey: "server-key",
    reason: "error",
    document: {
      schema: "jaytrace.replay.v1",
      platform: "web",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      mode: "on-error",
      startedAt: "2026-07-01T12:34:56.789Z",
      events: ["0.000s click a"],
      frames: [
        { at: "0.000s", kind: "click", text: 123 }
      ]
    } as unknown as Parameters<JayTraceRumController["ingest"]>[0]["document"]
  }),
  "reject invalid replay frame shape"
);

await assertThrows(() =>
  rumController.ingest({
    apiKey: "server-key",
    reason: "error",
    document: {
      schema: "jaytrace.replay.v1",
      platform: "web",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      mode: "on-error",
      startedAt: "2026-07-01T12:34:56.789Z",
      events: ["0.000s click a"],
      frames: [
        { at: "0.000s", kind: "click", text: "click a", image: "https://example.test/screen.png" }
      ]
    }
  }),
  "reject remote replay image"
);

await assertThrows(() =>
  rumController.ingest({
    apiKey: "server-key",
    reason: "error",
    document: {
      schema: "jaytrace.replay.v1",
      platform: "web",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      mode: "on-error",
      startedAt: "2026-07-01T12:34:56.789Z",
      events: ["0.000s mutation a"],
      mutations: [
        { at: "0.000s", target: "body", type: "childList" },
        { at: "0.001s", target: "main", type: "childList" },
        { at: "0.002s", target: "button", type: "attributes", attributeName: "disabled", value: "" }
      ]
    }
  }),
  "reject too many replay mutations"
);

const replayExports: ExportInput[] = [];
const screenshotReplayController = new JayTraceRumController(
  {
    apiKey: "server-key",
    service: "api",
    environment: "prod",
    maxRumPayloadBytes: 100 * 1024,
    maxRumEvents: 10,
    s3: {
      bucket: "bucket",
      region: "us-east-1",
      prefix: "prod"
    }
  },
  {
    export(input: ExportInput) {
      replayExports.push(input);
    }
  }
);
screenshotReplayController.ingest({
  apiKey: "server-key",
  reason: "error",
  document: {
    schema: "jaytrace.replay.v1",
    platform: "web",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    mode: "on-error",
    startedAt: "2026-07-01T12:34:56.789Z",
    events: ["0.000s viewport 1440x900 /checkout", "0.100s error payment failed"],
    frames: [
      {
        at: "0.100s",
        kind: "error",
        text: "error payment failed",
        type: "image",
        image: `data:image/png;base64,${"a".repeat(60_000)}`,
        width: 390,
        height: 844
      }
    ]
  }
});
assert(replayExports.length === 1 && replayExports[0]?.side === "replay-web", "screenshot replay export");

for (const platform of ["react-native", "flutter"] as const) {
  screenshotReplayController.ingest({
    apiKey: "server-key",
    reason: "error",
    document: {
      schema: "jaytrace.replay.v1",
      platform,
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      mode: "on-error",
      startedAt: "2026-07-01T12:34:56.789Z",
      events: [`0.000s error ${platform} payment failed`],
      frames: [
        {
          at: "0.000s",
          kind: "error",
          text: `error ${platform} payment failed`,
          type: "image",
          image: "data:image/png;base64,c2NyZWVu",
          width: 390,
          height: 844
        }
      ]
    }
  });
}
assert(
  replayExports.some(input => input.side === "replay-react-native") &&
    replayExports.some(input => input.side === "replay-flutter"),
  "mobile screenshot replay exports"
);

const rateLimitedController = new JayTraceRumController(
  {
    apiKey: "server-key",
    maxRumPayloadBytes: 2048,
    maxRumEvents: 10,
    rumRateLimit: {
      maxRequests: 1,
      windowMs: 60_000
    },
    s3: {
      bucket: "bucket",
      region: "us-east-1"
    }
  },
  {
    export() {}
  }
);
rateLimitedController.ingest({
  apiKey: "server-key",
  reason: "error",
  document: {
    schema: "jaytrace.timeline.v1",
    service: "web",
    side: "front",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    startedAt: "2026-07-01T12:34:56.789Z",
    summary: "front failed",
    timeline: ["0.000s error front failed"]
  }
});
await assertThrows(() =>
  rateLimitedController.ingest({
    apiKey: "server-key",
    reason: "error",
    document: {
      schema: "jaytrace.timeline.v1",
      service: "web",
      side: "front",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      startedAt: "2026-07-01T12:34:56.789Z",
      summary: "front failed again",
      timeline: ["0.000s error front failed again"]
    }
  }),
  "reject rate limited trace"
);

const bucketLimitedController = new JayTraceRumController(
  {
    apiKey: "server-key",
    rumRateLimit: {
      maxBuckets: 1,
      maxRequests: 10,
      windowMs: 60_000
    },
    s3: {
      bucket: "bucket",
      region: "us-east-1"
    }
  },
  {
    export() {}
  }
);
bucketLimitedController.ingest({
  apiKey: "server-key",
  reason: "error",
  document: {
    schema: "jaytrace.timeline.v1",
    service: "web",
    side: "front",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    startedAt: "2026-07-01T12:34:56.789Z",
    summary: "front failed",
    timeline: ["0.000s error front failed"]
  }
});
await assertThrows(() =>
  bucketLimitedController.ingest({
    apiKey: "server-key",
    reason: "error",
    document: {
      schema: "jaytrace.timeline.v1",
      service: "web",
      side: "front",
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      startedAt: "2026-07-01T12:34:56.789Z",
      summary: "front failed second trace",
      timeline: ["0.000s error front failed second trace"]
    }
  }),
  "reject rate bucket capacity"
);

const spoolDir = await mkdtemp(join(tmpdir(), "jaytrace-self-check-"));
const exporter = new S3JayTraceExporter({
  apiKey: "server-key",
  service: "api",
  environment: "prod",
  spoolDir,
  s3: {
    bucket: "bucket",
    region: "us-east-1",
    prefix: "prod"
  }
});

const sentCommands: unknown[] = [];
(exporter as unknown as { client: { send: (command: unknown) => Promise<never> } }).client = {
  send: async (command: unknown) => {
    sentCommands.push(command);
    throw new Error("forced upload failure");
  }
};

exporter.export({
  side: "back",
  document: {
    schema: "jaytrace.timeline.v1",
    service: "api",
    side: "back",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    startedAt: "2026-07-01T12:34:56.789Z",
    endedAt: "2026-07-01T12:34:56.789Z",
    summary: "forced failure",
    timeline: [createTimelineEvent({ at: "0.000s", kind: "error", text: "forced failure", severity: "error" })].map(
      (event) => `${event.at} ${event.kind} ${event.severity} ${event.text}`
    )
  }
});

exporter.export({
  side: "replay-web",
  document: {
    schema: "jaytrace.replay.v1",
    platform: "web",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    mode: "on-error",
    startedAt: "2026-07-01T12:34:56.789Z",
    endedAt: "2026-07-01T12:34:56.789Z",
    events: ["0.000s viewport 1440x900 /checkout", "0.100s error forced failure"]
  }
});

await waitForSpool();
await waitForSpool(replayKey, "jaytrace.replay.v1");
assert(
  sentCommands.some(command => (command as { input?: { ServerSideEncryption?: string } }).input?.ServerSideEncryption === "AES256"),
  "s3 put uses default SSE"
);

const backpressureKey = buildS3Key({
  prefix: "prod",
  environment: "prod",
  traceId: "11111111111111111111111111111111",
  side: "front",
  timestamp: new Date("2026-07-01T12:35:00.000Z")
});
const backpressureExporter = new S3JayTraceExporter({
  apiKey: "server-key",
  service: "api",
  environment: "prod",
  spoolDir,
  maxInFlightExports: 1,
  s3: {
    bucket: "bucket",
    region: "us-east-1",
    prefix: "prod"
  }
});
let releaseUpload!: () => void;
(backpressureExporter as unknown as { client: { send: () => Promise<void> } }).client = {
  send: () => new Promise<void>(resolve => {
    releaseUpload = resolve;
  })
};
const backpressureDocument = {
  schema: "jaytrace.timeline.v1" as const,
  service: "web",
  side: "front" as const,
  traceId: "11111111111111111111111111111111",
  startedAt: "2026-07-01T12:35:00.000Z",
  endedAt: "2026-07-01T12:35:00.000Z",
  summary: "backpressure",
  timeline: ["0.000s error backpressure"]
};
backpressureExporter.export({ side: "front", document: backpressureDocument });
backpressureExporter.export({ side: "front", document: backpressureDocument });
await waitForSpool(backpressureKey, "backpressure", "in-flight export limit exceeded");
releaseUpload();
assert((backpressureExporter as unknown as { inFlight: number }).inFlight <= 1, "s3 exporter caps in-flight uploads");

await rm(spoolDir, { recursive: true, force: true });

// onExported hook: fires on upload success with { key, side, document }, and a
// throwing hook is isolated so it never breaks export.
{
  const hookCalls: Array<{ key: string; side: string; document: Record<string, unknown> }> = [];
  const hookExporter = new S3JayTraceExporter({
    apiKey: "server-key",
    service: "api",
    environment: "prod",
    s3: { bucket: "bucket", region: "us-east-1", prefix: "prod" },
    onExported: (info) => {
      hookCalls.push(info);
    }
  });
  (hookExporter as unknown as { client: { send: () => Promise<void> } }).client = {
    send: async () => {}
  };
  const hookDocument = {
    schema: "jaytrace.timeline.v1" as const,
    service: "api",
    side: "back" as const,
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    startedAt: "2026-07-01T12:34:56.789Z",
    endedAt: "2026-07-01T12:34:56.789Z",
    summary: "hook document",
    timeline: ["0.000s log ok"]
  };
  hookExporter.export({ side: "back", document: hookDocument });
  for (let attempt = 0; attempt < 20 && hookCalls.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(hookCalls.length === 1, "onExported hook fires on upload success");
  assert(hookCalls[0]?.side === "back", "onExported hook receives side");
  assert(
    typeof hookCalls[0]?.key === "string" && hookCalls[0].key.includes("4bf92f3577b34da6a3ce929d0e0e4736"),
    "onExported hook receives s3 key"
  );
  assert(
    (hookCalls[0]?.document as { traceId?: string })?.traceId === "4bf92f3577b34da6a3ce929d0e0e4736",
    "onExported hook receives document"
  );

  // A throwing hook must not break export (the upload still counts as sent).
  const throwMetrics = new JayTraceMetrics();
  const throwExporter = new S3JayTraceExporter(
    {
      apiKey: "server-key",
      service: "api",
      s3: { bucket: "bucket", region: "us-east-1", prefix: "prod" },
      onExported: () => {
        throw new Error("hook boom");
      }
    },
    throwMetrics
  );
  (throwExporter as unknown as { client: { send: () => Promise<void> } }).client = {
    send: async () => {}
  };
  throwExporter.export({ side: "back", document: hookDocument });
  for (let attempt = 0; attempt < 20 && throwMetrics.snapshot().export.sent === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(throwMetrics.snapshot().export.sent === 1, "throwing onExported hook does not break export");
}

// S3 gzip compression: upload() gzips the JSON body and sets ContentEncoding "gzip"
// by default; JAYTRACE_S3_GZIP=0 restores a plaintext body. The key stays *.json and
// ContentType is unchanged in both cases.
{
  const gzipDocument = {
    schema: "jaytrace.timeline.v1" as const,
    service: "api",
    side: "back" as const,
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    startedAt: "2026-07-01T12:34:56.789Z",
    endedAt: "2026-07-01T12:34:56.789Z",
    summary: "gzip document",
    timeline: ["0.000s log ok"]
  };

  const captureUpload = async (): Promise<{ input?: { Body?: unknown; ContentEncoding?: string; ContentType?: string; Key?: string } }> => {
    const exporter = new S3JayTraceExporter({
      apiKey: "server-key",
      service: "api",
      environment: "prod",
      s3: { bucket: "bucket", region: "us-east-1", prefix: "prod" }
    });
    let captured: unknown;
    (exporter as unknown as { client: { send: (command: unknown) => Promise<void> } }).client = {
      send: async (command: unknown) => {
        captured = command;
      }
    };
    exporter.export({ side: "back", document: gzipDocument });
    for (let attempt = 0; attempt < 20 && !captured; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!captured) {
      throw new Error("self-check failed: gzip upload command not captured");
    }
    return captured as { input?: { Body?: unknown } };
  };

  const gzipCommand = await captureUpload();
  const gzipBody = gzipCommand.input?.Body;
  assert(gzipCommand.input?.ContentEncoding === "gzip", "s3 put sets gzip ContentEncoding by default");
  assert(gzipCommand.input?.ContentType === "application/json; charset=utf-8", "s3 gzip put keeps json ContentType");
  assert(gzipCommand.input?.Key?.endsWith(".json") === true, "s3 gzip put keeps .json key");
  assert(gzipBody instanceof Uint8Array, "s3 gzip put body is binary");
  const roundTripped = JSON.parse(gunzipSync(gzipBody as Uint8Array).toString("utf8")) as { traceId?: string };
  assert(roundTripped.traceId === gzipDocument.traceId, "gzip body gunzips back to the original document");

  process.env.JAYTRACE_S3_GZIP = "0";
  const plainCommand = await captureUpload();
  delete process.env.JAYTRACE_S3_GZIP;
  assert(plainCommand.input?.ContentEncoding === undefined, "JAYTRACE_S3_GZIP=0 disables ContentEncoding");
  assert(typeof plainCommand.input?.Body === "string", "JAYTRACE_S3_GZIP=0 uploads plaintext body");
  assert(
    (JSON.parse(plainCommand.input?.Body as string) as { traceId?: string }).traceId === gzipDocument.traceId,
    "plaintext body parses back to the original document"
  );
}

// drain(): awaits all in-flight exports so a serverless host can guarantee
// export completion before responding. Export several docs, drain, then assert
// every upload landed and no queued/pending work remains.
{
  const drainExporter = new S3JayTraceExporter({
    apiKey: "server-key",
    service: "api",
    environment: "prod",
    s3: { bucket: "bucket", region: "us-east-1", prefix: "prod" }
  });
  const drainSent: unknown[] = [];
  (drainExporter as unknown as { client: { send: (command: unknown) => Promise<void> } }).client = {
    send: async (command: unknown) => {
      drainSent.push(command);
    }
  };
  const drainCount = 7;
  for (let i = 0; i < drainCount; i += 1) {
    drainExporter.export({
      side: "back",
      document: {
        schema: "jaytrace.timeline.v1",
        service: "api",
        side: "back",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        startedAt: "2026-07-01T12:34:56.789Z",
        endedAt: "2026-07-01T12:34:56.789Z",
        summary: `drain ${i}`,
        timeline: [`0.000s log drain ${i}`]
      }
    });
  }
  await drainExporter.drain();
  assert(drainSent.length === drainCount, "drain awaits every in-flight upload");
  assert((drainExporter as unknown as { queue: unknown[] }).queue.length === 0, "drain leaves queue empty");
  assert((drainExporter as unknown as { pending: Set<unknown> }).pending.size === 0, "drain leaves no pending work");
}

async function waitForSpool(expectedKey = key, expectedText = "forced failure", expectedError = "forced upload failure"): Promise<void> {
  const path = join(spoolDir, expectedKey);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const text = await readFile(path, "utf8");
      assert(text.includes(expectedError), "spool error");
      assert(text.includes(expectedText), "spool document");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("self-check failed: spool file missing");
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`self-check failed: ${message}`);
  }
}

// ingest() is async now, so its validation throws surface as rejected promises;
// await run() catches both sync throws and rejections.
async function assertThrows(run: () => unknown, message: string): Promise<void> {
  try {
    await run();
  } catch {
    return;
  }

  throw new Error(`self-check failed: ${message}`);
}

{
  const segKey = buildS3Key({
    prefix: "prod",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    side: "replay-web",
    timestamp: new Date("2026-07-01T12:34:56.789Z"),
    seq: 3
  });
  assert(segKey === "prod/2026/07/01/4bf92f3577b34da6a3ce929d0e0e4736/replay-web-2026-07-01T12-34-56-789Z-seq3.json", "v2 seq s3 key");

  const v2Exported: ExportInput[] = [];
  const v2Controller = new JayTraceRumController(
    { apiKey: "server-key", service: "api", s3: { bucket: "b", region: "r" } },
    { export(input: ExportInput) { v2Exported.push(input); } }
  );
  const v2Doc = {
    schema: "jaytrace.replay.v2",
    engine: "rrweb",
    platform: "web",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    sessionId: "s-v2",
    seq: 0,
    startedAt: "2026-07-01T12:00:00.000Z",
    endedAt: "2026-07-01T12:00:10.000Z",
    rrwebEvents: [{ type: 2, data: {}, timestamp: 1751371200000 }]
  };
  v2Controller.ingest({ apiKey: "server-key", reason: "manual", document: v2Doc } as never);
  assert(v2Exported.length === 1, "v2 segment exported");
  assert(v2Exported[0]?.side === "replay-web", "v2 side is replay-platform");
  assert(v2Exported[0]?.seq === 0, "v2 seq forwarded to exporter");

  let v2Rejected = false;
  try {
    await v2Controller.ingest({ apiKey: "server-key", reason: "manual", document: { ...v2Doc, seq: -1 } } as never);
  } catch { v2Rejected = true; }
  assert(v2Rejected, "invalid v2 segment rejected");
}

{
  const wireframeExported: ExportInput[] = [];
  const wireframeController = new JayTraceRumController(
    { apiKey: "server-key", service: "api", s3: { bucket: "b", region: "r" } },
    { export(input: ExportInput) { wireframeExported.push(input); } }
  );
  const wireframeDoc = {
    schema: "jaytrace.replay.v2",
    engine: "wireframe",
    platform: "flutter",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    sessionId: "s-wireframe",
    seq: 2,
    startedAt: "2026-07-01T12:00:00.000Z",
    endedAt: "2026-07-01T12:00:10.000Z",
    metadata: { token: "abc" },
    wireframeFrames: [
      {
        atMs: 0,
        viewport: { width: 390, height: 844 },
        nodes: [
          { type: "text", x: 0, y: 0, w: 10, h: 10, text: "secret-token-value" },
          // "Token: ..." matches core's content-based assignment regex — if redact()
          // ever walks into frames, this on-screen label would get mangled.
          { type: "text", x: 0, y: 12, w: 10, h: 10, text: "Token: abc123" }
        ]
      }
    ]
  };
  wireframeController.ingest({ apiKey: "server-key", reason: "manual", document: wireframeDoc } as never);
  assert(wireframeExported.length === 1, "wireframe segment exported");
  assert(wireframeExported[0]?.side === "replay-flutter", "wireframe side is replay-platform");
  assert(wireframeExported[0]?.seq === 2, "wireframe seq forwarded to exporter");
  const wireframeExportedDoc = wireframeExported[0]?.document as unknown as typeof wireframeDoc;
  assert(
    wireframeExportedDoc.wireframeFrames[0]?.nodes[0]?.text === "secret-token-value",
    "wireframe frame text not redacted"
  );
  assert(
    wireframeExportedDoc.wireframeFrames[0]?.nodes[1]?.text === "Token: abc123",
    "wireframe frame text resembling a secret assignment not mangled"
  );
  assert(
    (wireframeExportedDoc.metadata as Record<string, unknown>).token === "redacted",
    "wireframe metadata still redacted"
  );

  let missingFramesRejected = false;
  try {
    await wireframeController.ingest({
      apiKey: "server-key",
      reason: "manual",
      document: { ...wireframeDoc, wireframeFrames: undefined }
    } as never);
  } catch { missingFramesRejected = true; }
  assert(missingFramesRejected, "wireframe segment missing wireframeFrames rejected");

  const cappedWireframeController = new JayTraceRumController(
    { apiKey: "server-key", service: "api", maxRumReplayEvents: 2, s3: { bucket: "b", region: "r" } },
    { export() {} }
  );
  let overCapRejected = false;
  try {
    await cappedWireframeController.ingest({
      apiKey: "server-key",
      reason: "manual",
      document: {
        ...wireframeDoc,
        wireframeFrames: [wireframeDoc.wireframeFrames[0], wireframeDoc.wireframeFrames[0], wireframeDoc.wireframeFrames[0]]
      }
    } as never);
  } catch { overCapRejected = true; }
  assert(overCapRejected, "wireframe segment over maxRumReplayEvents cap rejected");
}

{
  const resolved = resolveJayTraceEnvOptions({
    JAYTRACE_API_KEY: "env-key",
    JAYTRACE_API_KEYS: "extra-a, extra-b",
    JAYTRACE_BUCKET: "env-bucket",
    AWS_REGION: "ap-northeast-2",
    NODE_ENV: "staging"
  });
  assert(resolved.apiKey === "env-key", "env apiKey");
  assert(JSON.stringify(resolved.apiKeys) === JSON.stringify(["extra-a", "extra-b"]), "env apiKeys csv");
  assert(resolved.service === "api", "env default service");
  assert(resolved.environment === "staging", "env environment from NODE_ENV");
  assert(resolved.s3.bucket === "env-bucket", "env bucket");
  assert(resolved.s3.region === "ap-northeast-2", "env region");
  assert(resolved.s3.prefix === "staging", "env prefix defaults to NODE_ENV");
  assert(resolved.captureBody === undefined, "env captureBody unset stays undefined");

  const captureBodyEnabled = resolveJayTraceEnvOptions({
    JAYTRACE_API_KEY: "env-key",
    JAYTRACE_BUCKET: "env-bucket",
    AWS_REGION: "ap-northeast-2",
    JAYTRACE_CAPTURE_BODY: "1"
  });
  assert(captureBodyEnabled.captureBody === true, "env captureBody=1 enables capture");

  const captureBodySized = resolveJayTraceEnvOptions({
    JAYTRACE_API_KEY: "env-key",
    JAYTRACE_BUCKET: "env-bucket",
    AWS_REGION: "ap-northeast-2",
    JAYTRACE_CAPTURE_BODY: "2048"
  });
  assert(
    typeof captureBodySized.captureBody === "object" && captureBodySized.captureBody.maxBytes === 2048,
    "env captureBody numeric sets maxBytes"
  );

  let missingError = "";
  try {
    resolveJayTraceEnvOptions({ JAYTRACE_API_KEY: "k" });
  } catch (error) {
    missingError = error instanceof Error ? error.message : String(error);
  }
  assert(missingError.includes("JAYTRACE_BUCKET"), "missing env error names JAYTRACE_BUCKET");
  assert(missingError.includes("AWS_REGION"), "missing env error names AWS_REGION");

  const zeroArgModule = JayTraceModule.forRoot(undefined, {
    JAYTRACE_API_KEY: "k",
    JAYTRACE_BUCKET: "b",
    AWS_REGION: "r"
  });
  assert(Array.isArray(zeroArgModule.providers), "zero-arg forRoot builds module");
}

// --- Track B: metrics + health endpoint ---
{
  const metrics = new JayTraceMetrics();
  metrics.inc("exportSent");
  metrics.inc("exportSent");
  metrics.inc("rumRateLimited");
  const snap = metrics.snapshot();
  assert(snap.export.sent === 2, "metrics counts exportSent");
  assert(snap.rum.rateLimited === 1, "metrics counts rumRateLimited");
  assert(snap.export.failed === 0 && snap.rum.accepted === 0, "metrics default zero");
  assert(metrics.startedAt instanceof Date, "metrics exposes startedAt");
}

{
  // Exporter with forced S3 failure → failed + spooled counters.
  const spoolDir = await mkdtemp(join(tmpdir(), "jaytrace-metrics-"));
  const metrics = new JayTraceMetrics();
  const exporter = new S3JayTraceExporter(
    {
      apiKey: "server-key",
      service: "api",
      environment: "prod",
      spoolDir,
      s3: { bucket: "bucket", region: "us-east-1", prefix: "prod" }
    },
    metrics
  );
  (exporter as unknown as { client: { send: () => Promise<never> } }).client = {
    send: async () => {
      throw new Error("forced upload failure");
    }
  };
  exporter.export({
    side: "back",
    document: {
      schema: "jaytrace.timeline.v1",
      service: "api",
      side: "back",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      startedAt: "2026-07-01T12:34:56.789Z",
      endedAt: "2026-07-01T12:34:56.789Z",
      summary: "forced failure",
      timeline: ["0.000s error forced failure"]
    }
  });
  for (let attempt = 0; attempt < 40 && metrics.snapshot().export.spooled < 1; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const exSnap = metrics.snapshot();
  assert(exSnap.export.failed >= 1, "exporter failure increments exportFailed");
  assert(exSnap.export.spooled >= 1, "exporter failure increments exportSpooled");
  assert(exSnap.export.sent === 0, "no exportSent on forced failure");
  await rm(spoolDir, { recursive: true, force: true });
}

{
  // Controller counters: accepted / rejected / rateLimited.
  const metrics = new JayTraceMetrics();
  const options: JayTraceModuleOptions = {
    apiKey: "server-key",
    service: "api",
    maxRumEvents: 10,
    rumRateLimit: { maxRequests: 1, windowMs: 60_000 },
    s3: { bucket: "bucket", region: "us-east-1" }
  };
  const controller = new JayTraceRumController(options, { export() {} }, metrics);
  const goodDoc = {
    apiKey: "server-key",
    reason: "error" as const,
    document: {
      schema: "jaytrace.timeline.v1" as const,
      service: "web",
      side: "front" as const,
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      startedAt: "2026-07-01T12:34:56.789Z",
      summary: "front failed",
      timeline: ["0.000s error front failed"]
    }
  };
  controller.ingest(goodDoc);
  await assertThrows(() => controller.ingest({ ...goodDoc, apiKey: "wrong-key" }), "controller rejects bad key");
  await assertThrows(() => controller.ingest(goodDoc), "controller rate limits second request");
  const cSnap = metrics.snapshot();
  assert(cSnap.rum.accepted === 1, "controller counts rumAccepted");
  assert(cSnap.rum.rejected === 1, "controller counts rumRejected on bad key");
  assert(cSnap.rum.rateLimited === 1, "controller counts rumRateLimited on 429");
}

{
  // Reject reason logging + per-reason metrics: non-string timeline item → 400 + rumRejected.
  const metrics = new JayTraceMetrics();
  const controller = new JayTraceRumController(
    {
      apiKey: "server-key",
      service: "api",
      maxRumEvents: 10,
      s3: { bucket: "bucket", region: "us-east-1" }
    },
    { export() {} },
    metrics
  );
  await assertThrows(() =>
    controller.ingest({
      apiKey: "server-key",
      reason: "error",
      document: {
        schema: "jaytrace.timeline.v1",
        service: "web",
        side: "front",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        startedAt: "2026-07-01T12:34:56.789Z",
        summary: "front failed",
        timeline: ["0.000s error front failed", { bad: true }]
      } as unknown as Parameters<JayTraceRumController["ingest"]>[0]["document"]
    }),
    "reject non-string timeline item"
  );
  const rSnap = metrics.snapshot();
  assert(rSnap.rum.rejected === 1, "non-string timeline item increments rumRejected");
  assert(rSnap.rum.rejectedReasons["Invalid JayTrace payload"] === 1, "reject reason aggregated in snapshot");
}

{
  // Reject-reason key cap: distinct reasons beyond 20 collapse into "other".
  const metrics = new JayTraceMetrics();
  for (let i = 0; i < 25; i += 1) {
    metrics.rejectReason(`reason-${i}`);
  }
  const reasons = metrics.snapshot().rum.rejectedReasons;
  assert(Object.keys(reasons).filter((key) => key !== "other").length === 20, "distinct reject reasons capped at 20");
  assert(reasons.other === 5, "overflow reject reasons collapse into other");
}

{
  // Health controller: shape + spoolBacklog === 2 + counters reflected.
  const spoolDir = await mkdtemp(join(tmpdir(), "jaytrace-health-"));
  await mkdir(join(spoolDir, "nested"), { recursive: true });
  await writeFile(join(spoolDir, "a.json"), "{}");
  await writeFile(join(spoolDir, "nested", "b.json"), "{}");
  const metrics = new JayTraceMetrics();
  metrics.inc("rumAccepted");
  metrics.inc("exportSent");
  const health = new JayTraceHealthController(metrics, {
    apiKey: "server-key",
    spoolDir,
    s3: { bucket: "bucket", region: "us-east-1" }
  });
  const res = await health.health();
  assert(res.ok === true, "health ok");
  assert(typeof res.uptimeSec === "number" && res.uptimeSec >= 0, "health uptimeSec");
  assert(res.spoolBacklog === 2, "health spoolBacklog counts files recursively");
  assert(res.rum.accepted === 1 && res.export.sent === 1, "health reflects metrics counters");
  assert(!JSON.stringify(res).includes("bucket"), "health response omits bucket name");
  await rm(spoolDir, { recursive: true, force: true });

  // Missing spool dir → backlog 0, still ok.
  const missing = new JayTraceHealthController(new JayTraceMetrics(), {
    apiKey: "server-key",
    spoolDir: join(tmpdir(), "jaytrace-does-not-exist-xyz"),
    s3: { bucket: "bucket", region: "us-east-1" }
  });
  const missingRes = await missing.health();
  assert(missingRes.ok === true && missingRes.spoolBacklog === 0, "missing spool dir → backlog 0, ok true");
}

{
  // Integrated mode: `@jaytrace/node/init` registers its runtime on a global symbol.
  // Context-less events delegate to its buffer instead of being dropped.
  const JAYTRACE_NODE: unique symbol = Symbol.for("jaytrace.node");
  const globalRef = globalThis as typeof globalThis & {
    [JAYTRACE_NODE]?: {
      buffer: {
        onLog: (spanId: string | undefined, log: { atMs: number; severity: string; text: string }) => void;
      };
    };
  };
  const logs: { spanId: string | undefined; severity: string; text: string }[] = [];
  globalRef[JAYTRACE_NODE] = {
    buffer: {
      onLog: (spanId, log) => {
        logs.push({ spanId, severity: log.severity, text: log.text });
      }
    }
  };

  const bridged = new JayTraceContextService();
  assert(nodeRuntime() !== undefined, "nodeRuntime detects the init global");
  bridged.addEvent("log", "delegated", "warn");
  bridged.addEvent("request", "response 500", "error");
  bridged.addEvent("log", "no severity");
  assert(logs.length === 3, "context-less addEvent delegates to the node buffer");
  assert(logs[0]?.text === "[log] delegated" && logs[0]?.severity === "warn", "delegated log keeps kind prefix and severity");
  assert(logs[1]?.text === "[request] response 500", "delegated request event keeps its kind prefix");
  assert(logs[2]?.severity === "info", "delegated event without severity defaults to info");
  assert(logs[0]?.spanId === undefined, "no active span → undefined span id, the buffer decides");

  // The middleware still opens a local context in integrated mode, and nothing exports it —
  // so the runtime wins over the context, otherwise in-handler events vanish.
  bridged.run(createRequestContext(undefined, "GET", "/x"), () => bridged.addEvent("log", "in context"));
  assert(logs.length === 4 && logs[3]?.text === "[log] in context", "integrated mode delegates even with an ALS context");

  delete globalRef[JAYTRACE_NODE];
  assert(nodeRuntime() === undefined, "nodeRuntime is undefined once the init global is gone");
  bridged.addEvent("log", "dropped");
  assert(logs.length === 4, "standalone mode: context-less addEvent stays a no-op");

  // Standalone mode keeps events in the context it was given.
  const standaloneContext = createRequestContext(undefined, "GET", "/x");
  bridged.run(standaloneContext, () => bridged.addEvent("log", "in context"));
  assert(standaloneContext.events.length === 2 && logs.length === 4, "standalone mode still records into the ALS context");
}

{
  // Integrated mode: the node span processor is the single export path, so neither the
  // interceptor nor the exception filter may push a second back document.
  const JAYTRACE_NODE: unique symbol = Symbol.for("jaytrace.node");
  const globalRef = globalThis as typeof globalThis & { [JAYTRACE_NODE]?: { buffer: { onLog: () => void } } };
  globalRef[JAYTRACE_NODE] = { buffer: { onLog: () => {} } };

  const integratedExports: ExportInput[] = [];
  const integratedContext = new JayTraceContextService();
  const integratedOptions: JayTraceModuleOptions = {
    apiKey: "server-key",
    service: "api",
    s3: { bucket: "bucket", region: "us-east-1" }
  };
  const integratedExporter = {
    export(input: ExportInput) {
      integratedExports.push(input);
    }
  };
  const integratedInterceptor = new JayTraceInterceptor(integratedContext, integratedOptions, integratedExporter);
  const integratedFilter = new JayTraceExceptionFilter(integratedContext, integratedOptions, integratedExporter);
  const boom = () => {
    const error = new Error("Unique constraint failed");
    error.name = "PrismaClientKnownRequestError";
    return error;
  };
  const runInterceptor = async () => {
    try {
      await firstValueFrom(
        integratedInterceptor.intercept(
          {
            switchToHttp: () => ({
              getRequest: () => ({ method: "POST", url: "/api/pay", headers: {} }),
              getResponse: () => ({ statusCode: 200 })
            })
          } as never,
          { handle: () => throwError(boom) }
        )
      );
    } catch {
      // expected: the interceptor observes the error but does not handle the response.
    }
  };

  await runInterceptor();
  assert(integratedExports.length === 0, "integrated mode: interceptor skips the back export");

  integratedContext.run(createRequestContext(undefined, "POST", "/api/pay"), () => {
    integratedFilter.catch(boom(), {
      switchToHttp: () => ({
        getResponse: () => ({ statusCode: 200, json: () => {} })
      })
    } as never);
  });
  assert(integratedExports.length === 0, "integrated mode: exception filter skips the back export");

  delete globalRef[JAYTRACE_NODE];
  await runInterceptor();
  assert(integratedExports.length === 1, "standalone mode: interceptor exports the 5xx document again");
}

{
  // Span-attribute form of a captured body: redacted, size-capped, always a string.
  assert(bodyAttribute(undefined, 64) === undefined, "no body → no span attribute");
  const attribute = bodyAttribute({ password: "secret", ok: true }, 64);
  assert(
    typeof attribute === "string" && attribute.includes("redacted") && !attribute.includes("secret"),
    "body attribute redacts before it reaches the span"
  );
  const long = bodyAttribute({ payload: "x".repeat(200) }, 32);
  assert(typeof long === "string" && long.endsWith("[truncated]"), "body attribute truncates to the configured cap");
}

{
  // Standalone mode must not pay for the span attribute: redact deep-copies the body, and
  // a getter on the body counts how many times it was walked.
  let reads = 0;
  const probeBody = {
    get payload() {
      reads += 1;
      return "value";
    }
  };
  const probeMiddleware = new JayTraceMiddleware(new JayTraceContextService(), {
    apiKey: "server-key",
    captureBody: true,
    s3: { bucket: "bucket", region: "us-east-1" }
  });
  probeMiddleware.use({ method: "POST", url: "/probe", body: probeBody, headers: {} }, { setHeader: () => {} }, () => {});
  assert(reads === 1, "standalone mode captures the request body exactly once");
}

{
  // End-to-end integrated mode with a real active span: attributes land on it, and both the
  // traceparent header and the 5xx response trace id come from OTel, not from the local context.
  const JAYTRACE_NODE: unique symbol = Symbol.for("jaytrace.node");
  const globalRef = globalThis as typeof globalThis & { [JAYTRACE_NODE]?: { buffer: { onLog: () => void } } };
  globalRef[JAYTRACE_NODE] = { buffer: { onLog: () => {} } };

  // @opentelemetry/api ships a no-op context manager, so an active span needs a real one.
  let current = ROOT_CONTEXT;
  otelContext.setGlobalContextManager({
    active: () => current,
    with(ctx, fn, thisArg, ...args) {
      const previous = current;
      current = ctx;
      try {
        return fn.call(thisArg, ...args);
      } finally {
        current = previous;
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

  const otelTraceId = "1111111111111111111111111111111a";
  const otelSpanId = "222222222222222b";
  const span = otelTrace.wrapSpanContext({ traceId: otelTraceId, spanId: otelSpanId, traceFlags: 1 });
  const attributes: Record<string, unknown> = {};
  span.setAttribute = (key, value) => {
    attributes[key] = value;
    return span;
  };
  // SDK spans expose their attributes (the API type does not) — setContext() reads them to merge.
  (span as Span & { attributes: Record<string, unknown> }).attributes = attributes;

  const otelOptions: JayTraceModuleOptions = {
    apiKey: "server-key",
    captureBody: { maxBytes: 512 },
    s3: { bucket: "bucket", region: "us-east-1" }
  };
  const otelContextService = new JayTraceContextService();
  const otelMiddleware = new JayTraceMiddleware(otelContextService, otelOptions);
  let otelTraceparent = "";
  const otelResponse: HttpLikeResponse = {
    setHeader(name, value) {
      if (name.toLowerCase() === "traceparent") {
        otelTraceparent = value;
      }
    },
    json(body) {
      return body;
    }
  };

  otelContext.with(otelTrace.setSpan(otelContext.active(), span), () => {
    otelMiddleware.use(
      {
        method: "POST",
        url: "/api/pay",
        body: { password: "secret", ok: true },
        headers: { "x-jaytrace-session": "sess_ABC-123456" }
      },
      otelResponse,
      () => {
        otelResponse.json?.({ ok: false });
      }
    );
  });

  assert(otelTraceparent === `00-${otelTraceId}-${otelSpanId}-01`, "integrated mode echoes the OTel traceparent");
  assert(attributes["jaytrace.session_id"] === "sess_ABC-123456", "session id stamped on the active span");
  assert(
    typeof attributes["jaytrace.request_body"] === "string" &&
      attributes["jaytrace.request_body"].includes("redacted") &&
      !attributes["jaytrace.request_body"].includes("secret"),
    "request body stamped on the active span, redacted"
  );
  assert(attributes["jaytrace.response_body"] === '{"ok":false}', "response body stamped on the active span");

  // setContext() has no ALS document to land in here, so it must ride the span and merge.
  otelContext.with(otelTrace.setSpan(otelContext.active(), span), () => {
    otelContextService.setContext({ tenantId: "tenant-1" });
    otelContextService.setContext({ plan: "pro" });
  });
  const contextPatch = JSON.parse(String(attributes["jaytrace.context_patch"])) as Record<string, unknown>;
  assert(
    contextPatch.tenantId === "tenant-1" && contextPatch.plan === "pro",
    "integrated mode setContext delegates to the span attribute and merges"
  );

  let errorBody: { traceId?: string } | undefined;
  const otelFilter = new JayTraceExceptionFilter(otelContextService, otelOptions, {
    export() {
      throw new Error("integrated mode must not export from the filter");
    }
  });
  otelContext.with(otelTrace.setSpan(otelContext.active(), span), () => {
    otelContextService.run(createRequestContext(undefined, "POST", "/api/pay"), () => {
      otelFilter.catch(new Error("boom"), {
        switchToHttp: () => ({
          getResponse: () => ({
            statusCode: 200,
            json: (body: { traceId?: string }) => {
              errorBody = body;
            }
          })
        })
      } as never);
    });
  });
  assert(errorBody?.traceId === otelTraceId, "integrated mode 5xx response carries the OTel trace id");

  delete globalRef[JAYTRACE_NODE];
}

{
  // RPC bridge: a traceparent carried in the message payload must reopen the caller's trace as
  // a remote parent, so TraceBuffer treats the consumer span as a root and writes a back document.
  const JAYTRACE_NODE: unique symbol = Symbol.for("jaytrace.node");
  const globalRef = globalThis as typeof globalThis & { [JAYTRACE_NODE]?: { buffer: { onLog: () => void } } };

  interface SpanRecord {
    name: string;
    kind?: SpanKind;
    parentTraceId?: string;
    ended: number;
    errors: number;
    exceptions: number;
  }

  // The interceptor must go through the real OTel global — that is the only path a SpanProcessor
  // (and therefore TraceBuffer) sees — so the fake is registered as the global provider.
  const started: SpanRecord[] = [];
  const proxyTracer = otelTrace.getTracer("jaytrace-self-check");
  const rpcTracer: Tracer = {
    startSpan(name, options, parentContext) {
      const record: SpanRecord = {
        name,
        kind: options?.kind,
        parentTraceId: parentContext ? otelTrace.getSpanContext(parentContext)?.traceId : undefined,
        ended: 0,
        errors: 0,
        exceptions: 0
      };
      started.push(record);
      const span = otelTrace.wrapSpanContext({ traceId: record.parentTraceId ?? "0".repeat(32), spanId: "777777777777777e", traceFlags: 1 });
      span.end = () => {
        record.ended += 1;
      };
      span.recordException = () => {
        record.exceptions += 1;
      };
      span.setStatus = status => {
        if (status.code === SpanStatusCode.ERROR) {
          record.errors += 1;
        }
        return span;
      };
      return span;
    },
    startActiveSpan: proxyTracer.startActiveSpan.bind(proxyTracer)
  };
  otelTrace.setGlobalTracerProvider({ getTracer: () => rpcTracer });

  // The API's default propagator is a no-op, so extract() would silently drop the traceparent.
  otelPropagation.setGlobalPropagator({
    fields: () => ["traceparent"],
    inject: () => {},
    extract(carrierContext, carrier, getter) {
      const value = getter.get(carrier, "traceparent");
      const [, traceId = "", spanId = ""] = typeof value === "string" ? value.split("-") : [];
      return traceId && spanId ? otelTrace.setSpanContext(carrierContext, { traceId, spanId, traceFlags: 1, isRemote: true }) : carrierContext;
    }
  });

  const rpcInterceptor = new JayTraceRpcInterceptor();
  const okHandler = { handle: () => of("ok") };
  globalRef[JAYTRACE_NODE] = { buffer: { onLog: () => {} } };

  const httpContext = { getType: () => "http" } as never;
  assert((await firstValueFrom(rpcInterceptor.intercept(httpContext, okHandler))) === "ok", "http context passes straight through");
  assert(started.length === 0, "http context creates no consumer span");

  const callerTraceId = "5555555555555555555555555555555c";
  const rpcContext = {
    getType: () => "rpc",
    switchToRpc: () => ({
      getData: () => ({ traceparent: `00-${callerTraceId}-666666666666666d-01`, orderId: 7 }),
      getContext: () => ({ getPattern: () => "shop.order.create" })
    }),
    getHandler: () => ({ name: "createOrder" })
  } as never;

  assert((await firstValueFrom(rpcInterceptor.intercept(rpcContext, okHandler))) === "ok", "rpc bridge returns the handler result");
  assert(started[0]?.name === "MSG shop.order.create", "consumer span is named after the message pattern");
  assert(started[0]?.kind === SpanKind.CONSUMER, "rpc bridge opens a CONSUMER span");
  assert(started[0]?.parentTraceId === callerTraceId, "payload traceparent becomes the remote parent");
  assert(started[0]?.ended === 1, "consumer span ends exactly once");

  let propagated = false;
  try {
    await firstValueFrom(rpcInterceptor.intercept(rpcContext, { handle: () => throwError(() => new Error("rpc boom")) }));
  } catch {
    propagated = true;
  }
  assert(propagated, "handler errors still reach the caller");
  assert(started[1]?.errors === 1 && started[1]?.exceptions === 1, "failed message records the exception and ERROR status");
  assert(started[1]?.ended === 1, "failed consumer span ends exactly once");

  // Nest TCP's own `@MessagePattern({ cmd: "sum" })` hands getPattern() an object.
  const objectPatternContext = {
    getType: () => "rpc",
    switchToRpc: () => ({ getData: () => ({}), getContext: () => ({ getPattern: () => ({ cmd: "sum" }) }) }),
    getHandler: () => ({ name: "sum" })
  } as never;
  await firstValueFrom(rpcInterceptor.intercept(objectPatternContext, okHandler));
  assert(started[2]?.name === 'MSG {"cmd":"sum"}', "object pattern is serialized, not flattened to [object Object]");

  const bareContext = {
    getType: () => "rpc",
    switchToRpc: () => ({ getData: () => undefined, getContext: () => ({}) }),
    getHandler: () => ({ name: "handleTick" })
  } as never;
  await firstValueFrom(rpcInterceptor.intercept(bareContext, okHandler));
  assert(started[3]?.name === "MSG handleTick", "no getPattern() → handler name");
  assert(started[3]?.parentTraceId === undefined, "no payload traceparent → the span starts its own trace");

  delete globalRef[JAYTRACE_NODE];
  assert((await firstValueFrom(rpcInterceptor.intercept(rpcContext, okHandler))) === "ok", "standalone mode passes the message through");
  assert(started.length === 4, "standalone mode opens no span — nothing would export it");
}
