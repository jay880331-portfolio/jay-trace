import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const collectorUrl = process.env.JAYTRACE_COLLECTOR_URL ?? "http://localhost:3012/jaytrace/rum";
const consoleUrl = process.env.JAYTRACE_CONSOLE_URL ?? "http://localhost:3022";
const apiKey = process.env.JAYTRACE_API_KEY ?? "local-dev-key";
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromePort = Number(process.env.JAYTRACE_MOBILE_CHROME_PORT ?? 9226);
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const startedAt = new Date().toISOString();
const suffix = Date.now().toString(16).padStart(12, "0").slice(-12);
const documents = [
  replay({
    platform: "react-native",
    traceId: `33333333333333333333${suffix}`,
    sessionId: "s3-mobile-session-rn",
    metadata: { release: "1.0.0-rn", environment: "qa", "user.id": "mobile-user-rn", "view.name": "Checkout", os: "ios", device: "iPhone S3 Smoke" },
    action: "tap PayButton x=210 y=640",
    performance: "performance JSFrameBlocked durationMs=124",
    network: "POST https://api.example.test/pay status=500 durationMs=70",
    error: "Error: rn s3 payment failed",
    x: 210,
    y: 640,
    width: 390,
    height: 844
  }),
  replay({
    platform: "flutter",
    traceId: `44444444444444444444${suffix}`,
    sessionId: "s3-mobile-session-flutter",
    metadata: { release: "1.0.0-flutter", environment: "qa", "user.id": "mobile-user-flutter", "view.name": "Checkout", os: "android", device: "Pixel S3 Smoke" },
    action: "tap ElevatedButton#pay x=205 y=632",
    performance: "performance RasterBlocked durationMs=123",
    network: "POST https://api.example.test/pay status=500 durationMs=73",
    error: "Exception: flutter s3 payment failed",
    x: 205,
    y: 632,
    width: 393,
    height: 852
  })
];

for (const document of documents) {
  await postReplay(document);
}

await new Promise(resolve => setTimeout(resolve, Number(process.env.JAYTRACE_S3_WAIT_MS ?? 2500)));

const results = [];
const chrome = spawn(chromePath, [
  "--headless=new",
  `--remote-debugging-port=${chromePort}`,
  `--user-data-dir=${await mkdtemp(join(tmpdir(), "jaytrace-mobile-chrome-"))}`,
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank"
], { stdio: "ignore" });

try {
  await waitForChrome();
  for (const document of documents) {
    const { session, replayDoc, sourceMode } = await readTrace(document);
    const pointFrame = replayDoc.frames.find(frame => typeof frame.x === "number" && typeof frame.y === "number");
    const inputFrame = replayDoc.frames.find(frame => frame.kind === "input" && /value=redacted/.test(frame.text ?? ""));
    const scrollFrame = replayDoc.frames.find(frame => frame.kind === "scroll" && /offset=/.test(frame.text ?? ""));
    const performanceFrame = replayDoc.frames.find(frame => /performance .*durationMs=/.test(frame.text ?? ""));
    const networkFrame = replayDoc.frames.find(frame => frame.kind === "network" && /status=5\d\d/.test(frame.text ?? ""));
    const consoleReplay = await waitForConsoleReplayImage(document);
    results.push({
      traceId: document.traceId,
      platform: document.platform,
      frames: replayDoc.frames.length,
      screens: replayDoc.frames.filter(frame => frame.image).length,
      consoleReplayImages: consoleReplay.images,
      consoleFilmFrames: consoleReplay.filmFrames,
      consoleFailureVisible: consoleReplay.failureVisible,
      consolePerformanceFilterVisible: consoleReplay.performanceFilterVisible,
      consoleSummaryCopyVisible: consoleReplay.summaryCopyVisible,
      point: pointFrame ? `${pointFrame.x},${pointFrame.y}` : "missing",
      input: inputFrame?.text ?? "missing",
      scroll: scrollFrame?.text ?? "missing",
      performance: performanceFrame?.text ?? "missing",
      network: networkFrame?.text ?? "missing",
      sessionId: session.sessionId,
      release: replayDoc.metadata.release,
      environment: replayDoc.metadata.environment,
      userId: replayDoc.metadata["user.id"],
      viewName: replayDoc.metadata["view.name"],
      sourceMode
    });
  }
} finally {
  chrome.kill();
}

console.log(JSON.stringify({ ok: true, collectorUrl, consoleUrl, results }, null, 2));

function replay({ platform, traceId, sessionId, metadata, action, performance, network, error, x, y, width, height }) {
  return {
    schema: "jaytrace.replay.v1",
    platform,
    traceId,
    sessionId,
    mode: "on-error",
    startedAt,
    endedAt: startedAt,
    metadata: {
      "replay.screenshot": "enabled",
      ...metadata,
      appVersion: "1.0.0"
    },
    events: [
      "0.000s route screen Checkout",
      "0.180s input input EmailInput value=redacted",
      "0.240s scroll scroll CheckoutList offset=320",
      `0.300s gesture ${action}`,
      `0.420s gesture ${performance}`,
      `0.600s network ${network}`,
      `0.620s error ${error}`
    ],
    frames: [
      frame("0.000s", "screenshot", "screen Checkout", width, height),
      frame("0.180s", "input", "input EmailInput value=redacted", width, height),
      frame("0.240s", "scroll", "scroll CheckoutList offset=320", width, height),
      frame("0.300s", "gesture", action, width, height, x, y),
      frame("0.420s", "gesture", performance, width, height),
      frame("0.600s", "network", network, width, height)
    ]
  };
}

function frame(at, kind, text, width, height, x, y) {
  return {
    at,
    kind,
    text,
    type: "image",
    image: pixel,
    mediaType: "image/png",
    width,
    height,
    ...(x === undefined ? {} : { x, y })
  };
}

async function postReplay(document) {
  const response = await fetch(collectorUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      traceparent: `00-${document.traceId}-0123456789abcdef-01`
    },
    body: JSON.stringify({
      apiKey,
      reason: "error",
      document
    })
  });
  if (response.status !== 201) {
    throw new Error(`collector rejected ${document.platform} ${document.traceId}: ${response.status} ${await response.text()}`);
  }
}

async function readTrace(document) {
  const response = await fetch(`${consoleUrl}/api/traces?traceId=${document.traceId}&platform=${document.platform}&screens=1&days=1`);
  if (!response.ok) {
    throw new Error(`console read failed ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json();
  const trace = payload.traces?.find(item => item.traceId === document.traceId);
  const replayDoc = trace?.replays?.[0];
  const session = payload.sessions?.find(item => item.sessionId === document.sessionId);
  const metadata = replayDoc?.metadata ?? {};
  const pointFrame = replayDoc?.frames?.find(frame => typeof frame.x === "number" && typeof frame.y === "number");
  const inputFrame = replayDoc?.frames?.find(frame => frame.kind === "input" && /value=redacted/.test(frame.text ?? ""));
  const scrollFrame = replayDoc?.frames?.find(frame => frame.kind === "scroll" && /offset=/.test(frame.text ?? ""));
  const performanceFrame = replayDoc?.frames?.find(frame => /performance .*durationMs=/.test(frame.text ?? ""));
  const networkFrame = replayDoc?.frames?.find(frame => frame.kind === "network" && /status=5\d\d/.test(frame.text ?? ""));
  if (
    !trace ||
    payload.sourceMode !== "s3" ||
    replayDoc?.platform !== document.platform ||
    replayDoc?.frames?.length !== 6 ||
    replayDoc.frames.filter(frame => frame.image).length !== 6 ||
    !pointFrame ||
    !inputFrame ||
    !scrollFrame ||
    !performanceFrame ||
    !networkFrame ||
    metadata.release !== document.metadata.release ||
    metadata.environment !== document.metadata.environment ||
    metadata["user.id"] !== document.metadata["user.id"] ||
    metadata["view.name"] !== document.metadata["view.name"] ||
    !session?.platforms?.includes(document.platform)
  ) {
    throw new Error(`missing S3 replay for ${document.platform} ${document.traceId}`);
  }
  return { trace, replayDoc, session, sourceMode: payload.sourceMode };
}

async function waitForConsoleReplayImage(document) {
  const target = await (await fetch(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(`${consoleUrl}/?traceId=${document.traceId}&platform=${document.platform}&screens=1&view=issues`)}`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise(resolve => ws.addEventListener("open", resolve, { once: true }));
  const send = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise(resolve => pending.set(id, resolve));
  };
  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  await send("Runtime.enable");

  for (let i = 0; i < 60; i += 1) {
    const result = await send("Runtime.evaluate", {
      expression: `(() => ({
        images: [...document.querySelectorAll(".replayImage")].filter(image => image.naturalWidth > 0).length,
        filmFrames: document.querySelectorAll(".filmFrame").length,
        failureVisible: document.body?.innerText?.includes("status=500") ?? false,
        performanceFilterVisible: document.body?.innerText?.includes("성능 1") ?? false,
        summaryCopyVisible: document.body?.innerText?.includes("요약 복사") ?? false,
        traceLoaded: document.body?.innerText?.includes("${document.traceId}") ?? false
      }))()`,
      returnByValue: true
    });
    const value = result.result?.result?.value;
    if (value?.images > 0 && value?.filmFrames > 0 && value?.failureVisible && value?.performanceFilterVisible && value?.summaryCopyVisible && value?.traceLoaded) {
      ws.close();
      return {
        images: value.images,
        filmFrames: value.filmFrames,
        performanceFilterVisible: value.performanceFilterVisible,
        summaryCopyVisible: value.summaryCopyVisible,
        failureVisible: value.failureVisible
      };
    }
    await sleep(1000);
  }

  ws.close();
  throw new Error(`console did not render mobile replay image for ${document.platform} ${document.traceId}`);
}

async function waitForChrome() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${chromePort}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new Error("Chrome CDP did not start");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
