import { initJayTrace } from "./index.js";
import { initJayTraceNext, deriveTraceOrigins as deriveTraceOriginsForTest, resolveReplayEnvDefaults, resolveNextReplayOptions } from "./next.js";
import type { ReplayV2SegmentDocument } from "@jaytrace/replay-core";
import { createJayTraceRumProxy } from "./next-rum-route.js";
import { createTraceparent, SESSION_TIMEOUT_MS } from "@jaytrace/core";
import { instrumentXhr } from "./instrumentXhr.js";
import { instrumentFetch } from "./instrumentFetch.js";
import { registerJayTraceNext, getJayTraceSSRTraceparent } from "./next-server.js";

type Listener = (event: Event) => void;

class FakeTarget {
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener)
    );
  }

  dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakeElement {
  readonly tagName = "BUTTON";
  readonly id = "pay";
  readonly textContent = "Pay now";
  getAttribute(name: string): string | null {
    return name === "data-testid" ? "pay-button" : null;
  }
}

class FakeXhr extends FakeTarget {
  status = 503;
  responseType = "";
  responseText = '{"ok":true}';
  readonly headers = new Map<string, string>();
  readonly responseHeaders = new Map<string, string>([["content-type", "application/json"]]);

  open(_method: string, _url: string): void {}

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders.get(name.toLowerCase()) ?? null;
  }

  send(): void {
    fakeXhrCalls.push(this);
    this.dispatch("loadend", new Event("loadend"));
  }
}

class FakeErrorXhr extends FakeXhr {
  override status = 0;

  override send(): void {
    fakeXhrCalls.push(this);
    this.dispatch("error", new Event("error"));
    this.dispatch("loadend", new Event("loadend"));
  }
}

class FakePerformanceObserver {
  static instance: FakePerformanceObserver | undefined;
  disconnected = false;
  observedType = "";

  constructor(private readonly callback: PerformanceObserverCallback) {
    FakePerformanceObserver.instance = this;
  }

  observe(options: PerformanceObserverInit): void {
    this.observedType = String(options.type ?? "");
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emit(entry: Pick<PerformanceEntry, "duration" | "startTime">): void {
    this.callback({
      getEntries: () => [entry as PerformanceEntry]
    } as PerformanceObserverEntryList, this as unknown as PerformanceObserver);
  }
}

const fakeWindow = new FakeTarget() as FakeTarget & Window;
const fakeDocument = new FakeTarget() as FakeTarget & Document;
const calls: Array<{ url: string; headers: Headers; body?: BodyInit | null; keepalive?: boolean }> = [];
const fakeXhrCalls: FakeXhr[] = [];
let time = 0;

Object.assign(fakeWindow, {
  location: {
    href: "https://example.test/checkout",
    origin: "https://example.test",
    pathname: "/checkout",
    hash: ""
  },
  PerformanceObserver: FakePerformanceObserver,
  navigator: {
    userAgent: "jaytrace-self-check"
  },
  scrollY: 0,
  history: {
    pushState(_state: unknown, _unused: string, url?: string | URL | null) {
      setPath(url);
    },
    replaceState(_state: unknown, _unused: string, url?: string | URL | null) {
      setPath(url);
    }
  }
});

Object.assign(globalThis, {
  window: fakeWindow,
  document: fakeDocument,
  location: fakeWindow.location,
  XMLHttpRequest: FakeXhr,
  PerformanceObserver: FakePerformanceObserver,
  performance: {
    getEntriesByType(type: string) {
      if (type !== "navigation") {
        return [];
      }
      return [{
        duration: 789.4,
        requestStart: 10,
        responseStart: 55.8,
        domContentLoadedEventEnd: 345.6
      }];
    }
  },
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (input instanceof Request) {
      calls.push({ url: input.url, headers: new Headers(input.headers), body: init?.body ?? null, keepalive: init?.keepalive });
    } else {
      calls.push({ url: String(input), headers: new Headers(init?.headers), body: init?.body ?? null, keepalive: init?.keepalive });
    }
    return new Response("ok", { status: url.includes("/api/pay-fail") ? 500 : 200 });
  }
});

const disabled = initJayTrace({
  enabled: false,
  apiKey: "",
  fetch: globalThis.fetch
});
disabled.addEvent({ at: "0.000s", kind: "click", text: "disabled" });
await disabled.flush("manual");
disabled.restore();
assert(disabled.traceparent === "", "disabled traceparent");
assert(calls.length === 0, "disabled client does not send");

const nextDisabled = initJayTraceNext({
  env: {
    NODE_ENV: "production"
  },
  fetch: globalThis.fetch
});
await nextDisabled.flush("manual");
nextDisabled.restore();
assert(nextDisabled.traceparent === "", "next helper disables production without public api key");

const nextDevClient = initJayTraceNext({
  env: {
    NODE_ENV: "development"
  },
  fetch: globalThis.fetch,
  replay: {
    enabled: false
  }
});
await nextDevClient.flush("manual");
nextDevClient.restore();
assert(Boolean(nextDevClient.traceparent), "next helper enables local dev without public api key");

const nextClient = initJayTraceNext({
  env: {
    NEXT_PUBLIC_JAYTRACE_API_KEY: "next-key",
    NEXT_PUBLIC_JAYTRACE_ENDPOINT: "https://collector.example.test/jaytrace/rum",
    NEXT_PUBLIC_APP_VERSION: "9.9.9",
    NEXT_PUBLIC_APP_ENV: "qa"
  },
  fetch: globalThis.fetch,
  replay: {
    enabled: false
  }
});
await nextClient.flush("manual");
nextClient.restore();
const nextPayload = calls.find((call) => call.url === "https://collector.example.test/jaytrace/rum");
assert(Boolean(nextPayload), "next helper sends to public endpoint");
assert(JSON.parse(String(nextPayload?.body)).apiKey === "next-key", "next helper reads public api key");
assert(JSON.parse(String(nextPayload?.body)).document.context.release === "9.9.9", "next helper reads public release");
assert(JSON.parse(String(nextPayload?.body)).document.service === "web", "next helper defaults service to web");
calls.length = 0;

const nextServiceEnvClient = initJayTraceNext({
  env: {
    NEXT_PUBLIC_JAYTRACE_SERVICE: "sample-web",
    NEXT_PUBLIC_JAYTRACE_API_KEY: "k"
  },
  fetch: globalThis.fetch,
  replay: {
    enabled: false
  }
});
await nextServiceEnvClient.flush("manual");
nextServiceEnvClient.restore();
const nextServiceEnvPayload = calls.find((call) => isRumCall(call));
assert(JSON.parse(String(nextServiceEnvPayload?.body)).document.service === "sample-web", "next helper reads NEXT_PUBLIC_JAYTRACE_SERVICE env fallback");
calls.length = 0;

{
  // zero-arg: cross-origin endpoint에서 traceOrigins/networkOrigins 자동 유도
  const zeroArgClient = initJayTraceNext({
    env: {
      NEXT_PUBLIC_JAYTRACE_API_KEY: "auto-key",
      NEXT_PUBLIC_JAYTRACE_ENDPOINT: "https://collector.example.test/jaytrace/rum",
      NEXT_PUBLIC_JAYTRACE_TRACE_ORIGINS: "https://api.example.test"
    },
    fetch: globalThis.fetch
  });
  const zeroArgHeaders = zeroArgClient.headers({}) as Record<string, string>;
  assert(typeof zeroArgHeaders.traceparent === "string", "next zero-arg still issues traceparent");

  // 관찰 가능한 효과로 검증: derived traceOrigins가 실제 fetch 계측(instrumentFetch)까지 연결되는지 확인.
  // headers()는 traceOrigins와 무관하게 항상 traceparent를 발급하므로 그것만으론 wiring을 증명하지 못한다.
  await fetch("https://api.example.test/derived-origin-check");
  const derivedOriginHeaders = calls.find((call) => call.url === "https://api.example.test/derived-origin-check")?.headers ?? new Headers();
  assert(derivedOriginHeaders.has("traceparent"), "next zero-arg derived traceOrigins reach fetch instrumentation");

  await fetch("https://untraced.example.test/derived-origin-check");
  const untracedOriginHeaders = calls.find((call) => call.url === "https://untraced.example.test/derived-origin-check")?.headers ?? new Headers();
  assert(!untracedOriginHeaders.has("traceparent"), "next zero-arg origin outside derived traceOrigins stays untraced");

  zeroArgClient.restore();
  calls.length = 0;
}
assert(
  JSON.stringify(deriveTraceOriginsForTest("https://collector.example.test/jaytrace/rum", "https://api.example.test")) ===
    JSON.stringify(["https://collector.example.test", "https://api.example.test"]),
  "traceOrigins derived from endpoint origin + env list"
);
assert(
  JSON.stringify(deriveTraceOriginsForTest("/jaytrace/rum", undefined)) === JSON.stringify([]),
  "relative endpoint derives no cross-origin traceOrigins"
);

const smallPayloadClient = initJayTrace({
  apiKey: "browser-key",
  fetch: globalThis.fetch,
  replay: { enabled: false }
});
smallPayloadClient.addAction("small");
await smallPayloadClient.flush("manual");
smallPayloadClient.restore();
assert(calls.at(-1)?.keepalive === true, "small timeline payload uses keepalive");
calls.length = 0;

const largePayloadClient = initJayTrace({
  apiKey: "browser-key",
  fetch: globalThis.fetch,
  replay: { enabled: false }
});
largePayloadClient.addAction("large", { text: "x".repeat(70_000) });
await largePayloadClient.flush("manual");
largePayloadClient.restore();
assert(calls.at(-1)?.keepalive !== true, "large timeline payload skips keepalive limit");
calls.length = 0;

const pagehideClient = initJayTrace({
  apiKey: "browser-key",
  fetch: globalThis.fetch,
  replay: { enabled: false }
});
pagehideClient.addAction("leaving");
fakeWindow.dispatch("pagehide", new Event("pagehide"));
await new Promise((resolve) => setTimeout(resolve, 0));
pagehideClient.restore();
assert(calls.some((call) => String(call.body).includes("leaving")), "pagehide flushes pending timeline");
calls.length = 0;

Object.defineProperty(fakeDocument, "visibilityState", { configurable: true, value: "hidden" });
const visibilityClient = initJayTrace({
  apiKey: "browser-key",
  fetch: globalThis.fetch,
  replay: { enabled: false }
});
visibilityClient.addAction("hidden-tab");
fakeDocument.dispatch("visibilitychange", new Event("visibilitychange"));
await new Promise((resolve) => setTimeout(resolve, 0));
visibilityClient.restore();
assert(calls.some((call) => String(call.body).includes("hidden-tab")), "visibility hidden flushes pending timeline");
calls.length = 0;

const proxiedBodies: string[] = [];
const proxyPost = createJayTraceRumProxy({
  endpoint: "https://collector.example.test/jaytrace/rum",
  apiKey: "server-key",
  fetch: async (_input, init) => {
    proxiedBodies.push(String(init?.body));
    return new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
  }
});
const proxyResponse = await proxyPost(new Request("https://app.example.test/jaytrace/rum", {
  method: "POST",
  headers: { "content-type": "application/json", traceparent: createTraceparent().value },
  body: JSON.stringify({ apiKey: "browser-key", document: { schema: "jaytrace.timeline.v1" } })
}));
assert(proxyResponse.status === 202, "next rum proxy returns collector status");
assert(JSON.parse(proxiedBodies[0] ?? "{}").apiKey === "server-key", "next rum proxy overwrites browser api key");

const client = initJayTrace({
  apiKey: "browser-key",
  release: "1.2.3",
  environment: "test",
  fetch: globalThis.fetch,
  traceOrigins: ["https://api.example.test"],
  replay: {
    enabled: true,
    mode: "on-error",
    networkOrigins: ["https://api.example.test"]
  },
  now: () => new Date(time)
});

assert(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(client.traceparent), "client traceparent");
assert(FakePerformanceObserver.instance?.observedType === "longtask", "long task observer installed");
fakeWindow.dispatch("load", new Event("load"));
const circularActionContext: Record<string, unknown> = { plan: "pro", token: "secret" };
circularActionContext.self = circularActionContext;
client.addAction("CheckoutStarted", circularActionContext);
client.addAction("BigIntContext", { count: 1n });
client.setUser({ id: "user-1", email: "person@example.test", token: "secret" });
assert(new Headers(client.headers({ "content-type": "application/json" })).has("traceparent"), "client headers helper injects traceparent");

await fetch("https://example.test/api/pay");
const apiHeaders = calls[0]?.headers ?? new Headers();
assert(apiHeaders.has("traceparent"), "fetch traceparent injection");
await fetch("https://api.example.test/v1/pay");
const apiOriginHeaders = calls[1]?.headers ?? new Headers();
assert(apiOriginHeaders.has("traceparent"), "allowed api origin traceparent injection");
await fetch("https://analytics.example.test/collect");
const analyticsHeaders = calls[2]?.headers ?? new Headers();
assert(!analyticsHeaders.has("traceparent"), "third-party fetch skips traceparent");
const networkFlushStart = calls.length;
await fetch("https://example.test/api/pay-fail");
await new Promise((resolve) => setTimeout(resolve, 0));
const networkPayloads = calls.slice(networkFlushStart).filter(isRumCall).map((call) => JSON.parse(String(call.body)));
assert(networkPayloads.some((payload) => payload.document.schema === "jaytrace.timeline.v1" && payload.document.timeline.some((line: string) => line.includes("fetch GET /api/pay-fail status=500"))), "fetch 500 flushes timeline");
assert(networkPayloads.some((payload) => payload.document.schema === "jaytrace.replay.v1" && payload.document.frames.some((frame: { kind: string; text: string }) => frame.kind === "network" && frame.text.includes("fetch GET /api/pay-fail status=500"))), "fetch 500 flushes replay");
const customNetworkStart = calls.length;
await client.traceNetwork({
  method: "PUT",
  url: "https://api.example.test/custom-client",
  headers: { "content-type": "application/json" },
  run: async (headers) => {
    calls.push({ url: "custom-client", headers: new Headers(headers) });
    return { status: 503 };
  },
  status: result => result.status
});
await new Promise((resolve) => setTimeout(resolve, 0));
const customHeaders = calls.find((call) => call.url === "custom-client")?.headers ?? new Headers();
const customPayloads = calls.slice(customNetworkStart).filter(isRumCall).map((call) => JSON.parse(String(call.body)));
assert(customHeaders.has("traceparent"), "traceNetwork injects traceparent");
assert(customPayloads.some((payload) => payload.document.schema === "jaytrace.timeline.v1" && payload.document.timeline.some((line: string) => line.includes("PUT https://api.example.test/custom-client status=503"))), "traceNetwork flushes timeline");
assert(customPayloads.some((payload) => payload.document.schema === "jaytrace.replay.v1" && payload.document.frames.some((frame: { kind: string; text: string }) => frame.kind === "network" && frame.text.includes("PUT https://api.example.test/custom-client status=503"))), "traceNetwork flushes replay");
const thrownNetworkStart = calls.length;
try {
  await client.traceNetwork({
    method: "PATCH",
    url: "https://api.example.test/custom-client",
    run: async (headers) => {
      calls.push({ url: "throwing-custom-client", headers: new Headers(headers) });
      throw new Error("custom client exploded");
    }
  });
  throw new Error("expected traceNetwork failure");
} catch (error) {
  assert(error instanceof Error && error.message === "custom client exploded", "traceNetwork rethrows custom client error");
}
await new Promise((resolve) => setTimeout(resolve, 0));
const thrownHeaders = calls.find((call) => call.url === "throwing-custom-client")?.headers ?? new Headers();
const thrownPayloads = calls.slice(thrownNetworkStart).filter(isRumCall).map((call) => JSON.parse(String(call.body)));
assert(thrownHeaders.has("traceparent"), "throwing traceNetwork injects traceparent");
assert(thrownPayloads.some((payload) => payload.document.schema === "jaytrace.timeline.v1" && payload.document.timeline.some((line: string) => line.includes("PATCH https://api.example.test/custom-client") && line.includes("error=custom client exploded"))), "throwing traceNetwork flushes timeline");
assert(thrownPayloads.some((payload) => payload.document.schema === "jaytrace.replay.v1" && payload.document.frames.some((frame: { kind: string; text: string }) => frame.kind === "network" && frame.text.includes("error=custom client exploded"))), "throwing traceNetwork flushes replay");
await client.traceNetwork({
  method: "POST",
  url: "https://third-party.example.test/custom-client",
  run: async (headers) => {
    calls.push({ url: "third-party-custom-client", headers: new Headers(headers) });
    return { status: 200 };
  },
  status: result => result.status
});
const thirdPartyCustomHeaders = calls.find((call) => call.url === "third-party-custom-client")?.headers ?? new Headers();
assert(!thirdPartyCustomHeaders.has("traceparent"), "traceNetwork skips third-party traceparent");
assert(!calls.slice(customNetworkStart).filter(isRumCall).some((call) => String(call.body).includes("third-party.example.test/custom-client") && String(call.body).includes('"schema":"jaytrace.replay.v1"')), "traceNetwork skips third-party replay frame");

window.history.pushState({}, "", "/checkout/review");
window.history.replaceState({}, "", "/checkout/confirm#pay");
fakeWindow.dispatch("popstate", new Event("popstate"));

const xhr = new XMLHttpRequest();
xhr.open("POST", "https://example.test/api/xhr-pay?token=secret");
xhr.send();
assert(Boolean(fakeXhrCalls[0]?.headers.get("traceparent")), "xhr traceparent injection");

const previousXhr = globalThis.XMLHttpRequest;
globalThis.XMLHttpRequest = FakeErrorXhr as unknown as typeof XMLHttpRequest;
const errorXhrLines: string[] = [];
const errorXhrInstrumentation = instrumentXhr({
  rootTraceparent: createTraceparent(),
  addTimeline: (text) => errorXhrLines.push(text),
  now: () => time
});
const errorXhr = new XMLHttpRequest();
errorXhr.open("GET", "https://example.test/api/xhr-offline");
errorXhr.send();
const errorLines = errorXhrLines.filter((line) => line.includes("xhr GET /api/xhr-offline"));
assert(errorLines.length === 1, "xhr error records once");
assert(errorLines[0]!.includes(" error"), "xhr error kind captured");
errorXhrInstrumentation.restore();
globalThis.XMLHttpRequest = previousXhr;
const mainPayloadStart = calls.length;
FakePerformanceObserver.instance?.emit({ duration: 123.4, startTime: 456.7 });

const browserError = new Error("card declined");
fakeWindow.dispatch(
  "error",
  {
    error: browserError,
    message: browserError.message,
    filename: "https://example.test/checkout.js",
    lineno: 12,
    colno: 34
  } as unknown as Event
);

const clickEvent = {
  clientX: 10,
  clientY: 20,
  target: new FakeElement()
} as unknown as MouseEvent;

for (let index = 0; index < 4; index += 1) {
  time += 100;
  fakeDocument.dispatch("click", clickEvent as unknown as Event);
}

await new Promise((resolve) => setTimeout(resolve, 0));
const mainCalls = calls.slice(mainPayloadStart);
assert(mainCalls.some(isRumCall), "rage click flush");
const rumCall = mainCalls.find(isRumCall);
assert(Boolean(rumCall), "rum call exists");
const payloads = mainCalls.filter(isRumCall).map((call) => JSON.parse(String(call.body)));
const timelinePayloads = payloads.filter((payload) => payload.document.schema === "jaytrace.timeline.v1");
const timelinePayload = timelinePayloads[0];
const rageClickPayload = timelinePayloads.find((payload) =>
  payload.document.timeline.some((line: string) => line.includes("rage-click"))
);
const replayPayload = payloads.find((payload) => payload.document.schema === "jaytrace.replay.v1");
assert(timelinePayload?.apiKey === "browser-key", "timeline apiKey is not redacted");
assert(replayPayload?.apiKey === "browser-key", "replay apiKey is not redacted");
assert(timelinePayload?.document.side === "front", "front document");
assert(timelinePayload.document.timeline.some((line: string) => line.includes("page loaded /checkout")), "initial navigation timeline");
assert(timelinePayload.document.timeline.some((line: string) => line.includes("navigation_timing durationMs=789 ttfbMs=46 domContentLoadedMs=346 path=/checkout")), "navigation timing timeline");
assert(timelinePayload.document.timeline.some((line: string) => line.includes("pushState /checkout/review")), "pushState navigation timeline");
assert(timelinePayload.document.timeline.some((line: string) => line.includes("replaceState /checkout/confirm#pay")), "replaceState navigation timeline");
assert(timelinePayload.document.timeline.some((line: string) => line.includes("long_task durationMs=123 startMs=457 path=/checkout/confirm#pay")), "long task timeline");
assert(timelinePayload.document.timeline.some((line: string) => line.includes("window.onerror Error: card declined")), "browser error timeline");
assert(timelinePayload.document.timeline.some((line: string) => line.includes("action CheckoutStarted")), "browser custom action timeline");
assert(timelinePayload.document.timeline.some((line: string) => line.includes("action BigIntContext")), "browser custom action tolerates non-json context");
assert(timelinePayload.document.context?.user?.id === "user-1", "browser user context");
assert(timelinePayload.document.error?.name === "Error", "browser error name");
assert(timelinePayload.document.error?.message === "card declined", "browser error message");
assert(Boolean(timelinePayload.document.error?.stack), "browser error stack");
assert(Boolean(rageClickPayload), "rage-click timeline");
assert(timelinePayloads.some((payload) => payload.document.timeline.some((line: string) => line.includes("xhr POST /api/xhr-pay status=503"))), "xhr timeline");
assert(!JSON.stringify(timelinePayload).includes("token=secret"), "xhr url masked");
assert(!JSON.stringify(timelinePayload).includes('"token":"secret"'), "action context token masked");
assert(!JSON.stringify(payloads).includes("AWS_SECRET_ACCESS_KEY"), "no aws secret");
assert(Boolean(replayPayload), "replay flush");
assert(replayPayload.document.metadata?.release === "1.2.3", "replay release metadata");
assert(replayPayload.document.metadata?.environment === "test", "replay environment metadata");
assert(replayPayload.document.metadata?.userAgent === "jaytrace-self-check", "replay user agent metadata");
assert(replayPayload.document.metadata?.["user.id"] === "user-1", "replay user metadata");
assert(replayPayload.document.metadata?.["user.token"] === "redacted", "replay user token redacted");
assert(replayPayload.document.events.some((line: string) => line.includes("fetch GET /api/pay")), "replay fetch network");
assert(replayPayload.document.events.some((line: string) => line.includes("action CheckoutStarted")), "replay custom action");
assert(replayPayload.document.events.some((line: string) => line.includes("performance navigation_timing durationMs=789")), "replay navigation timing");
assert(replayPayload.document.events.some((line: string) => line.includes("performance long_task durationMs=123")), "replay long task");
assert(replayPayload.document.events.some((line: string) => line.includes("fetch GET https://api.example.test/v1/pay")), "replay allowed api origin network");
assert(replayPayload.document.events.some((line: string) => line.includes("xhr POST /api/xhr-pay status=503")), "replay xhr network");
assert(replayPayload.document.frames.some((frame: { kind: string; text: string }) => frame.kind === "network" && frame.text.includes("xhr POST /api/xhr-pay status=503")), "replay xhr network frame");
assert(!replayPayload.document.events.some((line: string) => line.includes("analytics.example.test")), "replay skips third-party network");

client.restore();
assert(FakePerformanceObserver.instance?.disconnected === true, "long task observer restored");

// --- Task 4: replay v2 env + segment upload wiring ---

// initJayTraceNext reads the two new replay env keys.
const replayEnv = resolveReplayEnvDefaults({
  NEXT_PUBLIC_JAYTRACE_REPLAY_MODE: "always",
  NEXT_PUBLIC_JAYTRACE_REPLAY_SAMPLE_RATE: "0.25"
});
assert(replayEnv.mode === "always", "replay env mode parsed");
assert(replayEnv.sampleRate === 0.25, "replay env sampleRate parsed");
assert(resolveReplayEnvDefaults({ NEXT_PUBLIC_JAYTRACE_REPLAY_MODE: "bogus" }).mode === undefined, "invalid replay mode ignored");
assert(resolveReplayEnvDefaults({ NEXT_PUBLIC_JAYTRACE_REPLAY_SAMPLE_RATE: "" }).sampleRate === undefined, "empty sampleRate ignored");
assert(resolveReplayEnvDefaults({ NEXT_PUBLIC_JAYTRACE_REPLAY_SAMPLE_RATE: "abc" }).sampleRate === undefined, "non-numeric sampleRate ignored");
assert(resolveReplayEnvDefaults({ NEXT_PUBLIC_JAYTRACE_REPLAY_MODE: "sometimes" }).mode === undefined, "unrecognized replay mode ignored");

// resolveNextReplayOptions merge precedence: explicit options.replay must win over
// env-derived defaults, which must win over the hardcoded base. This is the
// discriminating check for the spread order in next.ts — swap the spreads there
// and this assertion fails (verified manually; see task report).
const conflictingEnv = {
  NEXT_PUBLIC_JAYTRACE_REPLAY_MODE: "always",
  NEXT_PUBLIC_JAYTRACE_REPLAY_SAMPLE_RATE: "0.25"
};
const explicitWinsMerge = resolveNextReplayOptions(conflictingEnv, [], { mode: "off", sampleRate: 0.9 });
assert(explicitWinsMerge.mode === "off", "explicit replay.mode wins over conflicting env");
assert(explicitWinsMerge.sampleRate === 0.9, "explicit replay.sampleRate wins over conflicting env");

// env fills gaps when explicit options.replay omits the field
const envFillsGapMerge = resolveNextReplayOptions(conflictingEnv, [], { enabled: false });
assert(envFillsGapMerge.mode === "always", "env replay.mode fills gap when explicit options omit it");
assert(envFillsGapMerge.sampleRate === 0.25, "env replay.sampleRate fills gap when explicit options omit it");
assert(envFillsGapMerge.enabled === false, "explicit replay.enabled still respected alongside env fill");

// invalid env values are ignored, falling back to the hardcoded base
const invalidEnvMerge = resolveNextReplayOptions({ NEXT_PUBLIC_JAYTRACE_REPLAY_MODE: "sometimes", NEXT_PUBLIC_JAYTRACE_REPLAY_SAMPLE_RATE: "abc" }, [], undefined);
assert(invalidEnvMerge.mode === "on-error", "invalid env mode falls back to hardcoded base default");
assert(invalidEnvMerge.sampleRate === undefined, "invalid env sampleRate leaves sampleRate unset");

// The env client constructs without throwing and env defaults are wired ahead of explicit options.
const replayEnvClient = initJayTraceNext({
  env: {
    NEXT_PUBLIC_JAYTRACE_API_KEY: "k",
    NEXT_PUBLIC_JAYTRACE_REPLAY_MODE: "always",
    NEXT_PUBLIC_JAYTRACE_REPLAY_SAMPLE_RATE: "0.25"
  },
  fetch: globalThis.fetch,
  replay: { enabled: false }
});
replayEnvClient.restore();

// A v2 segment POST goes through the mock fetch with reason "segment".
calls.length = 0;
const segmentClient = initJayTrace({
  apiKey: "segment-key",
  endpoint: "https://collector.example.test/jaytrace/rum",
  fetch: globalThis.fetch,
  replay: { enabled: false }
});
// rrweb events must survive client-side redaction untouched: rrweb masks
// text/inputs at record time, so re-redacting here would only corrupt deeply
// nested FullSnapshot nodes via the [MaxDepth] guard. Build a >=12-level
// chain (with a decoy "token" key at depth 3) to prove nothing inside
// rrwebEvents gets walked, while sibling metadata still gets redacted.
const deepRrwebNode = buildDeepChain();
const syntheticSegment: ReplayV2SegmentDocument = {
  schema: "jaytrace.replay.v2",
  engine: "rrweb",
  platform: "web",
  traceId: "a".repeat(32),
  sessionId: "s",
  seq: 0,
  startedAt: "2026-07-10T00:00:00.000Z",
  endedAt: "2026-07-10T00:00:10.000Z",
  metadata: { token: "secret" },
  rrwebEvents: [{ type: 2, data: deepRrwebNode }]
};
await (segmentClient as unknown as { sendReplaySegment(s: ReplayV2SegmentDocument): Promise<void> }).sendReplaySegment(syntheticSegment);
segmentClient.restore();
const segmentCall = calls.find((call) => isRumCall(call));
assert(Boolean(segmentCall), "v2 segment POST reaches the collector endpoint");
const segmentBody = JSON.parse(String(segmentCall?.body));
assert(segmentBody.apiKey === "segment-key", "segment payload carries apiKey");
assert(segmentBody.reason === "segment", "segment payload reason is 'segment'");
assert(segmentBody.document.schema === "jaytrace.replay.v2", "segment payload document is a v2 segment");
assert(segmentCall?.keepalive !== true, "segment POST uses plain fetch (no keepalive)");
assert(
  JSON.stringify(segmentBody.document.rrwebEvents) === JSON.stringify(syntheticSegment.rrwebEvents),
  "deeply nested rrwebEvents survive client-side redaction byte-identical"
);
assert(!JSON.stringify(segmentBody.document.rrwebEvents).includes("[MaxDepth]"), "rrwebEvents not truncated by redaction maxDepth");
assert(segmentBody.document.metadata?.token === "redacted", "sibling metadata is still redacted");
calls.length = 0;

// --- Track C: crash-isolation forced-failure regressions ---------------------
// An exception ANYWHERE inside SDK logic must never reach the host caller or
// break the host event loop. USER-callback exceptions (traceNetwork run) must
// still propagate — only the SDK's own bookkeeping around them is isolated.
{
  let poisonNow = false;
  // The RUM sender itself throws synchronously; every buffer timestamp is poisoned.
  const throwingFetch = (() => {
    throw new Error("boom rum sender");
  }) as unknown as typeof fetch;

  const hostileClient = initJayTrace({
    apiKey: "iso-key",
    fetch: throwingFetch,
    replay: { enabled: true, mode: "on-error" },
    now: () => {
      if (poisonNow) {
        throw new Error("boom now");
      }
      return new Date(time);
    }
  });

  poisonNow = true;
  const circular: Record<string, unknown> = { token: "secret" };
  circular.self = circular;

  let threw = false;
  try {
    hostileClient.addEvent({ at: "0.000s", kind: "click", text: "iso" });
    hostileClient.addAction("iso action", circular);
    hostileClient.headers({ "content-type": "application/json" });
    hostileClient.setUser({ id: "iso-user", token: "secret" });
    await hostileClient.traceNetwork({
      method: "GET",
      url: "https://example.test/iso",
      run: async () => ({ status: 200 }),
      status: (result) => result.status
    });
    await hostileClient.flush("manual");
    await hostileClient.flush("error");
    // host-facing DOM + navigation surfaces must also survive a poisoned buffer
    fakeDocument.dispatch("click", clickEvent as unknown as Event);
    fakeWindow.dispatch("scroll", {} as Event);
    window.history.pushState({}, "", "/iso/next"); // app navigation must not break
    window.history.replaceState({}, "", "/iso/replace");
    fakeWindow.dispatch("popstate", new Event("popstate"));
    fakeWindow.dispatch("error", { error: new Error("iso host error"), message: "iso host error" } as unknown as Event);
    FakePerformanceObserver.instance?.emit({ duration: 5, startTime: 6 });
    hostileClient.restore();
  } catch {
    threw = true;
  }
  assert(!threw, "forced internal errors never escape browser-sdk public methods, listeners, or restore");

  // The user's run callback error must STILL propagate — only SDK bookkeeping is isolated.
  poisonNow = true;
  let userErrorPropagated = false;
  try {
    await hostileClient.traceNetwork({
      method: "POST",
      url: "https://example.test/iso-user-throw",
      run: async () => {
        throw new Error("user run exploded");
      }
    });
  } catch (error) {
    userErrorPropagated = error instanceof Error && error.message === "user run exploded";
  }
  assert(userErrorPropagated, "traceNetwork still propagates the user callback error under a poisoned buffer");
}
calls.length = 0;

// Highest-stakes path: a patched fetch whose SDK bookkeeping throws must still
// resolve the host's fetch with the REAL response (never convert success to failure).
{
  const priorFetch = globalThis.fetch;
  const realResponse = new Response("real-passthrough-body", { status: 200 });
  globalThis.fetch = (async () => realResponse) as unknown as typeof fetch;
  const passthroughInstrumentation = instrumentFetch({
    rootTraceparent: createTraceparent(),
    addTimeline: () => {
      throw new Error("boom addTimeline");
    }
  });
  const passthroughResponse = await fetch("https://example.test/iso-passthrough");
  assert(passthroughResponse === realResponse, "patched fetch returns the real response even when SDK bookkeeping throws");
  assert((await passthroughResponse.text()) === "real-passthrough-body", "patched fetch response body survives a throwing addTimeline");
  passthroughInstrumentation.restore();
  globalThis.fetch = priorFetch;
}

// When the traced request cannot even be built, fall back to the untouched original fetch.
{
  const priorFetch = globalThis.fetch;
  const fallbackResponse = new Response("fallback-body", { status: 200 });
  globalThis.fetch = (async () => fallbackResponse) as unknown as typeof fetch;
  const fallbackInstrumentation = instrumentFetch({
    rootTraceparent: createTraceparent(),
    addTimeline: () => undefined
  });
  const hostileInput = { toString() { throw new Error("boom url"); } } as unknown as RequestInfo;
  const fallbackResp = await fetch(hostileInput);
  assert(fallbackResp === fallbackResponse, "instrumentFetch falls back to the original fetch when the request cannot be built");
  fallbackInstrumentation.restore();
  globalThis.fetch = priorFetch;
}
calls.length = 0;

function setPath(url?: string | URL | null): void {
  if (!url) {
    return;
  }
  const next = new URL(String(url), fakeWindow.location.href);
  Object.assign(fakeWindow.location, {
    href: next.href,
    pathname: next.pathname,
    hash: next.hash
  });
}

function isRumCall(call: { url: string }): boolean {
  return call.url === "/jaytrace/rum" || call.url.endsWith("/jaytrace/rum");
}

// Builds a 14-level-deep { a: { a: ... } } chain with a `token: "secret"`
// key at depth 3, to trip redact()'s maxDepth=8 guard if it ever gets
// applied to rrwebEvents again.
function buildDeepChain(): unknown {
  let node: Record<string, unknown> = { leaf: true };
  for (let level = 13; level >= 0; level -= 1) {
    node = level === 3 ? { a: node, token: "secret" } : { a: node };
  }
  return node;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`self-check failed: ${message}`);
  }
}

// --- Task B: SDK Extension Check ---
{
  calls.length = 0;
  const extClient = initJayTrace({
    apiKey: "ext-key",
    fetch: globalThis.fetch,
    captureBody: true,
    redaction: { enabled: true, sensitiveKeys: ["secret"] },
    replay: { enabled: false }
  });

  await fetch("https://example.test/api/json", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "fetch-body", secret: "hidden" })
  });

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "https://example.test/api/json");
  xhr.setRequestHeader("content-type", "application/json");
  xhr.send(JSON.stringify({ hello: "xhr-body", secret: "hidden" }));

  await extClient.flush("manual");
  extClient.restore();

  const payloadStr = String(calls.find((call) => isRumCall(call))?.body);
  assert(payloadStr.includes('"requestBody":{"hello":"fetch-body","secret":"redacted"}'), "fetch request body captured and redacted");
  assert(payloadStr.includes('"requestBody":{"hello":"xhr-body","secret":"redacted"}'), "xhr request body captured and redacted");
  calls.length = 0;
}

// --- Next.js server-side fetch instrumentation (registerJayTraceNext) ---
{
  // registerJayTraceNext is Node-only; the fake self-check environment sets a
  // `window`, so temporarily remove it to exercise the server path. The patched
  // fetch and window are restored afterwards.
  const store = globalThis as Record<string, unknown>;
  const savedWindow = store.window;
  const savedFetch = globalThis.fetch;
  delete store.window;
  // Start each block from a clean shared SSR state (the fetch-patch guard,
  // capabilities and render root all live there) so this block instruments fresh.
  delete store[Symbol.for("jaytrace.next.ssr.state") as unknown as string];

  const SSR_ENDPOINT = "http://collector.ssr.test/jaytrace/rum";
  calls.length = 0;

  registerJayTraceNext({
    endpoint: SSR_ENDPOINT,
    apiKey: "ssr-key",
    service: "shop",
    captureBody: true,
    flushDebounceMs: 10
  });

  await fetch("https://api.ssr.test/users?page=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "ssr-body", secret: "hidden" })
  });
  await fetch("https://api.ssr.test/orders");

  // Wait for the debounce timer to elapse and the collector POST to complete.
  await new Promise((resolve) => setTimeout(resolve, 60));

  const ssrCollectorCall = calls.find((call) => call.url === SSR_ENDPOINT);
  assert(Boolean(ssrCollectorCall), "next-server flushes buffered events to the collector");
  assert(ssrCollectorCall?.headers.get("x-jaytrace-internal") === "1", "next-server collector POST is marked internal");

  const ssrPayload = JSON.parse(String(ssrCollectorCall?.body));
  assert(ssrPayload.reason === "manual", "next-server flush reason is manual");
  assert(ssrPayload.apiKey === "ssr-key", "next-server flush carries api key");
  assert(ssrPayload.document.side === "back", "next-server document side is back");
  assert(ssrPayload.document.service === "shop-ssr", "next-server service gets -ssr suffix");
  assert(ssrPayload.document.schema === "jaytrace.timeline.v1", "next-server document schema is timeline v1");
  assert(ssrPayload.document.events.length === 2, "next-server buffers both requests into one trace");

  const timelineText = JSON.stringify(ssrPayload.document.events);
  assert(timelineText.includes("fetch POST https://api.ssr.test/users status=200"), "next-server records method/url/status without query");
  assert(!timelineText.includes("page=1"), "next-server strips query string from url text");
  assert(timelineText.includes('"requestBody":{"name":"ssr-body","secret":"redacted"}'), "next-server captures and redacts request body");
  assert(timelineText.includes('"responseBody"'), "next-server captures response body");

  // Trace propagation: outgoing app requests must carry a child traceparent
  // sharing the render-root traceId. With first-toucher minting, the first SSR
  // fetch mints the root and the second reuses it, so both land on one trace.
  const appCall = calls.find((call) => call.url === "https://api.ssr.test/orders");
  const propagated = appCall?.headers.get("traceparent") ?? "";
  assert(propagated.length > 0, "next-server propagates a traceparent to downstream requests");
  assert(propagated.includes(ssrPayload.document.traceId), "next-server propagation shares the document traceId");

  globalThis.fetch = savedFetch as typeof fetch;
  store.window = savedWindow;
  delete store[Symbol.for("jaytrace.next.ssr.state") as unknown as string];
  calls.length = 0;
}

// --- v2: first-load SSR trace adoption via meta tag (client) ---
{
  calls.length = 0;
  const fakeDoc = fakeDocument as unknown as { querySelector?: (selector: string) => unknown };
  const setMeta = (content: string | null) => {
    fakeDoc.querySelector = (selector: string) =>
      selector === 'meta[name="jaytrace-traceparent"]'
        ? { getAttribute: (name: string) => (name === "content" ? content : null) }
        : null;
  };

  // A valid SSR meta traceparent is adopted as the client RUM root.
  const ssrMetaRoot = createTraceparent();
  setMeta(ssrMetaRoot.value);
  const metaClient = initJayTraceNext({
    env: { NEXT_PUBLIC_JAYTRACE_API_KEY: "meta-key" },
    fetch: globalThis.fetch,
    replay: { enabled: false }
  });
  metaClient.addAction("meta-adopt");
  await metaClient.flush("manual");
  metaClient.restore();
  const metaPayload = JSON.parse(String(calls.find(isRumCall)?.body));
  assert(metaClient.traceparent === ssrMetaRoot.value, "client root traceparent equals SSR meta traceparent");
  assert(metaPayload.document.traceId === ssrMetaRoot.traceId, "client RUM payload traceId matches SSR meta traceId");
  calls.length = 0;

  // A malformed meta content is ignored — the client generates its own root.
  setMeta("not-a-valid-traceparent");
  const selfGenClient = initJayTraceNext({
    env: { NEXT_PUBLIC_JAYTRACE_API_KEY: "meta-key" },
    fetch: globalThis.fetch,
    replay: { enabled: false }
  });
  selfGenClient.addAction("meta-selfgen");
  await selfGenClient.flush("manual");
  selfGenClient.restore();
  const selfGenPayload = JSON.parse(String(calls.find(isRumCall)?.body));
  assert(/^[0-9a-f]{32}$/.test(String(selfGenPayload.document.traceId)), "invalid SSR meta yields a self-generated traceId");
  assert(selfGenPayload.document.traceId !== ssrMetaRoot.traceId, "self-generated traceId differs from the prior meta traceId");
  delete fakeDoc.querySelector;
  calls.length = 0;
}

// --- v2: order A (getter first) — first-toucher getter mints, SSR fetches reuse (server) ---
{
  const store = globalThis as Record<string, unknown>;
  const savedWindow = store.window;
  const savedFetch = globalThis.fetch;
  delete store.window;
  const ssrStateSymbol = Symbol.for("jaytrace.next.ssr.state");
  delete store[ssrStateSymbol as unknown as string];

  const readSsrState = () =>
    (globalThis as Record<string, unknown>)[ssrStateSymbol as unknown as string] as
      | { renderRoot: { traceparent: string; expiresAt: number } | null; registered: boolean }
      | undefined;

  const SSR_ENDPOINT = "http://collector.getter.test/jaytrace/rum";
  calls.length = 0;

  registerJayTraceNext({
    endpoint: SSR_ENDPOINT,
    apiKey: "getter-key",
    service: "shop",
    flushDebounceMs: 10
  });

  // A second module instance (the RSC bundle) re-invoking register with the
  // shared global state already populated must not re-apply the fetch patch.
  const patchedFetchBefore = globalThis.fetch;
  registerJayTraceNext({ endpoint: SSR_ENDPOINT, apiKey: "getter-key-2", service: "shop2", flushDebounceMs: 10 });
  assert(globalThis.fetch === patchedFetchBefore, "second registerJayTraceNext does not re-patch globalThis.fetch");

  // The root-layout getter mints a fresh root and opens the render window,
  // recording it on the shared global state.
  const rootValue = await getJayTraceSSRTraceparent();
  assert(Boolean(rootValue), "getJayTraceSSRTraceparent returns a fresh root value");
  assert(readSsrState()?.renderRoot?.traceparent === rootValue, "getter stores its root as the shared render window");

  const expectedTraceId = /^00-([0-9a-f]{32})-/.exec(String(rootValue))?.[1];

  // Two SSR fetches within the open window adopt the getter's root.
  await fetch("https://api.getter.test/users");
  await fetch("https://api.getter.test/orders");
  await new Promise((resolve) => setTimeout(resolve, 60));

  const getterCollectorCall = calls.find((call) => call.url === SSR_ENDPOINT);
  assert(Boolean(getterCollectorCall), "render-window block flushes buffered events to the collector");
  const getterPayload = JSON.parse(String(getterCollectorCall?.body));
  assert(getterPayload.document.traceId === expectedTraceId, "SSR fetches during the render window share the getter traceId");
  assert(getterPayload.document.events.length === 2, "both render-window fetches land on one trace");

  // Downstream propagation carries a child of the getter root.
  const orderCall = calls.find((call) => call.url === "https://api.getter.test/orders");
  const propagated = orderCall?.headers.get("traceparent") ?? "";
  assert(propagated.includes(String(expectedTraceId)), "render-window fetch propagates a child of the getter root");

  globalThis.fetch = savedFetch as typeof fetch;
  store.window = savedWindow;
  delete store[ssrStateSymbol as unknown as string];
  calls.length = 0;
}

// --- v2: order B (fetch first) — an SSR fetch before the getter mints; getter reuses (server) ---
// Regression guard for the bug this design fixes: in a real Next render a nested
// layout's SSR fetch runs BEFORE the root layout's getter. Under the old
// "getter mints" rule those fetches fell into a separate root and the getter's
// meta root bound nothing. With first-toucher minting the fetch mints and the
// getter must reuse the exact same root.
{
  const store = globalThis as Record<string, unknown>;
  const savedWindow = store.window;
  const savedFetch = globalThis.fetch;
  delete store.window;
  const ssrStateSymbol = Symbol.for("jaytrace.next.ssr.state");
  delete store[ssrStateSymbol as unknown as string];

  const SSR_ENDPOINT = "http://collector.firsttouch.test/jaytrace/rum";
  calls.length = 0;

  registerJayTraceNext({
    endpoint: SSR_ENDPOINT,
    apiKey: "firsttouch-key",
    service: "shop",
    flushDebounceMs: 10
  });

  // The nested-layout SSR fetch fires first and mints the render root.
  await fetch("https://api.firsttouch.test/early");
  // The root-layout getter runs afterwards and must reuse that same root.
  const getterReuse = await getJayTraceSSRTraceparent();
  const fetchMintedTraceId = /^00-([0-9a-f]{32})-/.exec(String(getterReuse))?.[1];

  await new Promise((resolve) => setTimeout(resolve, 60));

  const ftCollectorCall = calls.find((call) => call.url === SSR_ENDPOINT);
  assert(Boolean(ftCollectorCall), "first-toucher block flushes buffered events to the collector");
  const ftPayload = JSON.parse(String(ftCollectorCall?.body));
  assert(String(getterReuse) === ftPayload.document.traceparent, "getter returns the exact root the earlier SSR fetch minted");
  assert(ftPayload.document.traceId === fetchMintedTraceId, "getter and the SSR fetch share one document traceId");

  // The early fetch's propagated child shares that same root traceId.
  const earlyCall = calls.find((call) => call.url === "https://api.firsttouch.test/early");
  const earlyPropagated = earlyCall?.headers.get("traceparent") ?? "";
  assert(earlyPropagated.includes(String(fetchMintedTraceId)), "the early SSR fetch propagates a child of the shared root");

  globalThis.fetch = savedFetch as typeof fetch;
  store.window = savedWindow;
  delete store[ssrStateSymbol as unknown as string];
  calls.length = 0;
}

// --- v2: fetches after the render window expires mint a NEW render root (server) ---
{
  const store = globalThis as Record<string, unknown>;
  const savedWindow = store.window;
  const savedFetch = globalThis.fetch;
  delete store.window;
  const ssrStateSymbol = Symbol.for("jaytrace.next.ssr.state");
  delete store[ssrStateSymbol as unknown as string];

  const SSR_ENDPOINT = "http://collector.expiry.test/jaytrace/rum";
  calls.length = 0;

  // A short render window so it lapses before the next fetch. renderWindowMs is
  // published to the shared state and read by the getter.
  registerJayTraceNext({
    endpoint: SSR_ENDPOINT,
    apiKey: "expiry-key",
    service: "shop",
    flushDebounceMs: 10,
    renderWindowMs: 20
  });

  const rootValue = await getJayTraceSSRTraceparent();
  const windowTraceId = /^00-([0-9a-f]{32})-/.exec(String(rootValue))?.[1];

  // Let the render window elapse before firing a fetch.
  await new Promise((resolve) => setTimeout(resolve, 40));
  await fetch("https://api.expiry.test/late");
  await new Promise((resolve) => setTimeout(resolve, 60));

  const expiryCall = calls.find((call) => call.url === SSR_ENDPOINT);
  assert(Boolean(expiryCall), "post-expiry fetch still flushes to the collector");
  const expiryPayload = JSON.parse(String(expiryCall?.body));
  assert(expiryPayload.document.traceId !== windowTraceId, "fetch after the render window expires does not join the stale render root");
  assert(/^[0-9a-f]{32}$/.test(String(expiryPayload.document.traceId)), "post-expiry fetch mints a new render root traceId");

  globalThis.fetch = savedFetch as typeof fetch;
  store.window = savedWindow;
  delete store[ssrStateSymbol as unknown as string];
  calls.length = 0;
}

// --- captureViews selector observation (attr priority, name dedupe, legacy) ---
{
  let viewIntersection: FakeIntersectionObserver | undefined;

  class FakeIntersectionObserver {
    readonly observed = new Set<Element>();
    disconnected = false;
    readonly options: IntersectionObserverInit;
    constructor(private readonly cb: IntersectionObserverCallback, options: IntersectionObserverInit) {
      this.options = options;
      viewIntersection = this;
    }
    observe(el: Element): void {
      this.observed.add(el);
    }
    unobserve(el: Element): void {
      this.observed.delete(el);
    }
    disconnect(): void {
      this.disconnected = true;
      this.observed.clear();
    }
    trigger(el: Element, ratio: number): void {
      this.cb(
        [{ target: el, isIntersecting: ratio > 0, intersectionRatio: ratio } as unknown as IntersectionObserverEntry],
        this as unknown as IntersectionObserver
      );
    }
  }

  class FakeMutationObserver {
    observe(): void {}
    disconnect(): void {}
  }

  class ViewEl {
    readonly nodeType = 1;
    constructor(
      readonly tagName: string,
      private readonly attrs: Record<string, string>,
      readonly textContent: string,
      private readonly selectorTags: string[] = [],
      private readonly rect: { width: number; height: number } = { width: 0, height: 0 }
    ) {}
    getAttribute(name: string): string | null {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name]! : null;
    }
    hasAttribute(name: string): boolean {
      return Object.prototype.hasOwnProperty.call(this.attrs, name);
    }
    matches(combined: string): boolean {
      return combined
        .split(",")
        .map((part) => part.trim())
        .some((part) => (part === "[data-jaytrace-view]" ? this.hasAttribute("data-jaytrace-view") : this.selectorTags.includes(part)));
    }
    querySelectorAll(): ViewEl[] {
      return [];
    }
    getBoundingClientRect(): { width: number; height: number } {
      return this.rect;
    }
    get children(): ViewEl[] {
      return [];
    }
  }

  class ViewRoot {
    readonly nodeType = 1;
    readonly tagName = "HTML";
    constructor(readonly children: ViewEl[]) {}
    getAttribute(): string | null {
      return null;
    }
    hasAttribute(): boolean {
      return false;
    }
    matches(): boolean {
      return false;
    }
    getBoundingClientRect(): { width: number; height: number } {
      return { width: 0, height: 0 };
    }
    querySelectorAll(combined: string): ViewEl[] {
      return this.children.filter((child) => child.matches(combined));
    }
  }

  Object.assign(globalThis, {
    IntersectionObserver: FakeIntersectionObserver,
    MutationObserver: FakeMutationObserver,
    Node: { ELEMENT_NODE: 1 }
  });

  const setRoot = (children: ViewEl[]): void => {
    Object.defineProperty(fakeDocument, "documentElement", { configurable: true, value: new ViewRoot(children) });
  };

  const viewTimeline = (): string[] => {
    const payload = JSON.parse(String(calls.find((call) => isRumCall(call))?.body));
    return payload.document.timeline as string[];
  };

  // (1) selector-matched element recorded at >=50% visibility; below threshold ignored.
  calls.length = 0;
  viewIntersection = undefined;
  const lowVis = new ViewEl("DIV", { "data-testid": "low-vis" }, "", [".promo"]);
  const highVis = new ViewEl("DIV", { "data-testid": "high-vis" }, "", [".promo"]);
  setRoot([lowVis, highVis]);
  const ratioClient = initJayTrace({
    apiKey: "view-key",
    fetch: globalThis.fetch,
    captureViews: { selectors: [".promo"] },
    replay: { enabled: false }
  });
  const ratioObserver = viewIntersection!;
  assert(ratioObserver.observed.size === 2, "selector-matched elements observed");
  assert(ratioObserver.options.threshold === 0.5, "default minRatio maps to threshold 0.5");
  ratioObserver.trigger(lowVis as unknown as Element, 0.3);
  ratioObserver.trigger(highVis as unknown as Element, 0.6);
  await ratioClient.flush("manual");
  ratioClient.restore();
  const ratioLines = viewTimeline();
  assert(ratioLines.some((line) => line.includes("high-vis")), "selector element at 50% visibility records a view");
  assert(!ratioLines.some((line) => line.includes("low-vis")), "selector element below minRatio is not recorded");

  // (2) name resolution priority: data-jaytrace-view > data-testid > id > aria-label > tag+text.
  calls.length = 0;
  viewIntersection = undefined;
  const priorityEls = [
    new ViewEl("DIV", { "data-jaytrace-view": "hero-view", "data-testid": "td", id: "i", "aria-label": "a" }, "ignored", [".v"]),
    new ViewEl("DIV", { "data-testid": "promo-testid", id: "i2", "aria-label": "a2" }, "ignored", [".v"]),
    new ViewEl("DIV", { id: "signup-id", "aria-label": "a3" }, "ignored", [".v"]),
    new ViewEl("BUTTON", { "aria-label": "Close dialog" }, "ignored", [".v"]),
    new ViewEl("SPAN", {}, "  Learn   more  ", [".v"]),
    new ViewEl("DIV", {}, "   ", [".v"])
  ];
  setRoot(priorityEls);
  const priorityClient = initJayTrace({
    apiKey: "view-key",
    fetch: globalThis.fetch,
    captureViews: { selectors: [".v"] },
    replay: { enabled: false }
  });
  const priorityObserver = viewIntersection!;
  for (const el of [...priorityObserver.observed]) {
    priorityObserver.trigger(el, 0.9);
  }
  await priorityClient.flush("manual");
  priorityClient.restore();
  const priorityLines = viewTimeline();
  assert(priorityLines.some((line) => line.includes("hero-view")), "data-jaytrace-view wins name priority");
  assert(priorityLines.some((line) => line.includes("promo-testid")), "data-testid is next in name priority");
  assert(priorityLines.some((line) => line.includes("signup-id")), "id is next in name priority");
  assert(priorityLines.some((line) => line.includes("Close dialog")), "aria-label is next in name priority");
  assert(priorityLines.some((line) => line.includes("span: Learn more")), "tag + collapsed text is the fallback name");
  assert(priorityLines.some((line) => line.includes("view") && /\bdiv\b/.test(line)), "empty-text element falls back to tag only");

  // (3) same resolved name is recorded once per session.
  calls.length = 0;
  viewIntersection = undefined;
  setRoot([new ViewEl("BUTTON", {}, "Pay now", [".dup"]), new ViewEl("BUTTON", {}, "Pay now", [".dup"])]);
  const dedupeClient = initJayTrace({
    apiKey: "view-key",
    fetch: globalThis.fetch,
    captureViews: { selectors: [".dup"] },
    replay: { enabled: false }
  });
  const dedupeObserver = viewIntersection!;
  for (const el of [...dedupeObserver.observed]) {
    dedupeObserver.trigger(el, 0.9);
  }
  await dedupeClient.flush("manual");
  dedupeClient.restore();
  const dedupeLines = viewTimeline();
  assert(dedupeLines.filter((line) => line.includes("button: Pay now")).length === 1, "duplicate view name recorded only once");

  // (4) captureViews: true uses the built-in default selector set (section,
  // data-testid, ...) on top of data-jaytrace-view; non-default elements are skipped.
  calls.length = 0;
  viewIntersection = undefined;
  const legacyEl = new ViewEl("DIV", { "data-jaytrace-view": "legacy-view" }, "", []);
  const sectionEl = new ViewEl("SECTION", {}, "Section body", ["section"]);
  const testidEl = new ViewEl("DIV", { "data-testid": "default-testid" }, "", ["[data-testid]"]);
  const unmatchedEl = new ViewEl("DIV", { class: "promo" }, "", [".promo"]);
  setRoot([legacyEl, sectionEl, testidEl, unmatchedEl]);
  const defaultsClient = initJayTrace({
    apiKey: "view-key",
    fetch: globalThis.fetch,
    captureViews: true,
    replay: { enabled: false }
  });
  const defaultsObserver = viewIntersection!;
  assert(defaultsObserver.observed.size === 3, "captureViews:true observes default-set matches (data-jaytrace-view, section, data-testid)");
  assert(!defaultsObserver.observed.has(unmatchedEl as unknown as Element), "captureViews:true skips elements outside the default set");
  for (const el of [...defaultsObserver.observed]) {
    defaultsObserver.trigger(el, 0.9);
  }
  await defaultsClient.flush("manual");
  defaultsClient.restore();
  const defaultsLines = viewTimeline();
  assert(defaultsLines.some((line) => line.includes("legacy-view")), "default set records the data-jaytrace-view element");
  assert(defaultsLines.some((line) => line.includes("default-testid")), "default set records the data-testid element");
  assert(defaultsLines.some((line) => line.includes("section: Section body")), "default set records the section element");

  // (5) auto (default on) records a large non-selector-matched block.
  calls.length = 0;
  viewIntersection = undefined;
  Object.assign(fakeWindow, { innerWidth: 1000, innerHeight: 800 });
  const bigBlock = new ViewEl("DIV", { id: "hero-banner" }, "Hero", [], { width: 700, height: 600 });
  const smallBlock = new ViewEl("DIV", { id: "tiny" }, "tiny", [], { width: 50, height: 50 });
  setRoot([bigBlock, smallBlock]);
  const autoClient = initJayTrace({
    apiKey: "view-key",
    fetch: globalThis.fetch,
    captureViews: { auto: true },
    replay: { enabled: false }
  });
  const autoObserver = viewIntersection!;
  assert(autoObserver.observed.has(bigBlock as unknown as Element), "auto observes a >=25% viewport block even without a selector match");
  assert(!autoObserver.observed.has(smallBlock as unknown as Element), "auto ignores blocks below the 25% viewport threshold");
  for (const el of [...autoObserver.observed]) {
    autoObserver.trigger(el, 0.9);
  }
  await autoClient.flush("manual");
  autoClient.restore();
  assert(viewTimeline().some((line) => line.includes("hero-banner")), "auto-detected large block is recorded as a view");

  // (6) auto:false suppresses large-block detection.
  calls.length = 0;
  viewIntersection = undefined;
  const bigBlockNoAuto = new ViewEl("DIV", { id: "hero-2" }, "Hero", [], { width: 700, height: 600 });
  setRoot([bigBlockNoAuto]);
  const noAutoClient = initJayTrace({
    apiKey: "view-key",
    fetch: globalThis.fetch,
    captureViews: { auto: false },
    replay: { enabled: false }
  });
  const noAutoObserver = viewIntersection!;
  assert(!noAutoObserver.observed.has(bigBlockNoAuto as unknown as Element), "auto:false does not observe large non-matching blocks");
  noAutoClient.restore();

  // (7) observe-target cap: at most 200 elements are observed per session.
  calls.length = 0;
  viewIntersection = undefined;
  const many = Array.from({ length: 250 }, (_v, i) => new ViewEl("DIV", { "data-jaytrace-view": `m-${i}` }, "", ["[data-jaytrace-view]"]));
  setRoot(many);
  const capClient = initJayTrace({
    apiKey: "view-key",
    fetch: globalThis.fetch,
    captureViews: { selectors: ["[data-jaytrace-view]"] },
    replay: { enabled: false }
  });
  const capObserver = viewIntersection!;
  assert(capObserver.observed.size === 200, "observe-target cap holds at 200 elements per session");
  capClient.restore();
  Object.assign(fakeWindow, { innerWidth: 0, innerHeight: 0 });

  calls.length = 0;
}

// --- Custom log API (JayTraceClient.log — Datadog DD_LOGS parity) ---
{
  calls.length = 0;
  const logClient = initJayTrace({
    apiKey: "log-key",
    fetch: globalThis.fetch,
    redaction: { enabled: true, sensitiveKeys: ["secret"] },
    replay: { enabled: false }
  });
  logClient.log("debug", "debug line");
  logClient.log("info", "info line");
  logClient.log("warn", "warn line");
  logClient.log("error", "error line", { plan: "pro", secret: "hidden" });
  await logClient.flush("manual");
  logClient.restore();

  const logEvents = timelineLogEvents(calls, "log ");
  const withSeverity = (severity: string, needle: string): boolean =>
    logEvents.some((event) => event.severity === severity && event.text.includes(needle));
  assert(withSeverity("debug", "debug line"), "log debug maps to debug severity");
  assert(withSeverity("info", "info line"), "log info maps to info severity");
  assert(withSeverity("warn", "warn line"), "log warn maps to warn severity");
  assert(withSeverity("error", "error line"), "log error maps to error severity");
  const errorLogEvent = logEvents.find((event) => event.text.includes("error line"));
  assert(errorLogEvent?.data?.plan === "pro", "log context attached to event data");
  assert(errorLogEvent?.data?.secret === "redacted", "log context redacted before attach");
  // error-level log records with error severity but must NOT trigger an error
  // flush — only the single manual flush above should have sent anything.
  assert(calls.filter(isRumCall).length === 1, "error-level log does not trigger an error flush");
  calls.length = 0;
}

// --- captureConsole (console capture into the timeline) ---
{
  calls.length = 0;
  const originalConsoleCalls: Array<{ method: string; args: unknown[] }> = [];
  const spyConsole = {
    error: (...args: unknown[]) => { originalConsoleCalls.push({ method: "error", args }); },
    warn: (...args: unknown[]) => { originalConsoleCalls.push({ method: "warn", args }); },
    log: (...args: unknown[]) => { originalConsoleCalls.push({ method: "log", args }); },
    info: (...args: unknown[]) => { originalConsoleCalls.push({ method: "info", args }); }
  };
  Object.defineProperty(fakeWindow, "console", { configurable: true, writable: true, value: spyConsole });

  // (1) captureConsole: true captures only console.error; the original call passes through.
  const trueClient = initJayTrace({
    apiKey: "console-key",
    fetch: globalThis.fetch,
    captureConsole: true,
    replay: { enabled: false }
  });
  spyConsole.error("boom-error");
  spyConsole.warn("ignored-warn");
  await trueClient.flush("manual");
  trueClient.restore();
  const trueEvents = timelineLogEvents(calls, "console.");
  assert(trueEvents.some((event) => event.text.startsWith("console.error") && event.text.includes("boom-error")), "captureConsole:true records console.error");
  assert(!trueEvents.some((event) => event.text.includes("ignored-warn")), "captureConsole:true ignores console.warn");
  assert(originalConsoleCalls.some((call) => call.method === "error" && call.args[0] === "boom-error"), "original console.error still runs (passthrough)");
  assert(originalConsoleCalls.some((call) => call.method === "warn" && call.args[0] === "ignored-warn"), "unpatched console.warn still runs");
  calls.length = 0;
  originalConsoleCalls.length = 0;

  // (2) array selects methods; severity maps error->error, warn->warn, log/info->info.
  const arrayClient = initJayTrace({
    apiKey: "console-key",
    fetch: globalThis.fetch,
    captureConsole: ["error", "warn", "log", "info"],
    replay: { enabled: false }
  });
  spyConsole.error("e-msg");
  spyConsole.warn("w-msg");
  spyConsole.log("l-msg");
  spyConsole.info("i-msg");
  await arrayClient.flush("manual");
  arrayClient.restore();
  const arrayEvents = timelineLogEvents(calls, "console.");
  const consoleEvent = (needle: string) => arrayEvents.find((event) => event.text.includes(needle));
  assert(Boolean(consoleEvent("e-msg")?.text.startsWith("console.error")) && consoleEvent("e-msg")?.severity === "error", "console.error severity is error");
  assert(Boolean(consoleEvent("w-msg")?.text.startsWith("console.warn")) && consoleEvent("w-msg")?.severity === "warn", "console.warn severity is warn");
  assert(Boolean(consoleEvent("l-msg")?.text.startsWith("console.log")) && consoleEvent("l-msg")?.severity === "info", "console.log severity is info");
  assert(Boolean(consoleEvent("i-msg")?.text.startsWith("console.info")) && consoleEvent("i-msg")?.severity === "info", "console.info severity is info");
  calls.length = 0;
  originalConsoleCalls.length = 0;

  // (3) a large console argument is capped at 2,000 chars.
  const capClient = initJayTrace({
    apiKey: "console-key",
    fetch: globalThis.fetch,
    captureConsole: ["log"],
    replay: { enabled: false }
  });
  spyConsole.log("y".repeat(5000));
  await capClient.flush("manual");
  capClient.restore();
  const capEvent = timelineLogEvents(calls, "console.log").find((event) => event.text.includes("y"));
  const serializedArgs = String(capEvent?.text).replace("console.log ", "");
  assert(serializedArgs.length === 2000, "console arguments capped at 2000 chars");
  calls.length = 0;
  originalConsoleCalls.length = 0;

  // (4) re-entrancy guard: a patched console.error re-entered inside the handler
  // records only once. The evil arg's getter fires during serialization.
  const reentrantClient = initJayTrace({
    apiKey: "console-key",
    fetch: globalThis.fetch,
    captureConsole: ["error"],
    replay: { enabled: false }
  });
  const reentrantArg = {
    get nested(): string {
      spyConsole.error("nested-reentry");
      return "value";
    }
  };
  spyConsole.error("outer-call", reentrantArg);
  await reentrantClient.flush("manual");
  reentrantClient.restore();
  const reentrantEvents = timelineLogEvents(calls, "console.");
  assert(reentrantEvents.length === 1, "re-entrant console.error inside the handler records exactly once");
  assert(reentrantEvents[0]!.text.includes("outer-call"), "re-entrant guard keeps the outer console record");
  // The nested call still passed through to the original console.
  assert(originalConsoleCalls.some((call) => call.args[0] === "nested-reentry"), "nested console.error still reaches the original console");
  calls.length = 0;
  originalConsoleCalls.length = 0;

  // (5) after restore, console calls are no longer captured.
  const restoreClient = initJayTrace({
    apiKey: "console-key",
    fetch: globalThis.fetch,
    captureConsole: ["error"],
    replay: { enabled: false }
  });
  spyConsole.error("before-restore");
  restoreClient.restore();
  calls.length = 0;
  const plainClient = initJayTrace({
    apiKey: "console-key",
    fetch: globalThis.fetch,
    replay: { enabled: false }
  });
  spyConsole.error("after-restore");
  plainClient.addAction("restore-marker");
  await plainClient.flush("manual");
  plainClient.restore();
  const postRestoreEvents = timelineLogEvents(calls, "console.");
  assert(!postRestoreEvents.some((event) => event.text.includes("after-restore")), "console is not captured after restore()");
  calls.length = 0;
  originalConsoleCalls.length = 0;

  // (6) repeat-flood suppression: the same text records only its first occurrence;
  // a later distinct message flushes a single "(repeated xN)" summary for it.
  const floodClient = initJayTrace({
    apiKey: "console-key",
    fetch: globalThis.fetch,
    captureConsole: ["error"],
    replay: { enabled: false }
  });
  for (let i = 0; i < 5; i += 1) {
    spyConsole.error("same-key-warning");
  }
  spyConsole.error("distinct-after-flood");
  await floodClient.flush("manual");
  floodClient.restore();
  const floodEvents = timelineLogEvents(calls, "console.");
  const floodFirst = floodEvents.filter((event) => event.text.includes("same-key-warning") && !event.text.includes("repeated"));
  assert(floodFirst.length === 1, "repeated console text records only its first occurrence");
  assert(floodEvents.some((event) => event.text.includes("console.error (repeated x5) same-key-warning")), "a distinct message flushes a repeated x5 summary for the flooded text");
  assert(floodEvents.some((event) => event.text.includes("distinct-after-flood")), "the distinct message after the flood is recorded");
  assert(originalConsoleCalls.filter((call) => call.args[0] === "same-key-warning").length === 5, "every repeated console call still passes through to the original console");
  calls.length = 0;
  originalConsoleCalls.length = 0;

  // (7) unique-message cap: after 30 distinct texts a single mute notice records
  // and further distinct texts are dropped.
  const muteClient = initJayTrace({
    apiKey: "console-key",
    fetch: globalThis.fetch,
    captureConsole: ["log"],
    replay: { enabled: false }
  });
  for (let i = 0; i < 35; i += 1) {
    spyConsole.log(`unique-${i}`);
  }
  await muteClient.flush("manual");
  muteClient.restore();
  const muteEvents = timelineLogEvents(calls, "console.log");
  assert(muteEvents.length === 30, "at most 30 unique console messages are recorded per session");
  assert(timelineLogEvents(calls, "console capture muted").length === 1, "reaching the unique cap records exactly one mute notice");
  assert(!muteEvents.some((event) => event.text.includes("unique-30")), "distinct messages beyond the unique cap are dropped");
  calls.length = 0;
  originalConsoleCalls.length = 0;

  delete (fakeWindow as unknown as { console?: unknown }).console;
  calls.length = 0;
}

// --- Sessionization (Datadog-style idle/max-duration rotation) ---
{
  // ① a document generated after >15min idle carries a new sessionId. The session
  // manager's clock is driven by `now`, so advancing `time` between flushes is
  // exactly a period of inactivity — each snapshot() resolves (touches) the session.
  calls.length = 0;
  time = 9_000_000;
  const sessionClient = initJayTrace({
    apiKey: "session-key",
    fetch: globalThis.fetch,
    replay: { enabled: false },
    now: () => new Date(time)
  });
  sessionClient.addAction("s1");
  await sessionClient.flush("manual");
  const firstSessionId = JSON.parse(String(calls.find(isRumCall)?.body)).document.sessionId;
  calls.length = 0;

  time += SESSION_TIMEOUT_MS + 1; // 15min + 1ms of inactivity
  sessionClient.addAction("s2");
  await sessionClient.flush("manual");
  const secondSessionId = JSON.parse(String(calls.find(isRumCall)?.body)).document.sessionId;
  sessionClient.restore();

  assert(Boolean(firstSessionId) && Boolean(secondSessionId), "documents carry a sessionId");
  assert(firstSessionId !== secondSessionId, "a document after 15min idle carries a rotated sessionId");
  calls.length = 0;

  // ② instrumented fetch injects x-jaytrace-session alongside traceparent.
  const headerClient = initJayTrace({
    apiKey: "session-key",
    fetch: globalThis.fetch,
    replay: { enabled: false }
  });
  await fetch("https://example.test/api/session-header");
  const sessionHeaders = calls.find((call) => call.url === "https://example.test/api/session-header")?.headers ?? new Headers();
  assert(sessionHeaders.has("traceparent"), "session-header request is traced");
  assert(Boolean(sessionHeaders.get("x-jaytrace-session")), "instrumented fetch injects x-jaytrace-session");
  headerClient.restore();
  calls.length = 0;
}

interface TimelineLogEvent {
  kind: string;
  text: string;
  severity?: string;
  data?: Record<string, unknown>;
}

function timelineLogEvents(callList: Array<{ url: string; body?: BodyInit | null }>, textPrefix: string): TimelineLogEvent[] {
  const rumCall = callList.find((call) => isRumCall(call));
  if (!rumCall) {
    return [];
  }
  const document = JSON.parse(String(rumCall.body)).document as { events?: TimelineLogEvent[] };
  return (document.events ?? []).filter((event) => event.kind === "log" && String(event.text).startsWith(textPrefix));
}
