import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { assertReplayScreen } from "./replay-visual-check.mjs";

const sampleWebUrl = process.env.SAMPLE_WEB_URL ?? "http://localhost:3014/ko/jaytrace-qa";
const consoleUrl = process.env.JAYTRACE_CONSOLE_URL ?? "http://localhost:3022";
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromePort = Number(process.env.JAYTRACE_CHROME_PORT ?? 9224);

const chrome = spawn(chromePath, [
  "--headless=new",
  `--remote-debugging-port=${chromePort}`,
  `--user-data-dir=${await mkdtemp(join(tmpdir(), "jaytrace-sample-web-chrome-"))}`,
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank"
], { stdio: "ignore" });

try {
  await waitForChrome();
  const result = await runSmoke();
  console.log(JSON.stringify({ ok: true, sampleWebUrl, consoleUrl, ...result }, null, 2));
} finally {
  chrome.kill();
}

async function runSmoke() {
  const target = await (await fetch(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(sampleWebUrl)}`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
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
    if (message.method === "Network.responseReceived") {
      requests.push({
        url: message.params.response.url,
        status: message.params.response.status
      });
    }
    if (message.method === "Runtime.exceptionThrown") {
      pageErrors.push(message.params?.exceptionDetails?.text ?? "");
    }
    if (message.method === "Log.entryAdded") {
      pageErrors.push(message.params?.entry?.text ?? "");
    }
  });

  await new Promise(resolve => ws.addEventListener("open", resolve, { once: true }));
  const send = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise(resolve => pending.set(id, resolve));
  };

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Log.enable");
  await send("Network.enable");
  const clicked = await waitForButtonAndSdk(send);
  if (!clicked.result?.result?.value?.clicked || !clicked.result?.result?.value?.sdkReady) {
    throw new Error(`sample-web JayTrace QA button or SDK missing: ${JSON.stringify(clicked.result?.result?.value)}`);
  }

  await sleep(4500);
  const client = await send("Runtime.evaluate", {
    expression: `(() => ({ traceparent: window.__jayTraceClient?.traceparent }))()`,
    returnByValue: true
  });
  await send("Runtime.evaluate", {
    expression: "window.__jayTraceClient?.flush?.()",
    awaitPromise: true,
    returnByValue: true
  });
  await sleep(2500);

  const traceparent = client.result?.result?.value?.traceparent;
  const traceId = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(traceparent ?? "")?.[1];
  if (!traceId) {
    throw new Error(`missing browser traceparent: ${traceparent}`);
  }

  const trace = await readTrace(traceId);
  const apiStatus = requests.find(item => item.url.endsWith("/api/jaytrace-qa/error"))?.status;
  const rumStatuses = requests.filter(item => item.url.endsWith("/jaytrace/rum")).map(item => item.status);
  if (apiStatus !== 500 || !rumStatuses.includes(201)) {
    throw new Error(`unexpected network evidence api=${apiStatus} rum=${rumStatuses.join(",")}`);
  }
  const replayRenderErrors = pageErrors.filter(text => text.includes("feColorMatrix") && text.includes("redacted"));
  if (replayRenderErrors.length) {
    throw new Error(`snapshot masking broke SVG replay rendering: ${replayRenderErrors[0]}`);
  }

  const replayFrames = trace.replays.reduce((sum, replay) => sum + (replay.frames?.length ?? 0), 0);
  const visualFrames = trace.replays.reduce((sum, replay) => sum + (replay.frames?.filter(frame => frame.html || frame.image).length ?? 0), 0);
  if (!visualFrames) {
    throw new Error(`sample-web replay has no visual frames: ${traceId}`);
  }
  const timelineEvents = countTimelineEvents(trace.front);
  if (!timelineEvents.total || !timelineEvents.timelineLines) {
    throw new Error(`sample-web front timeline document is empty: ${traceId}`);
  }
  const missingKinds = [
    timelineEvents.click ? null : "click",
    timelineEvents.view ? null : "view",
    timelineEvents.custom ? null : "custom-action",
    timelineEvents.failedNetwork ? null : "failed-network"
  ].filter(Boolean);
  if (missingKinds.length) {
    throw new Error(`sample-web front timeline missing ${missingKinds.join(",")} events: ${traceId}`);
  }
  // 콘솔로 넘어가기 전에 v2 rrweb 세그먼트가 실제로 도착했는지 확인한다. Page.navigate가
  // sample-web 탭을 날리면 녹화도 끊기므로, 첫 세그먼트 플러시(mode=always, ~10s)를 여기서
  // 기다리지 않으면 콘솔이 v1 filmstrip으로 떨어져 시각 단언 대상이 사라진다.
  const sessionId = trace.sessionId ?? traceId;
  const segments = await waitForReplaySegments(sessionId, traceId);

  const consoleReplay = await waitForConsoleReplay(send, traceId, sessionId);
  // 시각 단언은 이제 선택이 아니다. filmstrip 폴백은 v2 리플레이가 콘솔까지 닿지 못한
  // 것이므로 실패로 본다 (세그먼트는 위에서 이미 확인했다).
  if (consoleReplay.visual !== "player") {
    throw new Error(`missing sample-web visual replay player (fell back to ${consoleReplay.visual})`);
  }
  const replayVisual = await assertReplayScreen(send, { traceId, sessionId, consoleUrl, days: 1 });
  ws.close();

  return {
    traceId,
    sessionId,
    apiStatus,
    rumStatuses,
    replayFrames,
    visualFrames,
    frontEventCount: timelineEvents.total,
    frontTimelineLines: timelineEvents.timelineLines,
    clickEvents: timelineEvents.click,
    viewEvents: timelineEvents.view,
    viewNames: timelineEvents.viewNames,
    customEvents: timelineEvents.custom,
    failedNetworkEvents: timelineEvents.failedNetwork,
    consoleReplayVisual: consoleReplay.visual,
    consoleReplayFrames: consoleReplay.visualFrames,
    consoleFilmFrames: consoleReplay.filmFrames,
    consoleFailureVisible: consoleReplay.failureVisible,
    consolePerformanceFilterVisible: consoleReplay.performanceFilterVisible,
    consoleSummaryCopyVisible: consoleReplay.summaryCopyVisible,
    replaySegments: segments.segments,
    replaySegmentWaitMs: segments.waitedMs,
    replayVisualAnchors: "ok",
    replayVisualSeekMs: replayVisual.seek?.targetMs ?? null,
    replayVisualOriginHits: replayVisual.screen?.originHits ?? null,
    replayVisualCards: replayVisual.screen?.cards ?? null,
    replayVisualScreenshot: replayVisual.screenshot ?? null,
    pageErrorCount: pageErrors.length,
    sourceMode: trace.sourceMode
  };
}

// traceId 쿼리는 콘솔의 상세 모드라 front/back 타임라인 문서 본문이 그대로 실려 온다
// (app/api/traces/route.ts:43). 리플레이 프레임과 front 이벤트가 서로 다른 플러시로
// 도착하므로 둘 다 갖춰질 때까지 기다린다. 못 채우면 무엇이 비었는지 함께 던진다.
async function readTrace(traceId) {
  let missing = "no trace document";
  for (let i = 0; i < 20; i += 1) {
    const response = await fetch(`${consoleUrl}/api/traces?traceId=${traceId}&platform=web&screens=1&days=1`);
    if (!response.ok) {
      throw new Error(`console read failed ${response.status}: ${await response.text()}`);
    }
    const payload = await response.json();
    const trace = payload.traces?.find(item => item.traceId === traceId);
    if (trace) {
      const hasReplay = trace.replays?.some(replay => replay.platform === "web" && (replay.frames?.length ?? 0) > 0);
      const events = countTimelineEvents(trace.front);
      missing = [
        hasReplay ? null : "web replay frames",
        events.click ? null : "click event",
        events.view ? null : "view event",
        events.custom ? null : "custom action event"
      ].filter(Boolean).join(", ");
      if (!missing) {
        return { ...trace, sourceMode: payload.sourceMode };
      }
    }
    await sleep(1000);
  }
  throw new Error(`sample-web trace incomplete in console (${missing}): ${traceId}`);
}

// v2 rrweb 세그먼트가 S3까지 도착했는지 폴링한다. 쿼리 형식은 replay-visual-check.mjs의
// readReplay와 동일하다 (sessionId + days + traceId). mode=always는 첫 세그먼트를 ~10s에
// 플러시하므로 넉넉히 45s까지 기다린다. 여기서 못 채우면 콘솔은 v1 filmstrip으로 떨어진다.
async function waitForReplaySegments(sessionId, traceId) {
  const startedAt = Date.now();
  let last = null;
  for (let i = 0; i < 45; i += 1) {
    const response = await fetch(
      `${consoleUrl}/api/replay?sessionId=${encodeURIComponent(sessionId)}&days=1&traceId=${encodeURIComponent(traceId)}`
    );
    if (response.ok) {
      const payload = await response.json();
      last = { segments: payload.segments ?? 0, rrwebEventCount: payload.rrwebEvents?.length ?? 0 };
      if (last.segments >= 1 && last.rrwebEventCount > 0) {
        return { ...last, waitedMs: Date.now() - startedAt };
      }
    } else if (response.status !== 404) {
      throw new Error(`console replay read failed ${response.status}: ${await response.text()}`);
    }
    await sleep(1000);
  }
  throw new Error(`sample-web replay v2 segments never arrived: ${sessionId} (${JSON.stringify(last)})`);
}

// front 타임라인 문서의 이벤트 수집 현황을 센다. SDK는 kind로 종류를 구분하고
// (packages/browser-sdk/src/initJayTrace.ts: click/view, rumBuffer.addText),
// 커스텀 이벤트 addAction은 kind="log" + text="action <name> ..." 형태로 쌓인다.
function countTimelineEvents(front) {
  const events = Array.isArray(front?.events) ? front.events : [];
  const byKind = kind => events.filter(event => event?.kind === kind);
  const views = byKind("view");
  return {
    total: events.length,
    timelineLines: Array.isArray(front?.timeline) ? front.timeline.length : 0,
    click: byKind("click").length,
    view: views.length,
    viewNames: views.map(event => event.text).slice(0, 10),
    custom: events.filter(event => event?.kind === "log" && String(event.text ?? "").startsWith("action jaytrace-qa")).length,
    // 500 응답은 kind="fetch" + severity="error"로 기록된다 (initJayTrace.ts:362-370).
    failedNetwork: events.filter(
      event => event?.kind === "fetch" && (event.severity === "error" || String(event.text ?? "").includes("status=500"))
    ).length
  };
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

async function waitForButtonAndSdk(send) {
  for (let i = 0; i < 20; i += 1) {
    const result = await send("Runtime.evaluate", {
      expression: `(() => {
        const button = [...document.querySelectorAll("button")].find(item => /Trigger replay failure|Sending failure/.test(item.textContent || ""));
        const sdkReady = Boolean(window.__jayTraceClient);
        if (button && sdkReady) {
          button.click();
        }
        return { clicked: Boolean(button && sdkReady), button: Boolean(button), sdkReady };
      })()`,
      returnByValue: true
    });
    if (result.result?.result?.value?.clicked) {
      return result;
    }
    await sleep(500);
  }

  return send("Runtime.evaluate", {
    expression: `(() => {
      const button = [...document.querySelectorAll("button")].find(item => /Trigger replay failure|Sending failure/.test(item.textContent || ""));
      return { clicked: false, button: Boolean(button), sdkReady: Boolean(window.__jayTraceClient) };
    })()`,
    returnByValue: true
  });
}

// 딥링크에 sessionId를 못 박는다. traceId만 넘기면 콘솔이 issues 뷰에서 같은 fingerprint의
// 대표 트레이스(다른 세션일 수 있다)를 골라 빈 플레이어를 여는 경합이 있다
// (page.tsx의 selectedIssue → selectedTrace 경로). sample-web-replay-v2-smoke와 같은 패턴.
async function waitForConsoleReplay(send, traceId, sessionId) {
  await send("Page.navigate", {
    url: `${consoleUrl}/?traceId=${encodeURIComponent(traceId)}&sessionId=${encodeURIComponent(sessionId)}&platform=web&screens=1&view=sessions&days=1`
  });

  for (let i = 0; i < 60; i += 1) {
    // 세션 상세는 요약 복사/메타데이터를 접힘 "전체 데이터" details에 수납한다 —
    // innerText는 닫힌 details 내용을 제외하므로 프로브 전에 전부 펼친다.
    await send("Runtime.evaluate", {
      expression: `document.querySelectorAll("details").forEach(item => { item.open = true; })`,
      returnByValue: true
    });
    const result = await send("Runtime.evaluate", {
      expression: `(() => ({
        visualFrames: document.querySelectorAll(".replayIframe,.replayImage").length,
        filmFrames: document.querySelectorAll(".filmFrame").length,
        visualLoaded: Boolean(document.querySelector(".replayIframe")?.srcdoc || document.querySelector(".replayImage")?.naturalWidth),
        playerNodes: document.querySelector(".replayPlayer iframe")?.contentDocument?.querySelectorAll("*").length ?? 0,
        failureVisible: document.body?.innerText?.includes("status=500") ?? false,
        performanceFilterVisible: document.body?.innerText?.includes("성능 ") ?? false,
        summaryCopyVisible: document.body?.innerText?.includes("요약 복사") ?? false,
        traceLoaded: document.body?.innerText?.includes("${traceId}") ?? false
      }))()`,
      returnByValue: true
    });
    const value = result.result?.result?.value;
    // v1 filmstrip evidence (images/filmFrames + the filmstrip-only "Perf N" filter chip).
    const filmstripReady = Boolean(value?.visualFrames > 0 && value?.filmFrames > 0 && value?.visualLoaded && value?.performanceFilterVisible);
    // v2 rrweb player evidence: console prefers the player whenever v2 segments exist,
    // in which case the v1 filmstrip/Perf chip never mounts at all.
    const playerReady = Boolean(value?.playerNodes > 10);
    const visual = filmstripReady ? "filmstrip" : playerReady ? "player" : null;
    if (visual && value?.failureVisible && value?.summaryCopyVisible && value?.traceLoaded) {
      return {
        visual,
        visualFrames: value.visualFrames,
        filmFrames: value.filmFrames,
        performanceFilterVisible: value.performanceFilterVisible,
        summaryCopyVisible: value.summaryCopyVisible,
        failureVisible: value.failureVisible
      };
    }
    await sleep(1000);
  }

  throw new Error(`console did not render visual replay (filmstrip or v2 player) for ${traceId}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
