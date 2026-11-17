import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// E2E smoke for "React Native wireframe replay v2" (jaytrace.replay.v2, engine: "wireframe",
// platform: "react-native"). Modeled directly on wireframe-console-smoke.mjs (the Flutter
// synthetic wireframe smoke) -- the schema, collector, and console WireframePlayer are all
// platform-agnostic (Phase 2), so this posts two synthetic RN wireframe segments straight to
// the collector (no SDK/browser capture involved), then asserts the pipeline end to end:
// collector -> S3 -> /api/replay merge -> console WireframePlayer.
//
// Also posts one jaytrace.timeline.v1 "front" document for the same traceId/sessionId.
// This is NOT optional: apps/next-app/app/api/lib/documents.ts only builds trace
// rows (and therefore sessions) from v1 timeline/replay documents -- a v2 segment alone
// never appears in /api/traces. Without a matching trace, page.tsx's `selectedTrace`
// stays undefined and the console renders "No trace selected" instead of the wireframe
// player, so the CDP assertions below could never pass.
//
// Assumes the collector (:3012) and console (:3022) are already running.

const collectorUrl = process.env.JAYTRACE_COLLECTOR_URL ?? "http://localhost:3012/jaytrace/rum";
const consoleUrl = process.env.JAYTRACE_CONSOLE_URL ?? "http://localhost:3022";
const apiKey = process.env.JAYTRACE_API_KEY ?? "local-dev-key";
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromePort = Number(process.env.JAYTRACE_RN_WF_CHROME_PORT ?? 9230);
const days = 1;

// Deterministic per run: a fixed hex prefix (distinct from the Flutter smoke's 7-prefix) +
// a 12-hex timestamp suffix, same shape as wireframe-console-smoke.mjs's traceId construction
// (20 + 12 = 32 hex chars).
const suffix = Date.now().toString(16).padStart(12, "0").slice(-12);
const traceId = `88888888888888888888${suffix}`;
const sessionId = `rn-wireframe-smoke-session-${suffix}`;

const baseMs = Date.now();
const seg0StartedAt = new Date(baseMs).toISOString();
const seg0EndedAt = new Date(baseMs + 500).toISOString();
const seg1StartedAt = new Date(baseMs + 1000).toISOString();
const seg1EndedAt = new Date(baseMs + 1500).toISOString();

const metadata = { "view.name": "Checkout", release: "rn-wf-smoke", environment: "qa" };

const timelineDoc = {
  schema: "jaytrace.timeline.v1",
  service: "rn-app",
  side: "front",
  traceId,
  sessionId,
  startedAt: seg0StartedAt,
  endedAt: seg1EndedAt,
  summary: "React Native wireframe smoke session",
  timeline: [
    "0.000s navigation route Checkout",
    "1.500s navigation route Checkout"
  ]
};

const seg0 = {
  schema: "jaytrace.replay.v2",
  engine: "wireframe",
  platform: "react-native",
  traceId,
  sessionId,
  seq: 0,
  startedAt: seg0StartedAt,
  endedAt: seg0EndedAt,
  metadata,
  wireframeFrames: [
    {
      atMs: 0,
      viewport: { width: 390, height: 844 },
      nodes: [
        { type: "rect", x: 0, y: 0, w: 390, h: 844, bg: "#ffffff" },
        { type: "rect", x: 16, y: 120, w: 358, h: 48, bg: "#4950f6", radius: 8 },
        { type: "text", x: 24, y: 132, w: 200, h: 20, chars: 7, fontSize: 16, color: "#111111" }
      ]
    },
    {
      atMs: 400,
      viewport: { width: 390, height: 844 },
      pointer: { x: 195, y: 632, kind: "tap" },
      nodes: [
        { type: "rect", x: 0, y: 0, w: 390, h: 844, bg: "#ffffff" },
        { type: "rect", x: 16, y: 120, w: 358, h: 48, bg: "#4950f6", radius: 8 },
        { type: "image", x: 16, y: 200, w: 80, h: 80 }
      ]
    }
  ]
};

const seg1 = {
  schema: "jaytrace.replay.v2",
  engine: "wireframe",
  platform: "react-native",
  traceId,
  sessionId,
  seq: 1,
  startedAt: seg1StartedAt,
  endedAt: seg1EndedAt,
  metadata,
  wireframeFrames: [
    {
      atMs: 0,
      viewport: { width: 390, height: 844 },
      nodes: [
        { type: "rect", x: 0, y: 0, w: 390, h: 844, bg: "#f5f5f5" },
        { type: "rect", x: 16, y: 400, w: 358, h: 48, bg: "#22c55e", radius: 8 }
      ]
    },
    {
      atMs: 300,
      viewport: { width: 390, height: 844 },
      nodes: [
        { type: "rect", x: 0, y: 0, w: 390, h: 844, bg: "#f5f5f5" },
        { type: "text", x: 24, y: 412, w: 200, h: 20, chars: 10, fontSize: 16, color: "#111111" }
      ]
    }
  ]
};

await postDocument(timelineDoc, "manual");
await postDocument(seg0, "segment");
await postDocument(seg1, "segment");

const replay = await assertReplayApi();

const chrome = spawn(chromePath, [
  "--headless=new",
  `--remote-debugging-port=${chromePort}`,
  `--user-data-dir=${await mkdtemp(join(tmpdir(), "jaytrace-rn-wireframe-chrome-"))}`,
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank"
], { stdio: "ignore" });

try {
  await waitForChrome();
  const consoleTab = await openTab(`${consoleUrl}/?traceId=${encodeURIComponent(traceId)}&sessionId=${encodeURIComponent(sessionId)}&view=sessions&days=${days}`);
  let rectNodes;
  try {
    rectNodes = await assertConsolePlayer(consoleTab.send);
  } finally {
    consoleTab.ws.close();
  }
  console.log(JSON.stringify({
    ok: true,
    platform: "react-native",
    sessionId,
    segments: replay.segments,
    wireframeFrames: replay.wireframeFrames.length,
    rectNodes
  }));
} finally {
  chrome.kill();
}

// ---- Collector POST ---------------------------------------------------------

async function postDocument(document, reason) {
  const response = await fetch(collectorUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      traceparent: `00-${traceId}-0123456789abcdef-01`
    },
    body: JSON.stringify({ apiKey, reason, document })
  });
  if (response.status !== 201) {
    throw new Error(`collector rejected ${reason} document (schema=${document.schema}): ${response.status} ${await response.text()}`);
  }
}

// ---- /api/replay assertion (S3-backed, so retry ~20s) ------------------------

async function assertReplayApi() {
  const url = `${consoleUrl}/api/replay?sessionId=${encodeURIComponent(sessionId)}&traceId=${encodeURIComponent(traceId)}&days=${days}`;
  let last = null;
  for (let i = 0; i < 20; i += 1) {
    const response = await fetch(url);
    if (response.status === 200) {
      const payload = await response.json();
      const frames = payload.wireframeFrames ?? [];
      const monotonic = frames.every((frame, index) => index === 0 || frame.atMs >= frames[index - 1].atMs);
      last = { status: 200, engine: payload.engine, segments: payload.segments, frameCount: frames.length, monotonic };
      if (payload.engine === "wireframe" && payload.segments >= 2 && frames.length >= 3 && monotonic) {
        return payload;
      }
    } else {
      last = { status: response.status };
    }
    await sleep(1000);
  }
  throw new Error(`rn wireframe replay not ready for ${sessionId}: ${JSON.stringify(last)}`);
}

// ---- Console CDP assertion ----------------------------------------------------

async function assertConsolePlayer(send) {
  // Next dev cold compiles of the console route have been observed to take ~11s;
  // pre-warm the route once so the poll loop below isn't spending its budget
  // waiting out the first compile (same rationale as wireframe-console-smoke.mjs).
  await fetch(consoleUrl).catch(() => {});
  await sleep(2000);

  for (let i = 0; i < 60; i += 1) {
    const value = await evaluate(send, `(() => {
      const svg = document.querySelector('.replayPlayer [data-wireframe]') || document.querySelector('.replayPlayer svg[data-wireframe]');
      const scrubber = document.querySelector('.replayScrubber');
      const toggle = document.querySelector('.replayPlayToggle');
      const rects = svg ? svg.querySelectorAll('rect').length : 0;
      return { svg: Boolean(svg), scrubber: Boolean(scrubber), toggle: Boolean(toggle), rects };
    })()`);
    if (value?.svg && value?.scrubber && value?.toggle && value?.rects >= 3) {
      return value.rects;
    }
    await sleep(1000);
  }
  throw new Error("console did not render the wireframe player (.replayPlayer [data-wireframe] svg + rect>=3 + .replayScrubber/.replayPlayToggle)");
}

// ---- CDP plumbing ----------------------------------------------------------

async function openTab(url) {
  const target = await (await fetch(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  const send = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise(resolve => pending.set(id, resolve));
  };

  await send("Runtime.enable");
  await send("Page.enable");

  return { send, ws };
}

// Evaluate an expression, returning its value; throws on CDP-level or page
// exceptions so callers never silently read `undefined`.
async function evaluate(send, expression) {
  const message = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (message.error) {
    throw new Error(`CDP evaluate failed: ${message.error.message}`);
  }
  const details = message.result?.exceptionDetails;
  if (details) {
    throw new Error(`page threw during evaluate: ${details.text ?? details.exception?.description ?? "unknown"}`);
  }
  return message.result?.result?.value;
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
