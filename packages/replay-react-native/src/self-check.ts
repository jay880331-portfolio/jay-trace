import {
  buildWireframeFrame,
  createJayTraceFetch,
  createReactNativeComponentLifecycleTracker,
  initJayTraceReactNative,
  ReactNativeWireframeCoordinator,
  resolveReplayEngine,
  createReplayRootProps,
  createReactNativeScreenshotProvider,
  createReactNavigationReplayTracker,
  createViewabilityTracker,
  initJayTraceReactNativeReplay,
  installReactNativeReplayErrorHandlers,
  viewTreeToWireframeNodes,
  withReplayPress,
  withReplayTextInput,
  type ReactNativeViewTreeNode
} from "./index.js";
import type { ReplayV2SegmentDocument } from "@jaytrace/replay-core";
import { createSessionManager } from "@jaytrace/core";
import { ensureJayTraceClient, resetJayTraceClientForTest } from "./root-core.js";

const calls: Array<{ url: string; body: string }> = [];
let now = 0;
let screenshotCalls = 0;

const client = initJayTraceReactNativeReplay({
  apiKey: "rn-key",
  endpoint: "https://api.example.test/jaytrace/rum",
  enabled: true,
  mode: "on-error",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  sessionId: "rn-session-1",
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  metadata: { appVersion: "1.2.3", os: "ios", device: "iPhone" },
  now: () => new Date(now),
  screenshot: createReactNativeScreenshotProvider({
    captureScreen: async () => {
      screenshotCalls += 1;
      const delay = screenshotCalls <= 4 ? 30 : 0;
      await new Promise(resolve => setTimeout(resolve, delay));
      return "cm4=";
    },
    width: 390,
    height: 844
  }),
  fetch: async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body) });
    return new Response("ok");
  }
});

assert(Boolean(client), "client created");
assert(
  initJayTraceReactNativeReplay({
    apiKey: "rn-key",
    endpoint: "https://api.example.test/jaytrace/rum",
    enabled: true,
    sampleRate: 0,
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
  }) === null,
  "sampleRate 0 disables replay"
);
client?.recordScreen("Checkout");
client?.setUser({ id: "rn-user-1", token: "secret" });
client?.recordViewTreeSnapshot({
  type: "View",
  props: { testID: "CheckoutRoot", title: "secret checkout" },
  children: [{ type: "Text", props: { value: "card number 4111111111111111" } }]
});
const lifecycle = createReactNativeComponentLifecycleTracker(client, "CheckoutSummary", () => now);
lifecycle.mount();
now += 17;
lifecycle.unmount();
let currentRoute = {
  key: "checkout-1",
  name: "Checkout"
};
const tracker = createReactNavigationReplayTracker(client, {
  getCurrentRoute: () => currentRoute
});
tracker.onReady();
currentRoute = {
  key: "payment-1",
  name: "Payment"
};
now += 83;
tracker.onStateChange();
now += 100;
withReplayPress(client, "PayButton")({
  nativeEvent: {
    pageX: 12,
    pageY: 34
  }
});
createReplayRootProps(client).onTouchStart({
  nativeEvent: {
    pageX: 56,
    pageY: 78
  }
});
now += 100;
client?.recordAction("CheckoutStarted", "token secret");
withReplayTextInput(client, "EmailInput")("secret@example.test");
client?.recordScroll("CheckoutList", 320);
client?.recordPerformance("JSFrameBlocked", 123.6, "token secret");
client?.recordGesture("swipe", "card number 4111111111111111");
await client?.recordNetwork({
  method: "post",
  url: "https://api.example.test/pay?token=secret",
  status: 200,
  durationMs: 42
});
const paymentError = new Error("payment failed");
paymentError.stack = "Error: payment failed\n    at pay (/app/checkout.tsx:12:3)";
await client?.recordError(paymentError);

assert(calls.length === 1, "flush on error");
const payload = JSON.parse(calls[0]?.body ?? "{}");
assert(payload.apiKey === "rn-key", "rn apiKey is not redacted");
assert(payload.document.schema === "jaytrace.replay.v1", "replay schema");
assert(payload.document.platform === "react-native", "rn platform");
assert(payload.document.sessionId === "rn-session-1", "rn session id");
assert(payload.document.metadata?.appVersion === "1.2.3", "rn metadata");
assert(payload.document.metadata?.["replay.screenshot"] === "enabled", "rn screenshot metadata");
assert(payload.document.metadata?.["view.name"] === "redacted", "rn view metadata");
assert(payload.document.metadata?.["user.id"] === "rn-user-1", "rn user metadata");
assert(payload.document.metadata?.["user.token"] === "redacted", "rn user token redacted");
assert(payload.document.frames?.[0]?.type === "image", "rn image replay frame");
assert(payload.document.frames?.length >= 3, "rn captures action frames");
assert(JSON.stringify(payload.document.frames).includes("tap redacted x=12 y=34"), "tap frame captured");
assert(payload.document.frames.some((frame: { text: string; x?: number; y?: number }) => frame.text.includes("x=12 y=34") && frame.x === 12 && frame.y === 34), "tap point frame captured");
assert(JSON.stringify(payload.document.frames).includes("tap redacted x=56 y=78"), "root touch frame captured");
assert(JSON.stringify(payload).includes("screen_end redacted durationMs="), "screen duration captured");
assert(JSON.stringify(payload).includes("component_mount redacted"), "component mount captured");
assert(JSON.stringify(payload).includes("component_unmount redacted durationMs=17"), "component unmount captured");
assert(JSON.stringify(payload).includes("view_tree"), "virtual view tree captured");
assert(JSON.stringify(payload).includes("action redacted redacted"), "custom action captured");
assert(JSON.stringify(payload).includes("input redacted value=redacted"), "text input captured without value");
assert(!JSON.stringify(payload).includes("secret@example.test"), "text input value redacted");
assert(JSON.stringify(payload).includes("scroll redacted offset=320"), "scroll captured");
assert(JSON.stringify(payload).includes("performance redacted durationMs=124 redacted"), "performance captured");
assert(JSON.stringify(payload).includes("POST redacted status=200 durationMs=42"), "network captured");
assert(!JSON.stringify(payload).includes("token=secret"), "network url masked");
assert(JSON.stringify(payload).includes("payment failed"), "error captured");
assert(JSON.stringify(payload).includes("checkout.tsx"), "error stack captured");
assert(!JSON.stringify(payload).includes("4111111111111111"), "detail masked");

const tooLargeScreenshot = await createReactNativeScreenshotProvider({
  captureScreen: () => "cm4=",
  maxBytes: 1
})();
assert(tooLargeScreenshot === null, "oversized screenshot skipped");

let captureOptions: unknown;
const optionScreenshot = await createReactNativeScreenshotProvider({
  format: "jpg",
  quality: 0.4,
  captureScreen: options => {
    captureOptions = options;
    return "b3B0aW9ucw==";
  }
})();
assert(Boolean(optionScreenshot?.image.startsWith("data:image/jpg;base64,")), "rn screenshot provider wraps raw base64");
assert(JSON.stringify(captureOptions) === JSON.stringify({ format: "jpg", result: "base64", quality: 0.4 }), "rn screenshot provider passes capture options");

const tooLargeByDefault = await createReactNativeScreenshotProvider({
  captureScreen: () => "a".repeat(500_000)
})();
assert(tooLargeByDefault === null, "default oversized screenshot skipped");

const nonImageDataUrl = await createReactNativeScreenshotProvider({
  captureScreen: () => "data:text/plain;base64,Zm9v"
})();
assert(nonImageDataUrl === null, "non-image data url skipped");

const nonBase64DataUrl = await createReactNativeScreenshotProvider({
  captureScreen: () => "data:image/png,not-base64"
})();
assert(nonBase64DataUrl === null, "non-base64 data url skipped");

let disabledScreenshotCalls = 0;
const disabledScreenshot = await createReactNativeScreenshotProvider({
  enabled: () => false,
  captureScreen: () => {
    disabledScreenshotCalls += 1;
    return "cm4=";
  }
})();
assert(disabledScreenshot === null, "disabled screenshot skipped");
assert(disabledScreenshotCalls === 0, "disabled screenshot does not capture");

const throwingDisabledScreenshot = await createReactNativeScreenshotProvider({
  enabled: () => {
    throw new Error("route check failed");
  },
  captureScreen: () => "cm4="
})();
assert(throwingDisabledScreenshot === null, "throwing enabled check skips screenshot");

const throwingCaptureScreenshot = await createReactNativeScreenshotProvider({
  captureScreen: () => {
    throw new Error("capture failed");
  }
})();
assert(throwingCaptureScreenshot === null, "throwing capture skips screenshot");

const timedOutScreenshot = await createReactNativeScreenshotProvider({
  timeoutMs: 5,
  captureScreen: async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return "cm4=";
  }
})();
assert(timedOutScreenshot === null, "slow capture times out");

const invalidCustomScreenshotCalls: Array<{ body: string }> = [];
const invalidCustomScreenshotClient = initJayTraceReactNativeReplay({
  apiKey: "rn-key",
  endpoint: "https://api.example.test/jaytrace/rum",
  enabled: true,
  mode: "on-error",
  traceId: "invalid-custom-screenshot-trace",
  screenshot: () => ({ image: "data:text/plain;base64,Zm9v" }),
  fetch: async (_url, init) => {
    invalidCustomScreenshotCalls.push({ body: String(init?.body) });
    return new Response("ok");
  }
});
await invalidCustomScreenshotClient?.recordError(new Error("invalid custom screenshot"));
const invalidCustomScreenshotDocument = JSON.parse(invalidCustomScreenshotCalls[0]?.body ?? "{}").document;
assert((invalidCustomScreenshotDocument.frames?.length ?? 0) === 0, "custom non-image screenshot skipped");
assert(JSON.stringify(invalidCustomScreenshotDocument).includes("invalid custom screenshot"), "rn error kept when screenshot skipped");

const missingScreenshotCalls: Array<{ body: string }> = [];
const missingScreenshotClient = initJayTraceReactNativeReplay({
  apiKey: "rn-key",
  endpoint: "https://api.example.test/jaytrace/rum",
  enabled: true,
  mode: "on-error",
  traceId: "missing-screenshot-trace",
  fetch: async (_url, init) => {
    missingScreenshotCalls.push({ body: String(init?.body) });
    return new Response("ok");
  }
});
await missingScreenshotClient?.recordError(new Error("missing screenshot provider"));
assert(JSON.parse(missingScreenshotCalls[0]?.body ?? "{}").document.metadata?.["replay.screenshot"] === "missing", "rn missing screenshot metadata");

const networkCalls: Array<{ body: string }> = [];
const networkClient = initJayTraceReactNativeReplay({
  apiKey: "rn-key",
  endpoint: "https://api.example.test/jaytrace/rum",
  enabled: true,
  mode: "on-error",
  traceId: "network-trace",
  screenshot: createReactNativeScreenshotProvider({
    captureScreen: () => "bmV0d29yaw==",
    width: 390,
    height: 844
  }),
  fetch: async (_url, init) => {
    networkCalls.push({ body: String(init?.body) });
    return new Response("ok");
  }
});
await networkClient?.recordNetwork({
  method: "get",
  url: "https://api.example.test/fail",
  status: 503,
  durationMs: 7
});
assert(networkCalls.length === 1, "network failure flushes");
assert(JSON.parse(networkCalls[0]?.body ?? "{}").document.frames?.some((frame: { kind: string; type: string }) => frame.kind === "network" && frame.type === "image"), "network failure includes screenshot frame");

const failingScreenshotCalls: Array<{ body: string }> = [];
const failingScreenshotClient = initJayTraceReactNativeReplay({
  apiKey: "rn-key",
  endpoint: "https://api.example.test/jaytrace/rum",
  enabled: true,
  mode: "on-error",
  traceId: "failing-screenshot-trace",
  screenshot: async () => {
    throw new Error("capture failed");
  },
  fetch: async (_url, init) => {
    failingScreenshotCalls.push({ body: String(init?.body) });
    return new Response("ok");
  }
});
await failingScreenshotClient?.recordError(new Error("crash despite screenshot failure"));
assert(failingScreenshotCalls.length === 1, "screenshot failure does not block rn flush");
assert(failingScreenshotCalls[0]!.body.includes("crash despite screenshot failure"), "rn error kept without screenshot");

const failingSenderClient = initJayTraceReactNativeReplay({
  apiKey: "rn-key",
  endpoint: "https://api.example.test/jaytrace/rum",
  enabled: true,
  mode: "on-error",
  traceId: "failing-sender-trace",
  fetch: async () => {
    throw new Error("collector down");
  }
});
await failingSenderClient?.recordError(new Error("app crash"));
assert(Boolean(failingSenderClient?.snapshot().events.some(line => line.includes("app crash"))), "rn sender failure does not drop replay event");

const wrappedCalls: Array<{ headers: HeadersInit | undefined; body: string }> = [];
let wrappedNow = 1000;
const wrappedClient = initJayTraceReactNativeReplay({
  apiKey: "rn-key",
  endpoint: "https://api.example.test/jaytrace/rum",
  enabled: true,
  mode: "on-error",
  traceId: "wrapped-trace",
  fetch: async (_url, init) => {
    wrappedCalls.push({ headers: init?.headers, body: String(init?.body ?? "") });
    return new Response("ok");
  }
});
const tracedFetch = createJayTraceFetch(wrappedClient, {
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  now: () => {
    wrappedNow += 5;
    return wrappedNow;
  },
  fetch: async (_url, init) => {
    wrappedCalls.push({ headers: init?.headers, body: "" });
    return new Response("fail", { status: 503 });
  }
});
await tracedFetch("https://api.example.test/pay", { method: "POST" });
assert(Boolean((wrappedCalls[0]?.headers as Record<string, string>)?.traceparent?.startsWith("00-")), "traceparent injected");
await new Promise(resolve => setTimeout(resolve, 0));
assert(wrappedCalls.length === 2, "wrapped network failure flushed");
assert(JSON.parse(wrappedCalls[1]?.body ?? "{}").apiKey === "rn-key", "wrapped apiKey is not redacted");
assert(Boolean(wrappedCalls[1]?.body.includes("POST redacted status=503 durationMs=5")), "wrapped network captured");

const slowNetworkClient = initJayTraceReactNativeReplay({
  apiKey: "rn-key",
  endpoint: "https://api.example.test/jaytrace/rum",
  enabled: true,
  mode: "on-error",
  traceId: "slow-network-trace",
  fetch: async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return new Response("ok");
  }
});
const slowNetworkFetch = createJayTraceFetch(slowNetworkClient, {
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  fetch: async () => new Response("fail", { status: 503 })
});
const slowStartedAt = Date.now();
await slowNetworkFetch("https://api.example.test/pay");
assert(Date.now() - slowStartedAt < 45, "fetch response does not wait for replay flush");

const requestHeaderCalls: Array<{ headers: HeadersInit | undefined }> = [];
const requestHeaderFetch = createJayTraceFetch(null, {
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  fetch: async (_url, init) => {
    requestHeaderCalls.push({ headers: init?.headers });
    return new Response("ok");
  }
});
await requestHeaderFetch(new Request("https://api.example.test/headers", {
  headers: { authorization: "Bearer token" }
}));
assert((requestHeaderCalls[0]?.headers as Record<string, string>)?.authorization === "Bearer token", "request headers preserved");
assert(Boolean((requestHeaderCalls[0]?.headers as Record<string, string>)?.traceparent?.startsWith("00-")), "request traceparent injected");

const scopedTraceCalls: Array<{ headers: HeadersInit | undefined }> = [];
const scopedTraceFetch = createJayTraceFetch(null, {
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  traceOrigins: ["https://api.example.test"],
  fetch: async (_url, init) => {
    scopedTraceCalls.push({ headers: init?.headers });
    return new Response("ok");
  }
});
await scopedTraceFetch("https://api.example.test/pay");
await scopedTraceFetch("https://analytics.example.test/collect");
assert(Boolean((scopedTraceCalls[0]?.headers as Record<string, string>)?.traceparent?.startsWith("00-")), "rn allowed origin traceparent injected");
assert(!(scopedTraceCalls[1]?.headers as Record<string, string> | undefined)?.traceparent, "rn third-party fetch skips traceparent");

// Session header: the traced fetch stamps x-jaytrace-session from the active-session
// getter, which rotates (Datadog-style) after the 15-minute idle timeout (fake now).
let sessionNow = 0;
const sessionManager = createSessionManager({ now: () => sessionNow });
const sessionHeaderCalls: Array<HeadersInit | undefined> = [];
const sessionFetch = createJayTraceFetch(null, {
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  getSessionId: () => sessionManager.touch(),
  fetch: async (_url, init) => {
    sessionHeaderCalls.push(init?.headers);
    return new Response("ok");
  }
});
await sessionFetch("https://api.example.test/a");
const firstSession = (sessionHeaderCalls[0] as Record<string, string>)?.["x-jaytrace-session"];
sessionNow += 5 * 60 * 1000; // within the idle window -> same session
await sessionFetch("https://api.example.test/b");
sessionNow += 16 * 60 * 1000; // idle beyond 15 min -> rotate
await sessionFetch("https://api.example.test/c");
assert(Boolean(firstSession), "rn session header stamped on traced fetch");
assert((sessionHeaderCalls[1] as Record<string, string>)?.["x-jaytrace-session"] === firstSession, "rn session id stable within idle window");
assert((sessionHeaderCalls[2] as Record<string, string>)?.["x-jaytrace-session"] !== firstSession, "rn session id rotates after idle timeout");

const autoCalls: Array<{ body: string }> = [];
let installedHandler: ((error: Error, isFatal?: boolean) => void) | undefined;
let installedUnhandledRejectionHandler: ((event: { reason?: unknown }) => void) | undefined;
let previousCalled = false;
let previousUnhandledRejectionCalled = false;
const autoClient = initJayTraceReactNativeReplay({
  apiKey: "rn-key",
  endpoint: "https://api.example.test/jaytrace/rum",
  enabled: true,
  mode: "on-error",
  traceId: "auto-trace",
  fetch: async (_url, init) => {
    autoCalls.push({ body: String(init?.body) });
    return new Response("ok");
  }
});
const handlers = installReactNativeReplayErrorHandlers(autoClient, {
  ErrorUtils: {
    getGlobalHandler: () => {
      return () => {
        previousCalled = true;
      };
    },
    setGlobalHandler: handler => {
      installedHandler = handler;
    }
  },
  addEventListener: (_type, handler) => {
    installedUnhandledRejectionHandler = handler;
  },
  removeEventListener: (_type, handler) => {
    if (installedUnhandledRejectionHandler === handler) {
      installedUnhandledRejectionHandler = undefined;
    }
  },
  onunhandledrejection: () => {
    previousUnhandledRejectionCalled = true;
  }
});
installedHandler?.(new Error("auto crash"), true);
installedUnhandledRejectionHandler?.({ reason: new Error("async crash") });
await new Promise(resolve => setTimeout(resolve, 0));
assert(autoCalls.length === 2, "auto handlers flush sync and async errors");
assert(previousCalled, "previous handler called");
assert(previousUnhandledRejectionCalled, "previous unhandled rejection handler called");
handlers.uninstall();
assert(installedUnhandledRejectionHandler === undefined, "unhandled rejection handler removed");

let disabledHandlerInstalled = false;
let disabledUnhandledInstalled = false;
const disabledHandlers = installReactNativeReplayErrorHandlers(null, {
  ErrorUtils: {
    setGlobalHandler: () => {
      disabledHandlerInstalled = true;
    }
  },
  addEventListener: () => {
    disabledUnhandledInstalled = true;
  }
});
disabledHandlers.uninstall();
assert(!disabledHandlerInstalled && !disabledUnhandledInstalled, "null replay client does not patch global handlers");

const oneLineCalls: Array<{ headers: HeadersInit | undefined; body: string }> = [];
let oneLineHandler: ((error: Error, isFatal?: boolean) => void) | undefined;
let appStateListener: ((state: string) => void) | undefined;
let appStateRemoved = false;
let nativeCrashInstalled = false;
let nativeCrashCleared = false;
const previousGlobalFetch = globalThis.fetch;
const oneLine = initJayTraceReactNative({
  apiKey: "rn-key",
  endpoint: "https://api.example.test/jaytrace/rum",
  traceOrigins: ["https://api.example.test"],
  release: "2.0.0",
  environment: "qa",
  replay: {
    privacy: "mask-all",
    maxEvents: 20
  },
  viewTreeThrottleMs: 1,
  fetch: async (_url, init) => {
    oneLineCalls.push({ headers: init?.headers, body: String(init?.body ?? "") });
    return new Response("ok", { status: 503 });
  },
  globals: {
    ErrorUtils: {
      getGlobalHandler: () => undefined,
      setGlobalHandler: handler => {
        oneLineHandler = handler;
      }
    }
  },
  appState: {
    addEventListener: (_type, listener) => {
      appStateListener = listener;
      return {
        remove: () => {
          appStateRemoved = true;
        }
      };
    }
  },
  nativeCrash: {
    install: options => {
      nativeCrashInstalled = Boolean(options.sessionId && options.traceparent);
    },
    getLastCrash: () => ({
      message: "native segfault",
      deviceModel: "iPhone15,2",
      osName: "ios",
      osVersion: "18.5",
      appVersion: "2.0.0",
      nativeCrashId: "crash-1"
    }),
    clearLastCrash: () => {
      nativeCrashCleared = true;
    }
  }
});
await new Promise(resolve => setTimeout(resolve, 0));
assert(oneLine.traceparent.startsWith("00-"), "one-line traceparent generated");
assert(nativeCrashInstalled, "native crash bridge installed");
assert(nativeCrashCleared, "native crash bridge clears drained crash");
assert(oneLine.sessionId.length === 32 && oneLine.sessionId !== oneLine.traceId, "one-line session id generated");
assert((oneLine.headers({ "content-type": "application/json" }) as Record<string, string>).traceparent === oneLine.traceparent, "one-line headers helper injects traceparent");
assert((oneLine.headers(new Headers({ accept: "application/json" })) as Record<string, string>).traceparent === oneLine.traceparent, "one-line headers helper supports Headers");
assert((oneLine.headers([["x-client", "rn"]]) as Record<string, string>).traceparent === oneLine.traceparent, "one-line headers helper supports header tuples");
oneLine.setUser({ id: "one-line-user", token: "secret" });
oneLine.addAction("OneLineCheckout", "token secret");
oneLine.addInput("CouponInput");
oneLine.addScroll("CheckoutList", 640);
oneLine.addPerformance("SlowScreen", 234, "token secret");
oneLine.captureViewTree({ type: "View", props: { label: "first secret" } });
oneLine.captureViewTree({ type: "View", props: { label: "latest secret" } });
await new Promise(resolve => setTimeout(resolve, 5));
appStateListener?.("background");
await new Promise(resolve => setTimeout(resolve, 0));
await oneLine.traceNetwork({
  method: "PUT",
  url: "https://api.example.test/custom-client",
  headers: new Headers({ "content-type": "application/json" }),
  run: async headers => {
    oneLineCalls.push({ headers, body: "" });
    return { status: 503 };
  },
  status: result => result.status
});
await new Promise(resolve => setTimeout(resolve, 0));
const thirdPartyTraceStart = oneLineCalls.length;
await oneLine.traceNetwork({
  method: "GET",
  url: "https://analytics.example.test/custom-client",
  run: async headers => {
    oneLineCalls.push({ headers, body: "" });
    return { status: 503 };
  },
  status: result => result.status
});
await globalThis.fetch("https://api.example.test/one-line", { method: "POST" });
await new Promise(resolve => setTimeout(resolve, 0));
const thirdPartyFetchStart = oneLineCalls.length;
await globalThis.fetch("https://analytics.example.test/collect");
oneLineHandler?.(new Error("one-line crash"), true);
await new Promise(resolve => setTimeout(resolve, 0));
assert(Boolean((oneLineCalls[0]?.headers as Record<string, string>)?.traceparent?.startsWith("00-")), "one-line patches fetch");
assert(Boolean((oneLineCalls.find(call => !call.body)?.headers as Record<string, string> | undefined)?.traceparent?.startsWith("00-")), "one-line traceNetwork injects traceparent");
assert(!((oneLineCalls[thirdPartyTraceStart]?.headers as Record<string, string> | undefined)?.traceparent), "one-line traceNetwork skips third-party traceparent");
assert(!oneLineCalls.slice(thirdPartyTraceStart).some(call => call.body.includes("analytics.example.test/custom-client")), "one-line traceNetwork skips third-party replay");
assert(!((oneLineCalls[thirdPartyFetchStart]?.headers as Record<string, string> | undefined)?.traceparent), "one-line fetch skips third-party traceparent");
assert(!oneLineCalls.slice(thirdPartyFetchStart).some(call => call.body.includes("analytics.example.test/collect")), "one-line fetch skips third-party replay");
assert(oneLineCalls.some(call => call.body.includes("POST redacted status=503")), "one-line network failure flushes");
assert(oneLineCalls.some(call => call.body.includes("PUT redacted status=503")), "one-line traceNetwork records failure");
assert(oneLineCalls.some(call => call.body.includes("one-line crash")), "one-line error handler flushes");
assert(oneLineCalls.some(call => call.body.includes("native segfault")), "native crash drained");
assert(oneLineCalls.some(call => call.body && JSON.parse(call.body).document?.metadata?.["crash.os_version"] === "18.5"), "native crash metadata captured");
assert(oneLineCalls.some(call => call.body.includes("fatal=true")), "one-line fatal errors are marked");
assert(oneLineCalls.some(call => call.body && JSON.parse(call.body).document?.sessionId === oneLine.sessionId), "one-line replay uses session id");
assert(oneLineCalls.some(call => call.body && JSON.parse(call.body).document?.metadata?.release === "2.0.0"), "one-line replay keeps release");
assert(oneLineCalls.some(call => call.body && JSON.parse(call.body).document?.metadata?.environment === "qa"), "one-line replay keeps environment");
assert(oneLineCalls.some(call => call.body && JSON.parse(call.body).document?.metadata?.["user.id"] === "one-line-user"), "one-line setUser forwards to replay");
assert(oneLineCalls.some(call => call.body.includes("action redacted redacted")), "one-line addAction forwards to replay");
assert(oneLineCalls.some(call => call.body.includes("input redacted value=redacted")), "one-line addInput forwards to replay");
assert(oneLineCalls.some(call => call.body.includes("scroll redacted offset=640")), "one-line addScroll forwards to replay");
assert(oneLineCalls.some(call => call.body.includes("performance redacted durationMs=234 redacted")), "one-line addPerformance forwards to replay");
assert(oneLineCalls.some(call => call.body.includes("view_tree")), "one-line throttled view tree captured");
assert(oneLineCalls.some(call => {
  const payload = call.body ? JSON.parse(call.body) : {};
  return payload.reason === "manual" && call.body.includes("action redacted redacted");
}), "app background flushes pending replay");
oneLine.restore();
assert(appStateRemoved, "one-line restore removes app state listener");
assert(globalThis.fetch === previousGlobalFetch, "one-line restore fetch");

const timerCalls: Array<{ body: string }> = [];
const timerClient = initJayTraceReactNative({
  apiKey: "rn-key",
  endpoint: "https://api.example.test/jaytrace/rum",
  patchGlobalFetch: false,
  flushIntervalMs: 1,
  fetch: async (_url, init) => {
    timerCalls.push({ body: String(init?.body ?? "") });
    return new Response("ok");
  }
});
timerClient.addAction("TimerBatch");
await new Promise(resolve => setTimeout(resolve, 10));
timerClient.restore();
assert(timerCalls.length === 1, "rn timer batch flushes replay");

{
  resetJayTraceClientForTest();
  const first = ensureJayTraceClient({
    apiKey: "root-key",
    endpoint: "https://collector.example.test/jaytrace/rum",
    fetch: (async () => ({ ok: true, status: 201 })) as unknown as typeof fetch,
    patchGlobalFetch: false
  });
  const second = ensureJayTraceClient({
    apiKey: "root-key",
    endpoint: "https://collector.example.test/jaytrace/rum",
    patchGlobalFetch: false
  });
  assert(first === second, "ensureJayTraceClient is a singleton across re-mounts");
  assert(first.replay !== null, "root client has replay enabled by default");

  resetJayTraceClientForTest();
  let captured = false;
  const withShot = ensureJayTraceClient({
    apiKey: "root-key",
    endpoint: "https://collector.example.test/jaytrace/rum",
    patchGlobalFetch: false,
    captureScreen: async () => {
      captured = true;
      return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    }
  });
  assert(withShot.replay !== null, "captureScreen config keeps replay enabled");
  resetJayTraceClientForTest();
  void captured;
}

// viewTreeToWireframeNodes / buildWireframeFrame — view-tree to wireframe serialization
{
  const tree: ReactNativeViewTreeNode = {
    type: "View",
    bounds: { x: 0, y: 0, width: 390, height: 844 },
    props: { backgroundColor: "#ffffff" },
    children: [
      {
        type: "View",
        bounds: { x: 16, y: 120, width: 358, height: 48 },
        props: { backgroundColor: "#4950f6", borderRadius: 8 },
        children: [
          {
            type: "Text",
            bounds: { x: 24, y: 132, width: 200, height: 20 },
            props: { text: "Pay now", style: { fontSize: 16, color: "#111" } }
          }
        ]
      },
      {
        type: "Image",
        bounds: { x: 16, y: 200, width: 80, height: 80 }
      },
      {
        // No bounds: must emit no rect of its own, but still recurse into children.
        type: "View",
        props: { backgroundColor: "#000000" },
        children: [
          {
            type: "Text",
            bounds: { x: 0, y: 300, width: 100, height: 20 },
            props: { text: "Skip" }
          }
        ]
      }
    ]
  };

  const masked = viewTreeToWireframeNodes(tree, { maskText: true });
  assert(masked.length === 5, "masked tree emits root rect, button rect, 2 text nodes, 1 image");

  const rootRect = masked.find(n => n.type === "rect" && n.bg === "#ffffff");
  assert(
    Boolean(rootRect) && rootRect?.x === 0 && rootRect?.y === 0 && rootRect?.w === 390 && rootRect?.h === 844,
    "root rect x/y/w/h/bg from bounds+backgroundColor"
  );

  const buttonRect = masked.find(n => n.type === "rect" && n.bg === "#4950f6");
  assert(
    Boolean(buttonRect) &&
      buttonRect?.x === 16 &&
      buttonRect?.y === 120 &&
      buttonRect?.w === 358 &&
      buttonRect?.h === 48 &&
      buttonRect?.radius === 8,
    "button rect x/y/w/h/bg/radius correct"
  );
  assert(masked.filter(n => n.type === "rect").length === 2, "bounds-less wrapper View produced no rect of its own");

  const payTextMasked = masked.find(n => n.type === "text" && n.chars === 7);
  assert(Boolean(payTextMasked), "text node present with chars = length of 'Pay now'");
  assert(payTextMasked?.text === undefined, "text omitted by default (maskText true)");
  assert(payTextMasked?.fontSize === 16 && payTextMasked?.color === "#111", "text node fontSize/color read from style");

  const skipText = masked.find(n => n.type === "text" && n.chars === 4);
  assert(Boolean(skipText), "bounds-less wrapper skipped but its Text child was still emitted");

  const image = masked.find(n => n.type === "image");
  assert(
    Boolean(image) && image?.x === 16 && image?.y === 200 && image?.w === 80 && image?.h === 80,
    "image node present as placeholder with bounds"
  );

  const unmasked = viewTreeToWireframeNodes(tree, { maskText: false });
  const payTextUnmasked = unmasked.find(n => n.type === "text" && n.chars === 7);
  assert(payTextUnmasked?.text === "Pay now", "maskText:false includes the text content");

  const frame = buildWireframeFrame(tree, {
    maskText: true,
    atMs: 120,
    viewport: { width: 390, height: 844 },
    pointer: { x: 24, y: 132, kind: "tap" }
  });
  assert(
    frame.atMs === 120 && frame.viewport.width === 390 && frame.viewport.height === 844 && frame.pointer?.kind === "tap" && frame.nodes.length === 5,
    "buildWireframeFrame assembles atMs/viewport/pointer/nodes"
  );

  const frameNoPointer = buildWireframeFrame(tree, { maskText: true, atMs: 0, viewport: { width: 390, height: 844 } });
  assert(!("pointer" in frameNoPointer), "buildWireframeFrame omits pointer key when not provided");

  // Caps: >1000 bounds-ed children stop emission at 1000 nodes.
  const manyChildren: ReactNativeViewTreeNode[] = [];
  for (let i = 0; i < 1005; i++) {
    manyChildren.push({ type: "Image", bounds: { x: i, y: 0, width: 10, height: 10 } });
  }
  const capRoot: ReactNativeViewTreeNode = {
    type: "View",
    bounds: { x: 0, y: 0, width: 400, height: 800 },
    children: manyChildren
  };
  const capped = viewTreeToWireframeNodes(capRoot, { maskText: true });
  assert(capped.length === 1000, "emitted node count capped at 1000");

  // Style-fallback path: props.backgroundColor/borderRadius and style.fontSize/color
  // are read via `props.X ?? style.X`. Every node above sets the flat prop, so the
  // `?? style.X` half of that fallback was never exercised.
  const styledRect: ReactNativeViewTreeNode = {
    type: "View",
    bounds: { x: 5, y: 5, width: 100, height: 40 },
    props: { style: { backgroundColor: "#00ff00", borderRadius: 12 } }
  };
  const [rectFromStyle] = viewTreeToWireframeNodes(styledRect, { maskText: true });
  assert(
    rectFromStyle?.type === "rect" && rectFromStyle.bg === "#00ff00" && rectFromStyle.radius === 12,
    "rect bg/radius fall back to props.style when no flat backgroundColor/borderRadius prop is set"
  );

  const styledText: ReactNativeViewTreeNode = {
    type: "Text",
    bounds: { x: 0, y: 0, width: 50, height: 20 },
    props: { style: { fontSize: 18, color: "#222" } }
  };
  const [textFromStyle] = viewTreeToWireframeNodes(styledText, { maskText: true });
  assert(
    textFromStyle?.type === "text" && textFromStyle.fontSize === 18 && textFromStyle.color === "#222",
    "text fontSize/color read from props.style"
  );

  // Depth cap: depth counts nesting of *emitted* primitives (matches Flutter's
  // serializer), so a chain of 60 nested Views that all emit (bounds + bg) must
  // still stop well short of 60 once MAX_DEPTH (40) is exceeded.
  function nestedEmittingView(remaining: number): ReactNativeViewTreeNode {
    const base: ReactNativeViewTreeNode = {
      type: "View",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      props: { backgroundColor: "#123456" }
    };
    return remaining <= 1 ? base : { ...base, children: [nestedEmittingView(remaining - 1)] };
  }
  const deepChain = viewTreeToWireframeNodes(nestedEmittingView(60), { maskText: true });
  const deepRects = deepChain.filter(n => n.type === "rect");
  assert(deepRects.length < 60, "depth cap stops emission before the bottom of a 60-deep emitting chain is reached");
  assert(deepRects.length <= 41, "no more than MAX_DEPTH+1 (41) emitted nodes come from a single nesting chain");

  // Boundary: empty-string Text emits a text node with chars 0 and no `text` key (masked).
  const emptyTextTree: ReactNativeViewTreeNode = {
    type: "Text",
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    props: { text: "" }
  };
  const [emptyNode] = viewTreeToWireframeNodes(emptyTextTree, { maskText: true });
  assert(emptyNode?.type === "text" && emptyNode.chars === 0, "empty-string Text -> chars 0");
  assert(!("text" in (emptyNode ?? {})), "empty-string Text emits no text key when masked");

  // Boundary: emoji text masks without throwing and never leaks the raw string.
  const emojiTextTree: ReactNativeViewTreeNode = {
    type: "Text",
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    props: { text: "\u{1F4B3} 결제" } // "💳 결제"
  };
  const [emojiNode] = viewTreeToWireframeNodes(emojiTextTree, { maskText: true });
  assert(emojiNode?.type === "text" && (emojiNode.chars ?? 0) > 0, "emoji Text -> chars > 0");
  assert(!("text" in (emojiNode ?? {})), "emoji Text raw string not present when masked");

  // Boundary: a 10,000-char text node serializes without throwing and reports the right length.
  const hugeText = "x".repeat(10000);
  const hugeTextTree: ReactNativeViewTreeNode = {
    type: "Text",
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    props: { text: hugeText }
  };
  const [hugeNode] = viewTreeToWireframeNodes(hugeTextTree, { maskText: true });
  assert(hugeNode?.type === "text" && hugeNode.chars === 10000, "10,000-char Text serializes with correct chars, no throw");
}

// --- Wireframe capture coordinator (node env, no react-native) ---
{
  const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
  const vp = { width: 390, height: 844 };
  const treeA: ReactNativeViewTreeNode = {
    type: "View",
    bounds: { x: 0, y: 0, width: 390, height: 844 },
    props: { backgroundColor: "#ffffff" },
    children: [{ type: "Text", bounds: { x: 10, y: 10, width: 100, height: 20 }, props: { text: "A" } }]
  };
  const treeB: ReactNativeViewTreeNode = {
    type: "View",
    bounds: { x: 0, y: 0, width: 390, height: 844 },
    props: { backgroundColor: "#000000" },
    children: [{ type: "Text", bounds: { x: 10, y: 10, width: 100, height: 20 }, props: { text: "B" } }]
  };

  // (a) sampleRate 1: distinct trees past segmentFlushMs -> a v2 wireframe segment; (b) dedup.
  {
    const segDocs: ReplayV2SegmentDocument[] = [];
    let t = 0;
    const coord = new ReactNativeWireframeCoordinator({
      sampleRate: 1,
      segmentFlushMs: 1000,
      maxSegmentBytes: 262144,
      maxSessionMs: 1800000,
      wireframeIntervalMs: 800,
      maskText: true,
      sessionId: "rn-wf-session",
      traceId: TRACE,
      metadata: { release: "9.9.9" },
      sendSegment: doc => segDocs.push(doc),
      now: () => new Date(t),
      random: () => 0
    });
    coord.capture(treeA, vp); // segment start 0, atMs 0
    t += 100;
    coord.capture(treeB, vp); // atMs 100, distinct -> added
    t += 100;
    coord.capture(treeB, vp); // identical to last -> dedup skip
    t += 1000; // now 1200; segment started at 0 -> exceeds flushMs 1000
    coord.capture(treeA, vp); // added then triggers flush -> segment sent
    assert(segDocs.length >= 1, "wireframe coordinator sends a segment on flush");
    const wf = segDocs[0]!;
    assert(wf.schema === "jaytrace.replay.v2", "coordinator doc schema is v2");
    assert(wf.engine === "wireframe", "coordinator doc engine is wireframe");
    assert(wf.platform === "react-native", "coordinator doc platform is react-native");
    assert(Array.isArray(wf.wireframeFrames) && wf.wireframeFrames.length === 3, "dedup dropped the repeated frame, 3 distinct kept");
    assert(
      wf.wireframeFrames!.every(
        f =>
          typeof f.atMs === "number" &&
          typeof f.viewport?.width === "number" &&
          Array.isArray(f.nodes) &&
          f.nodes.length > 0 &&
          f.nodes.every(n => typeof n.x === "number" && typeof n.w === "number" && typeof n.type === "string")
      ),
      "coordinator frames carry valid node/viewport shapes"
    );
    assert(wf.wireframeFrames![0]!.atMs === 0, "first frame atMs is segment-relative (0)");
    assert(wf.wireframeFrames![1]!.atMs === 100, "second frame atMs relative to segment start");
  }

  // (c) sampleRate 0: captures buffer to error tail; promoteErrorTail emits exactly one seq-0 error segment.
  {
    const tailDocs: ReplayV2SegmentDocument[] = [];
    let t = 5000;
    const coord = new ReactNativeWireframeCoordinator({
      sampleRate: 0,
      segmentFlushMs: 1000,
      maxSegmentBytes: 262144,
      maxSessionMs: 1800000,
      wireframeIntervalMs: 800,
      maskText: true,
      sessionId: "rn-wf-err",
      traceId: TRACE,
      sendSegment: doc => tailDocs.push(doc),
      now: () => new Date(t),
      random: () => 0.99
    });
    coord.capture(treeA, vp);
    t += 50;
    coord.capture(treeB, vp);
    t += 50;
    assert(tailDocs.length === 0, "unsampled captures send no segments");
    coord.promoteErrorTail();
    assert(tailDocs.length === 1, "promoteErrorTail sends exactly one segment");
    assert(tailDocs[0]!.seq === 0, "error-tail segment is seq 0");
    assert(tailDocs[0]!.engine === "wireframe" && tailDocs[0]!.platform === "react-native", "error-tail segment is a rn wireframe doc");
    assert(tailDocs[0]!.metadata?.["replay.reason"] === "error", "error-tail metadata carries reason=error");
    assert(tailDocs[0]!.metadata?.["replay.sampled"] === "false", "error-tail metadata carries sampled=false");
    assert((tailDocs[0]!.wireframeFrames?.length ?? 0) === 2, "error-tail carries the buffered frames");
    coord.promoteErrorTail();
    assert(tailDocs.length === 1, "promoteErrorTail on an empty tail is a no-op");
  }

  // (d) engine resolution: default wireframe, explicit overrides; screenshot engine constructs no coordinator (no v2 sent).
  {
    assert(resolveReplayEngine({ apiKey: "k", endpoint: "e" }) === "wireframe", "default engine resolves to wireframe");
    assert(resolveReplayEngine({ apiKey: "k", endpoint: "e", replay: { engine: "screenshot" } }) === "screenshot", "engine screenshot resolved");
    assert(resolveReplayEngine({ apiKey: "k", endpoint: "e", replay: { engine: "event" } }) === "event", "engine event resolved");

    const bodies: string[] = [];
    let appStateListener: ((s: string) => void) | undefined;
    const client = initJayTraceReactNative({
      apiKey: "rn-key",
      endpoint: "https://api.example.test/jaytrace/rum",
      patchGlobalFetch: false,
      replay: { engine: "screenshot" },
      fetch: async (_url, init) => {
        bodies.push(String(init?.body ?? ""));
        return new Response("ok");
      },
      appState: {
        addEventListener: (_type, listener) => {
          appStateListener = listener;
          return { remove: () => undefined };
        }
      }
    });
    client.captureViewTree({ type: "View", bounds: { x: 0, y: 0, width: 390, height: 844 }, props: { backgroundColor: "#fff" } });
    appStateListener?.("background");
    await new Promise(resolve => setTimeout(resolve, 5));
    client.restore();
    assert(!bodies.some(b => b.includes("jaytrace.replay.v2")), "engine screenshot never emits a v2 wireframe segment");
  }

  // engine wireframe wiring: captureViewTree feeds the coordinator; background flush emits a v2 wireframe segment.
  {
    const bodies: string[] = [];
    let appStateListener: ((s: string) => void) | undefined;
    const client = initJayTraceReactNative({
      apiKey: "rn-key",
      endpoint: "https://api.example.test/jaytrace/rum",
      patchGlobalFetch: false,
      replay: { engine: "wireframe" },
      fetch: async (_url, init) => {
        bodies.push(String(init?.body ?? ""));
        return new Response("ok");
      },
      appState: {
        addEventListener: (_type, listener) => {
          appStateListener = listener;
          return { remove: () => undefined };
        }
      }
    });
    client.captureViewTree({
      type: "View",
      bounds: { x: 0, y: 0, width: 390, height: 844 },
      props: { backgroundColor: "#ffffff" },
      children: [{ type: "Text", bounds: { x: 10, y: 10, width: 200, height: 20 }, props: { text: "hi" } }]
    });
    appStateListener?.("background");
    await new Promise(resolve => setTimeout(resolve, 5));
    client.restore();
    assert(
      bodies.some(b => b.includes('"schema":"jaytrace.replay.v2"') && b.includes('"engine":"wireframe"')),
      "engine wireframe emits a v2 wireframe segment on background flush"
    );
  }
}

// Privacy invariant (Phase 2 Flutter parity): a default wireframe-engine RN session must never
// invoke a passed screenshot/captureScreen provider — zero base64 pixels ever get uploaded.
{
  let wireframeScreenshotCalls = 0;
  const wireframeBodies: string[] = [];
  const wireframeClient = initJayTraceReactNative({
    apiKey: "rn-key",
    endpoint: "https://api.example.test/jaytrace/rum",
    patchGlobalFetch: false,
    flushIntervalMs: 1,
    // sampleRate 100 = "always" on the v1 client's 0-100 percentage scale (also satisfies
    // the wireframe coordinator's 0-1 fraction scale, since any value >= 1 always samples).
    replay: { enabled: true, mode: "always", engine: "wireframe", sampleRate: 100 },
    screenshot: () => {
      wireframeScreenshotCalls += 1;
      return { image: "data:image/png;base64,AAAA" };
    },
    fetch: async (_url, init) => {
      wireframeBodies.push(String(init?.body ?? ""));
      return new Response("ok");
    }
  });
  wireframeClient.addAction("CheckoutStarted");
  await new Promise(resolve => setTimeout(resolve, 10));
  wireframeClient.restore();
  assert(wireframeScreenshotCalls === 0, "wireframe-engine default never invokes the screenshot provider");
  assert(wireframeBodies.length > 0, "v1 replay document was still posted");
  assert(!wireframeBodies.some(b => b.includes('"type":"image"')), "no v1 replay frame carries an image/screenshot payload");
  assert(!wireframeBodies.some(b => b.includes("AAAA")), "spy screenshot base64 payload never uploaded");

  // Contrast: explicitly opting into engine "screenshot" DOES invoke the same provider.
  let screenshotEngineCalls = 0;
  const screenshotEngineClient = initJayTraceReactNative({
    apiKey: "rn-key",
    endpoint: "https://api.example.test/jaytrace/rum",
    patchGlobalFetch: false,
    flushIntervalMs: 1,
    replay: { enabled: true, mode: "always", engine: "screenshot", sampleRate: 100 },
    screenshot: () => {
      screenshotEngineCalls += 1;
      return { image: "data:image/png;base64,AAAA" };
    },
    fetch: async () => new Response("ok")
  });
  screenshotEngineClient.addAction("CheckoutStarted");
  await new Promise(resolve => setTimeout(resolve, 10));
  screenshotEngineClient.restore();
  assert(screenshotEngineCalls > 0, "engine screenshot explicitly opts in and invokes the provider");
}

// --- Crash isolation: injected SDK failures must never reach the host ---

// (1) A synchronously-throwing sender + a hostile view tree, driven through every
// public method, must not throw out of the SDK nor break the host event loop.
{
  const throwingSender: typeof fetch = () => {
    throw new Error("sender exploded synchronously");
  };
  // Every property access (and JSON.stringify) on this tree throws, exercising
  // captureViewTree, the throttled view-tree timer, and the wireframe timer.
  const hostileTree = new Proxy(
    {},
    {
      get() {
        throw new Error("hostile view tree access");
      }
    }
  ) as unknown as ReactNativeViewTreeNode;
  let hostileAppStateListener: ((state: string) => void) | undefined;

  const hostile = initJayTraceReactNative({
    apiKey: "rn-key",
    endpoint: "https://api.example.test/jaytrace/rum",
    patchGlobalFetch: false,
    viewTreeThrottleMs: 1,
    // small timers so both the throttle and wireframe re-capture fire on the hostile tree
    replay: { enabled: true, mode: "always", engine: "wireframe", sampleRate: 100, wireframeIntervalMs: 1 },
    fetch: throwingSender,
    appState: {
      addEventListener: (_type, listener) => {
        hostileAppStateListener = listener;
        return { remove: () => undefined };
      }
    }
  });

  let threw = false;
  try {
    hostile.headers({ "content-type": "application/json" });
    hostile.setUser({ id: "hostile-user", token: "secret" });
    hostile.addAction("HostileAction", "detail");
    hostile.addInput("HostileInput");
    hostile.addScroll("HostileList", 10);
    hostile.addPerformance("HostilePerf", 5, "detail");
    // valid tree seeds the sampled segmenter; hostile tree stresses serialization
    hostile.captureViewTree({ type: "View", bounds: { x: 0, y: 0, width: 390, height: 844 }, props: { backgroundColor: "#fff" } });
    hostile.captureViewTree(hostileTree);
    await hostile.traceNetwork({
      method: "GET",
      url: "https://api.example.test/hostile",
      run: async () => ({ status: 200 }),
      status: result => result.status
    });
    // background flush drains the sampled segment into the throwing sender
    hostileAppStateListener?.("background");
    await hostile.recordNativeCrash({ message: "hostile crash" });
    // let the throttle + wireframe timers fire against the hostile snapshot
    await new Promise(resolve => setTimeout(resolve, 10));
    hostile.restore();
  } catch {
    threw = true;
  }
  assert(!threw, "injected sender/tree failures never throw out of the RN SDK public API");

  // A subsequent app operation still runs after the SDK swallowed the failures.
  let appStillAlive = false;
  await Promise.resolve().then(() => {
    appStillAlive = true;
  });
  assert(appStillAlive, "host event loop survives injected SDK failures");
}

// (2) Patched-fetch passthrough: SDK bookkeeping throwing must never swallow the
// real response or convert it into a rejection.
{
  // (a) pre-fetch bookkeeping (timing) throws -> the real request still runs.
  const preResponse = new Response("real-body", { status: 201 });
  const preFetch = createJayTraceFetch(null, {
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    now: () => {
      throw new Error("clock exploded");
    },
    fetch: async () => preResponse
  });
  const preResult = await preFetch("https://api.example.test/pay");
  assert(preResult === preResponse, "pre-fetch bookkeeping throw still returns the real response");
  assert(preResult.status === 201, "real response status intact after bookkeeping throw");

  // (b) post-fetch recording throws while building the record (hostile url) ->
  // the successful response is returned, not converted into a rejection.
  const postResponse = new Response("real-body-2", { status: 200 });
  const hostileInput = {
    toString() {
      throw new Error("url stringify exploded");
    }
  } as unknown as string;
  const stubClient = {
    recordNetwork: async () => undefined
  } as unknown as Parameters<typeof createJayTraceFetch>[0];
  const postFetch = createJayTraceFetch(stubClient, {
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    fetch: async () => postResponse
  });
  let postThrew = false;
  let postResult: Response | undefined;
  try {
    postResult = await postFetch(hostileInput);
  } catch {
    postThrew = true;
  }
  assert(!postThrew, "post-fetch recording throw does not reject the real request");
  assert(postResult === postResponse, "post-fetch recording throw returns the real, unswallowed response");
}

// --- Parity gaps: error-tail byte cap, redaction propagation, per-request child
//     traceparent, captureBody ---
{
  const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  // (a) ErrorTailBuffer byte cap: many large distinct frames drain fewer than
  //     were added, and far below the 2000-event ceiling, so only the byte cap
  //     (786_432) can have evicted them — proving maxBytes is passed through.
  {
    const bigTree = (offset: number): ReactNativeViewTreeNode => ({
      type: "View",
      bounds: { x: 0, y: 0, width: 390, height: 844 },
      props: { backgroundColor: "#ffffff" },
      children: Array.from({ length: 1000 }, (_unused, i) => ({
        type: "Text",
        bounds: { x: 0, y: (i + offset) % 844, width: 100, height: 20 },
        props: { text: "abcde", style: { fontSize: 14, color: "#a1b2c3" } }
      }))
    });
    const capDocs: ReplayV2SegmentDocument[] = [];
    let t = 0;
    const coord = new ReactNativeWireframeCoordinator({
      sampleRate: 0,
      segmentFlushMs: 1000,
      maxSegmentBytes: 262144,
      maxSessionMs: 1800000,
      wireframeIntervalMs: 800,
      maskText: true,
      sessionId: "rn-bytecap",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      sendSegment: doc => capDocs.push(doc),
      now: () => new Date(t),
      random: () => 0.99
    });
    const added = 30;
    for (let i = 0; i < added; i += 1) {
      coord.capture(bigTree(i), { width: 390, height: 844 });
      t += 10;
    }
    coord.promoteErrorTail();
    const kept = capDocs[0]?.wireframeFrames?.length ?? 0;
    assert(kept > 0 && kept < added, "error-tail byte cap evicts oldest frames below the event ceiling");
  }

  // (a2) Drain re-primes dedup: an identical frame captured after promoteErrorTail
  //      is not dropped against the stale hash.
  {
    const primeDocs: ReplayV2SegmentDocument[] = [];
    let t = 0;
    const coord = new ReactNativeWireframeCoordinator({
      sampleRate: 0,
      segmentFlushMs: 1000,
      maxSegmentBytes: 262144,
      maxSessionMs: 1800000,
      wireframeIntervalMs: 800,
      maskText: true,
      sessionId: "rn-reprime",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      sendSegment: doc => primeDocs.push(doc),
      now: () => new Date(t),
      random: () => 0.99
    });
    const tree: ReactNativeViewTreeNode = {
      type: "View",
      bounds: { x: 0, y: 0, width: 390, height: 844 },
      props: { backgroundColor: "#ffffff" }
    };
    coord.capture(tree, { width: 390, height: 844 });
    t += 10;
    coord.promoteErrorTail();
    t += 10;
    coord.capture(tree, { width: 390, height: 844 }); // identical -> must NOT dedup after drain
    t += 10;
    coord.promoteErrorTail();
    assert(primeDocs.length === 2, "identical frame after drain is re-captured (lastHash re-primed)");
  }

  // (b) redaction propagation: a custom sensitiveKey (absent from the built-in
  //     defaults, which replay-core already applies) is only redacted when the
  //     redaction option is threaded through to the outer redact call. A control
  //     client without the option leaves the same key untouched.
  {
    const uploadDoc = async (redaction?: { enabled?: boolean; sensitiveKeys?: string[] }) => {
      const bodies: string[] = [];
      let n = 0;
      const c = initJayTraceReactNativeReplay({
        apiKey: "rn-key",
        endpoint: "https://api.example.test/jaytrace/rum",
        enabled: true,
        mode: "on-error",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        metadata: { wibble: "topsecret" },
        ...(redaction ? { redaction } : {}),
        now: () => new Date(n),
        fetch: async (_url, init) => {
          bodies.push(String(init?.body ?? ""));
          return new Response("ok");
        }
      });
      n += 1;
      await c?.recordError(new Error("boom"));
      return JSON.parse(bodies[0] ?? "{}");
    };
    const withOption = await uploadDoc({ sensitiveKeys: ["wibble"] });
    const control = await uploadDoc();
    assert(withOption.document.metadata?.wibble === "redacted", "custom sensitiveKey is redacted (redaction option threaded)");
    assert(control.document.metadata?.wibble === "topsecret", "same key survives without the redaction option (control)");
  }

  // (c) per-request child traceparent: two requests inject distinct child spans
  //     under the same root trace.
  {
    const spanCalls: Array<{ headers: HeadersInit | undefined }> = [];
    const childFetch = createJayTraceFetch(null, {
      traceparent: TP,
      fetch: async (_url, init) => {
        spanCalls.push({ headers: init?.headers });
        return new Response("ok");
      }
    });
    await childFetch("https://api.example.test/a");
    await childFetch("https://api.example.test/b");
    const tp0 = (spanCalls[0]?.headers as Record<string, string>)?.traceparent ?? "";
    const tp1 = (spanCalls[1]?.headers as Record<string, string>)?.traceparent ?? "";
    assert(tp0.startsWith("00-") && tp1.startsWith("00-"), "per-request traceparents are well-formed");
    assert(tp0.split("-")[1] === tp1.split("-")[1], "per-request child spans share the root traceId");
    assert(tp0.split("-")[2] !== tp1.split("-")[2], "consecutive requests carry distinct child spanIds");
  }

  // (d) captureBody: JSON request/response bodies are captured, object-key
  //     redacted, truncated past maxBytes, and unsupported types marked.
  {
    const netEvents: Array<Record<string, unknown>> = [];
    const bodyStub = {
      recordNetwork: async (event: Record<string, unknown>) => {
        netEvents.push(event);
      }
    } as unknown as Parameters<typeof createJayTraceFetch>[0];

    const jsonFetch = createJayTraceFetch(bodyStub, {
      traceparent: TP,
      captureBody: true,
      fetch: async () =>
        new Response(JSON.stringify({ token: "abc", ok: true }), { headers: { "content-type": "application/json" } })
    });
    await jsonFetch("https://api.example.test/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2", note: "keep" })
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const reqBody = netEvents[0]?.requestBody as Record<string, unknown> | undefined;
    const resBody = netEvents[0]?.responseBody as Record<string, unknown> | undefined;
    assert(reqBody?.password === "redacted", "captureBody redacts sensitive request-body keys");
    assert(reqBody?.note === "keep", "captureBody keeps non-sensitive request-body fields");
    assert(resBody?.token === "redacted" && resBody?.ok === true, "captureBody captures and redacts the response body");

    const truncFetch = createJayTraceFetch(bodyStub, {
      traceparent: TP,
      captureBody: { maxBytes: 10 },
      fetch: async () => new Response("ok")
    });
    netEvents.length = 0;
    await truncFetch("https://api.example.test/big", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "this body is definitely longer than ten bytes"
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert(
      typeof netEvents[0]?.requestBody === "string" && (netEvents[0]?.requestBody as string).includes("[truncated]"),
      "captureBody truncates bodies past maxBytes"
    );

    const unsupportedFetch = createJayTraceFetch(bodyStub, {
      traceparent: TP,
      captureBody: true,
      fetch: async () => new Response("ok")
    });
    netEvents.length = 0;
    await unsupportedFetch("https://api.example.test/bin", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "binary-ish"
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert(netEvents[0]?.requestBody === "[unsupported]", "captureBody marks unsupported content-types");
  }

  // (d2) captureBody end-to-end: a failing request emits a redacted network-body
  //      line in the uploaded replay document.
  {
    const uploadCalls: Array<{ body: string }> = [];
    const e2eClient = initJayTraceReactNativeReplay({
      apiKey: "rn-key",
      endpoint: "https://api.example.test/jaytrace/rum",
      enabled: true,
      mode: "on-error",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      fetch: async (_url, init) => {
        uploadCalls.push({ body: String(init?.body ?? "") });
        return new Response("ok");
      }
    });
    const e2eFetch = createJayTraceFetch(e2eClient, {
      traceparent: TP,
      captureBody: true,
      fetch: async () =>
        new Response(JSON.stringify({ password: "leakme", detail: "boom" }), {
          status: 503,
          headers: { "content-type": "application/json" }
        })
    });
    await e2eFetch("https://api.example.test/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true })
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const serialized = JSON.stringify(uploadCalls);
    assert(serialized.includes("network-body"), "captureBody adds a network-body line to the replay document");
    assert(serialized.includes("boom") && !serialized.includes("leakme"), "network-body line carries redacted response body");
  }
}

// --- Timeline event-stream (timeline.v1) parity: dual recording, view exposure ---
{
  const TL_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
  const TL_TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  type TimelinePayload = {
    apiKey?: string;
    reason?: string;
    document?: {
      schema?: string;
      side?: string;
      service?: string;
      traceId?: string;
      sessionId?: string;
      timeline?: unknown[];
      events?: Array<{ kind: string; text: string; severity?: string; data?: Record<string, unknown> }>;
      user?: Record<string, unknown>;
    };
  };

  const timelineBodies: string[] = [];
  let tlNow = 0;
  const tlClient = initJayTraceReactNativeReplay({
    apiKey: "rn-key",
    endpoint: "https://api.example.test/jaytrace/rum",
    enabled: true,
    mode: "always",
    captureTimeline: true,
    service: "rn-checkout",
    traceId: TL_TRACE,
    sessionId: "rn-timeline-session",
    traceparent: TL_TP,
    now: () => new Date(tlNow),
    fetch: async (_url, init) => {
      timelineBodies.push(String(init?.body ?? ""));
      return new Response("ok");
    }
  });

  const timelinePayloads = (): TimelinePayload[] =>
    timelineBodies
      .map(body => {
        try {
          return JSON.parse(body) as TimelinePayload;
        } catch {
          return {} as TimelinePayload;
        }
      })
      .filter(payload => payload.document?.schema === "jaytrace.timeline.v1");

  tlNow += 10;
  tlClient?.setUser({ id: "tl-user-1", token: "secret" });
  tlClient?.recordScreen("Checkout");
  tlClient?.recordTap("PayButton", 12, 34);
  tlClient?.recordView("PromoBanner");
  tlClient?.recordView("PromoBanner"); // duplicate name -> recorded once
  tlClient?.recordPerformance("SlowScreen", 210.4);
  await tlClient?.recordNetwork({
    method: "post",
    url: "https://api.example.test/pay",
    status: 503,
    durationMs: 42,
    requestBody: { password: "hunter2", amount: 100 },
    responseBody: { detail: "boom" }
  });
  await tlClient?.recordError(new Error("checkout blew up"));
  await new Promise(resolve => setTimeout(resolve, 0));

  const payloads = timelinePayloads();
  assert(payloads.length > 0, "timeline document flushed");
  assert(payloads.some(p => p.reason === "error"), "error triggers a timeline flush (reason=error)");
  assert(payloads.every(p => p.apiKey === "rn-key"), "timeline apiKey is not redacted");

  const latest = payloads.at(-1)!.document!;
  const events = latest.events ?? [];
  const kindOf = (kind: string) => events.filter(event => event.kind === kind);

  // --- Synthetic collector-rule verification on the captured POST payload ---
  assert(latest.schema === "jaytrace.timeline.v1", "timeline schema is jaytrace.timeline.v1");
  assert(latest.side === "front", "timeline document side is front");
  assert(latest.service === "rn-checkout", "timeline document carries the configured service");
  assert(/^[0-9a-f]{32}$/.test(latest.traceId ?? ""), "timeline traceId is 32 lowercase hex from the root traceparent");
  assert(latest.sessionId === "rn-timeline-session", "timeline sessionId matches session convention");
  assert(Array.isArray(latest.timeline) && latest.timeline.length > 0, "timeline lines present");
  assert(latest.timeline!.every(line => typeof line === "string"), "every timeline entry is a string");

  // --- Event shapes ---
  const navEvent = kindOf("navigation")[0];
  assert(navEvent?.text === "route Checkout", "navigation event text is 'route <name>'");
  const clickEvent = kindOf("click")[0];
  assert(clickEvent?.text === "click PayButton x=12 y=34", "click event text carries target and coordinates");
  const perfEvent = kindOf("performance")[0];
  assert(perfEvent?.text === "performance SlowScreen durationMs=210", "performance event text with rounded durationMs");

  const fetchEvent = kindOf("fetch")[0];
  assert(Boolean(fetchEvent), "fetch event recorded");
  assert(fetchEvent?.severity === "error", "failing fetch event has error severity");
  assert(Boolean(fetchEvent?.text.includes("durationMs=42")), "fetch event line includes durationMs");
  const reqBody = fetchEvent?.data?.requestBody as Record<string, unknown> | undefined;
  const resBody = fetchEvent?.data?.responseBody as Record<string, unknown> | undefined;
  assert(reqBody?.password === "redacted", "fetch event data redacts sensitive request-body keys");
  assert(reqBody?.amount === 100, "fetch event data keeps non-sensitive request-body fields");
  assert(resBody?.detail === "boom", "fetch event data captures the response body");

  const errorEvent = kindOf("error").at(-1);
  assert(Boolean(errorEvent) && errorEvent!.severity === "error", "error event recorded with error severity");
  assert(errorEvent!.text.includes("checkout blew up"), "error event carries the error message");

  const viewEvents = kindOf("view");
  assert(viewEvents.length === 1, "duplicate view name is deduped to a single timeline event");
  assert(viewEvents[0]?.text === "PromoBanner", "view event text is the resolved name");

  assert(latest.user?.id === "tl-user-1", "setUser is reflected in the timeline document user field");
  assert(latest.user?.token === "redacted", "sensitive user fields are redacted in the timeline document");

  // --- recordView dedupe + 100-per-session cap (via the replay event lines) ---
  const capClient = initJayTraceReactNativeReplay({
    apiKey: "rn-key",
    endpoint: "https://api.example.test/jaytrace/rum",
    enabled: true,
    mode: "always",
    captureTimeline: true,
    traceId: TL_TRACE,
    traceparent: TL_TP,
    now: () => new Date(0),
    fetch: async () => new Response("ok")
  });
  for (let i = 0; i < 150; i += 1) {
    capClient?.recordView(`item-${i}`);
  }
  capClient?.recordView("item-0"); // duplicate -> ignored
  const capViewLines = capClient!.snapshot().events.filter(line => line.includes("mutation view "));
  assert(capViewLines.length === 100, "recordView caps at 100 exposures per session");

  // --- Viewability tracker: onViewableItemsChanged records deduped views ---
  const vtBodies: string[] = [];
  const vtClient = initJayTraceReactNativeReplay({
    apiKey: "rn-key",
    endpoint: "https://api.example.test/jaytrace/rum",
    enabled: true,
    mode: "always",
    captureTimeline: true,
    service: "rn-list",
    traceId: TL_TRACE,
    traceparent: TL_TP,
    now: () => new Date(0),
    fetch: async (_url, init) => {
      vtBodies.push(String(init?.body ?? ""));
      return new Response("ok");
    }
  });
  const tracker = createViewabilityTracker(vtClient, { nameOf: item => (item as { name?: string })?.name });
  assert(tracker.viewabilityConfig.itemVisiblePercentThreshold === 50, "viewability tracker defaults to a 50% visibility threshold");
  tracker.onViewableItemsChanged({
    viewableItems: [
      { item: { name: "RowExplicit" }, index: 0, isViewable: true },
      { item: { key: "row-key" }, index: 1, isViewable: true },
      { item: { id: 7 }, index: 2, isViewable: true },
      { item: { untitled: true }, index: 4, isViewable: true },
      { item: { name: "Hidden" }, index: 3, isViewable: false } // not viewable -> skipped
    ]
  });
  await vtClient?.flush("manual");
  await new Promise(resolve => setTimeout(resolve, 0));
  const vtDoc = vtBodies
    .map(body => {
      try {
        return JSON.parse(body) as TimelinePayload;
      } catch {
        return {} as TimelinePayload;
      }
    })
    .filter(payload => payload.document?.schema === "jaytrace.timeline.v1")
    .at(-1)?.document;
  const vtViews = (vtDoc?.events ?? []).filter(event => event.kind === "view").map(event => event.text);
  assert(vtViews.length === 4, "viewability tracker records one view per viewable item");
  assert(vtViews.includes("RowExplicit"), "nameOf callback takes priority for the item name");
  assert(vtViews.includes("row-key"), "item.key is used when nameOf yields nothing");
  assert(vtViews.includes("7"), "item.id is used when name/key are absent");
  assert(vtViews.includes("4"), "falls back to the index when item has no name/key/id");
  assert(!vtViews.includes("Hidden"), "non-viewable items are not recorded");
}

// --- Custom log API: level severity, redacted context, no error flush ---
{
  const LOG_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
  const LOG_TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  type LogPayload = {
    reason?: string;
    document?: { schema?: string; events?: Array<{ kind: string; text: string; severity?: string; data?: Record<string, unknown> }> };
  };
  const logBodies: string[] = [];
  const logClient = initJayTraceReactNativeReplay({
    apiKey: "rn-key",
    endpoint: "https://api.example.test/jaytrace/rum",
    enabled: true,
    mode: "on-error",
    captureTimeline: true,
    traceId: LOG_TRACE,
    traceparent: LOG_TP,
    now: () => new Date(0),
    fetch: async (_url, init) => {
      logBodies.push(String(init?.body ?? ""));
      return new Response("ok");
    }
  });

  logClient?.log("info", "checkout started", { orderId: 42, token: "secret" });
  logClient?.log("error", "checkout failed"); // error severity but NOT a flush trigger
  assert(logBodies.length === 0, "log() at error level does not trigger a flush");

  // Capture the parallel replay line before flush() clears the replay buffer.
  const logLines = logClient!.snapshot().events.filter(line => line.includes("gesture log "));
  assert(logLines.some(line => line.includes("log checkout started")), "log() also records a parallel replay event line");

  await logClient?.flush("manual");
  await new Promise(resolve => setTimeout(resolve, 0));
  const logDoc = logBodies
    .map(body => {
      try {
        return JSON.parse(body) as LogPayload;
      } catch {
        return {} as LogPayload;
      }
    })
    .filter(p => p.document?.schema === "jaytrace.timeline.v1")
    .at(-1)?.document;
  const logEvents = (logDoc?.events ?? []).filter(e => e.kind === "log");
  const infoLog = logEvents.find(e => e.text === "log checkout started");
  assert(Boolean(infoLog), "log() records a `log <message>` timeline event");
  assert(infoLog?.severity === "info", "log() maps the level to the event severity");
  assert((infoLog?.data as { orderId?: number } | undefined)?.orderId === 42, "log() attaches non-sensitive context data");
  assert((infoLog?.data as { token?: string } | undefined)?.token === "redacted", "log() redacts sensitive context keys");
  const errorLog = logEvents.find(e => e.text === "log checkout failed");
  assert(errorLog?.severity === "error", "log() at error level records error severity");
}

// --- captureConsole: pass-through, serialization caps, repeat suppression, restore ---
{
  const CON_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
  const CON_TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  type ConPayload = { document?: { schema?: string; events?: Array<{ kind: string; text: string; severity?: string }> } };
  const conTimelineLogs = (bodies: string[]) =>
    (bodies
      .map(body => {
        try {
          return JSON.parse(body) as ConPayload;
        } catch {
          return {} as ConPayload;
        }
      })
      .filter(p => p.document?.schema === "jaytrace.timeline.v1")
      .at(-1)?.document?.events ?? []).filter(e => e.kind === "log");

  const globalConsole = globalThis as unknown as { console: Record<string, (...a: unknown[]) => void> };
  const originalConsole = globalConsole.console;

  // Stub the global console so we can assert the host's original call passes through.
  const passthrough: Array<{ method: string; args: unknown[] }> = [];
  globalConsole.console = {
    ...originalConsole,
    error: (...args: unknown[]) => passthrough.push({ method: "error", args }),
    warn: (...args: unknown[]) => passthrough.push({ method: "warn", args }),
    log: (...args: unknown[]) => passthrough.push({ method: "log", args })
  } as unknown as typeof originalConsole;

  const conBodies: string[] = [];
  const conClient = initJayTraceReactNativeReplay({
    apiKey: "rn-key",
    endpoint: "https://api.example.test/jaytrace/rum",
    enabled: true,
    mode: "always",
    captureTimeline: true,
    captureConsole: ["error", "warn", "log"],
    traceId: CON_TRACE,
    traceparent: CON_TP,
    now: () => new Date(0),
    fetch: async (_url, init) => {
      conBodies.push(String(init?.body ?? ""));
      return new Response("ok");
    }
  });

  console.error("boom", { code: 500 });
  console.log("dup");
  console.log("dup"); // duplicate text -> suppressed
  console.warn("x".repeat(3000)); // oversized string -> line capped at 2000
  console.log({ big: "y".repeat(1000) }); // oversized object -> arg capped at 500

  assert(passthrough.length === 5, "captureConsole always runs the host's original console call");
  assert(passthrough[0]?.method === "error", "captureConsole preserves the console method invoked");

  await conClient?.flush("manual");
  await new Promise(resolve => setTimeout(resolve, 0));
  const conLogs = conTimelineLogs(conBodies);
  const errLog = conLogs.find(e => e.text.startsWith("console.error "));
  assert(Boolean(errLog), "captureConsole records a `console.<method> ...` log event");
  assert(errLog?.severity === "error", "console.error maps to error severity");
  assert(errLog!.text.includes("boom") && errLog!.text.includes("500"), "captureConsole serializes the console arguments");
  const dupLogs = conLogs.filter(e => e.text === "console.log dup");
  assert(dupLogs.length === 1, "captureConsole suppresses repeated identical lines");
  const warnLog = conLogs.find(e => e.text.startsWith("console.warn "));
  assert((warnLog?.text.length ?? 0) <= "console.warn ".length + 2000, "captureConsole caps a single line at 2000 chars");
  const objLog = conLogs.find(e => e.text.startsWith("console.log {"));
  assert(Boolean(objLog) && objLog!.text.length <= "console.log ".length + 500, "captureConsole caps a serialized object arg at 500 chars");

  // restore() unpatches: later console output is no longer captured.
  conClient?.restore();
  console.error("after restore");
  await conClient?.flush("manual");
  await new Promise(resolve => setTimeout(resolve, 0));
  const afterLogs = conTimelineLogs(conBodies);
  assert(!afterLogs.some(e => e.text.includes("after restore")), "restore() unpatches console so later output is not captured");
  assert(typeof globalConsole.console.error === "function", "restore() puts the original console method back");

  // --- 30 unique-line cap per session ---
  const capBodies: string[] = [];
  globalConsole.console = {
    ...originalConsole,
    log: () => {}
  } as unknown as typeof originalConsole;
  const capClient = initJayTraceReactNativeReplay({
    apiKey: "rn-key",
    endpoint: "https://api.example.test/jaytrace/rum",
    enabled: true,
    mode: "always",
    captureTimeline: true,
    captureConsole: ["log"],
    traceId: CON_TRACE,
    traceparent: CON_TP,
    maxTimelineEvents: 200,
    now: () => new Date(0),
    fetch: async (_url, init) => {
      capBodies.push(String(init?.body ?? ""));
      return new Response("ok");
    }
  });
  for (let i = 0; i < 50; i += 1) {
    console.log(`unique-${i}`);
  }
  await capClient?.flush("manual");
  await new Promise(resolve => setTimeout(resolve, 0));
  capClient?.restore();
  const capLogs = conTimelineLogs(capBodies).filter(e => e.text.startsWith("console.log unique-"));
  assert(capLogs.length === 30, "captureConsole caps unique console lines at 30 per session");

  // Restore the real console for the remainder of the suite.
  globalConsole.console = originalConsole;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`self-check failed: ${message}`);
  }
}
