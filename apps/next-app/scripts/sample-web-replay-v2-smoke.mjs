import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// E2E smoke for "JayTrace web replay v2" (always-on rrweb capture).
// Assumes sample-web (SAMPLE_WEB_URL), the JayTrace collector, and the console
// (JAYTRACE_CONSOLE_URL) are already running. Records ~25s of scripted activity
// WITHOUT the error button, asserts >=2 v2 segments landed, that the console
// rrweb player renders, then runs a separate error-regression click.
//
// Modeled on sample-web-web-smoke.mjs (CDP spawn/waitForChrome/send loop reused).

const sampleWebUrl = process.env.SAMPLE_WEB_URL ?? "http://localhost:3014/ko/jaytrace-qa";
const consoleUrl = process.env.JAYTRACE_CONSOLE_URL ?? "http://localhost:3022";
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromePort = Number(process.env.JAYTRACE_V2_CHROME_PORT ?? 9228);

const chrome = spawn(chromePath, [
  "--headless=new",
  `--remote-debugging-port=${chromePort}`,
  `--user-data-dir=${await mkdtemp(join(tmpdir(), "jaytrace-sample-web-v2-chrome-"))}`,
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank"
], { stdio: "ignore" });

try {
  await waitForChrome();
  const result = await runSmoke();
  console.log(JSON.stringify({ ok: true, ...result }));
} finally {
  chrome.kill();
}

async function runSmoke() {
  // Keep the sample-web tab alive for the whole run: it holds the SDK + error
  // button (needed again in Phase 5). Phase 4 opens the console in a 2nd tab.
  const sampleTab = await openTab(sampleWebUrl);
  try {
    // Phase 1 — record. Wait for the SDK, then drive ~25s of activity that
    // never touches the error button so mode=always flushes >=2 segments
    // (first at ~10s, second at ~20s).
    await waitForSdk(sampleTab.send);
    await recordActivity(sampleTab.send, 25);

    // Phase 2 — resolve the session id the segments were tagged with.
    const { sessionId, traceId } = await resolveSession(sampleTab.send);

    // Phase 3 — assert segments (S3-backed, so retry ~20s).
    const replay = await assertSegments(sessionId);

    // Phase 4 — assert the console player renders (separate console tab).
    const consoleTab = await openTab(`${consoleUrl}/?traceId=${encodeURIComponent(traceId)}&sessionId=${encodeURIComponent(sessionId)}&view=sessions&days=1`);
    let playerDomNodes;
    try {
      playerDomNodes = await assertPlayer(consoleTab.send);
    } finally {
      consoleTab.ws.close();
    }

    // Phase 5 — error regression on the still-live sample-web tab.
    await assertErrorRegression(sampleTab);

    return {
      sessionId,
      segments: replay.segments,
      rrwebEventCount: replay.rrwebEventCount,
      fullSnapshot: true,
      playerDomNodes,
      errorRegression: "pass"
    };
  } finally {
    sampleTab.ws.close();
  }
}

// ---- Phase 1 ---------------------------------------------------------------

async function recordActivity(send, seconds) {
  const iterations = Math.max(1, Math.round((seconds * 1000) / 2000));
  for (let i = 0; i < iterations; i += 1) {
    // Synthetic interactions that generate rrweb mutations/scroll/input events
    // but deliberately avoid the "Trigger replay failure" button.
    await evaluate(send, `(() => {
      window.scrollTo(0, 200 + (${i} % 4) * 180);
      if (document.body) document.body.click();
      const field = document.querySelector('input:not([type=hidden]), textarea, [contenteditable]');
      if (field) {
        field.focus();
        if ('value' in field) {
          field.value = 'jaytrace-v2-' + ${i} + '-' + Date.now();
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      window.scrollTo(0, 0);
      return true;
    })()`);
    await sleep(2000);
  }
}

// ---- Phase 2 ---------------------------------------------------------------

async function resolveSession(send) {
  // Preferred: direct extraction. The public SDK client only guarantees
  // `traceparent`; `sessionId` is a constructor local and is usually undefined
  // on window.__jayTraceClient. We try it anyway, then fall back.
  const value = await evaluate(send, `(() => {
    const c = window.__jayTraceClient;
    return { sessionId: (c && c.sessionId) || null, traceparent: (c && c.traceparent) || null };
  })()`);

  const traceparent = value?.traceparent ?? "";
  const traceId = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(traceparent)?.[1] ?? null;

  // Fallback A (deterministic): the RUM timeline docs the SDK uploads for THIS
  // session are grouped under `traceId` in /api/traces, and the group carries
  // the sessionId the segments share. Poll until that trace surfaces (S3 delay),
  // which also guarantees Phase 4's console detail will find the trace.
  if (traceId) {
    const trace = await pollForTrace(traces => traces.find(t => t.traceId === traceId));
    if (trace) {
      const sessionId = value?.sessionId ?? trace.sessionId ?? trace.replays?.[0]?.sessionId ?? null;
      if (sessionId) {
        return { sessionId, traceId };
      }
    }
  }

  // If the SDK did expose a sessionId directly, resolve a traceId for the player.
  if (value?.sessionId) {
    const trace = await pollForTrace(traces => traces.find(t => sessionOf(t) === value.sessionId));
    if (trace) {
      return { sessionId: value.sessionId, traceId: trace.traceId };
    }
  }

  // Fallback B (last resort): no traceparent link — walk sessions newest-first
  // and let the first /api/replay 200 win. First /api/traces call is newest-first.
  const list = await fetchJson(`${consoleUrl}/api/traces?days=1&limit=200`);
  for (const session of list.sessions ?? []) {
    const probe = await fetch(`${consoleUrl}/api/replay?sessionId=${encodeURIComponent(session.sessionId)}&days=1`);
    if (probe.ok) {
      const trace = (list.traces ?? []).find(t => sessionOf(t) === session.sessionId);
      return { sessionId: session.sessionId, traceId: trace?.traceId ?? traceId ?? "" };
    }
  }

  throw new Error(`could not resolve replay v2 session (traceparent=${traceparent || "none"})`);
}

function sessionOf(trace) {
  return trace.sessionId ?? trace.replays?.[0]?.sessionId ?? trace.traceId;
}

async function pollForTrace(pick) {
  for (let i = 0; i < 15; i += 1) {
    const list = await fetchJson(`${consoleUrl}/api/traces?days=1&limit=200`);
    const found = pick(list.traces ?? []);
    if (found) {
      return found;
    }
    await sleep(1000);
  }
  return null;
}

// ---- Phase 3 ---------------------------------------------------------------

async function assertSegments(sessionId) {
  let last = null;
  for (let i = 0; i < 20; i += 1) {
    const response = await fetch(`${consoleUrl}/api/replay?sessionId=${encodeURIComponent(sessionId)}&days=1`);
    if (response.ok) {
      const payload = await response.json();
      const events = payload.rrwebEvents ?? [];
      const hasFullSnapshot = events.some(event => event?.type === 2);
      last = { segments: payload.segments, rrwebEventCount: events.length, hasFullSnapshot };
      if (payload.segments >= 2 && hasFullSnapshot && events.length > 20) {
        return { segments: payload.segments, rrwebEventCount: events.length };
      }
    }
    await sleep(1000);
  }
  throw new Error(`replay v2 segments not ready for ${sessionId}: ${JSON.stringify(last)}`);
}

// ---- Phase 4 ---------------------------------------------------------------

async function assertPlayer(send) {
  // Next dev cold compiles of the console route have been observed to take
  // ~11s; pre-warm the route once so the poll loop below isn't spending its
  // budget waiting out the first compile.
  await fetch(consoleUrl).catch(() => {});
  await sleep(2000);

  for (let i = 0; i < 60; i += 1) {
    const value = await evaluate(send, `(() => {
      const player = document.querySelector('.replayPlayer');
      const scrubber = document.querySelector('.replayScrubber');
      const toggle = document.querySelector('.replayPlayToggle');
      const frame = document.querySelector('.replayPlayer iframe');
      const doc = frame && frame.contentDocument;
      const nodes = doc ? doc.querySelectorAll('*').length : 0;
      return { player: Boolean(player), scrubber: Boolean(scrubber), toggle: Boolean(toggle), nodes };
    })()`);
    if (value?.player && value?.scrubber && value?.toggle && value?.nodes > 10) {
      return value.nodes;
    }
    await sleep(1000);
  }
  throw new Error("console did not render the rrweb v2 player (.replayPlayer/.replayScrubber/.replayPlayToggle + iframe > 10 nodes)");
}

// ---- Phase 5 ---------------------------------------------------------------

async function assertErrorRegression(tab) {
  const before = tab.requests.filter(item => item.method === "POST" && item.status === 201).length;

  const clicked = await evaluate(tab.send, `(() => {
    const button = [...document.querySelectorAll("button")].find(item => /Trigger replay failure|Sending failure/.test(item.textContent || ""));
    if (button) button.click();
    return Boolean(button);
  })()`);
  if (!clicked) {
    throw new Error("QA error trigger button not found");
  }

  // The error flush is immediate, but give the collector round-trip room.
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000);
    const after = tab.requests.filter(item => item.method === "POST" && item.status === 201).length;
    if (after > before) {
      return;
    }
  }
  const statuses = tab.requests.filter(item => item.method === "POST").map(item => item.status);
  throw new Error(`error regression saw no new 201 ingest (POST statuses: ${statuses.join(",") || "none"})`);
}

// ---- CDP plumbing ----------------------------------------------------------

async function openTab(url) {
  const target = await (await fetch(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const methods = new Map();
  const requests = [];
  const pageErrors = [];
  let nextId = 1;

  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (message.method === "Network.requestWillBeSent") {
      methods.set(message.params.requestId, message.params.request?.method);
    }
    if (message.method === "Network.responseReceived") {
      requests.push({
        url: message.params.response.url,
        status: message.params.response.status,
        method: methods.get(message.params.requestId) ?? "GET"
      });
    }
    if (message.method === "Runtime.exceptionThrown") {
      pageErrors.push(message.params?.exceptionDetails?.text ?? "");
    }
    if (message.method === "Log.entryAdded") {
      pageErrors.push(message.params?.entry?.text ?? "");
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
  await send("Log.enable");
  await send("Network.enable");

  return { send, ws, requests, pageErrors };
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

async function waitForSdk(send) {
  for (let i = 0; i < 40; i += 1) {
    const ready = await evaluate(send, "Boolean(window.__jayTraceClient)");
    if (ready) {
      return;
    }
    await sleep(500);
  }
  throw new Error("sample-web JayTrace SDK (window.__jayTraceClient) never initialized");
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

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
