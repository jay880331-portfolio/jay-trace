// 세션 리플레이가 "장애 화면을 실제로 그려내는지"를 프로그램적으로 단언한다.
//
// sample-web-web-smoke.mjs는 트레이스 문서·프레임 개수까지만 본다. 이 스크립트는 그 다음 칸을
// 채운다 — 콘솔 리플레이 뷰를 헤드리스 Chrome으로 열고, rrweb 플레이어가 재구성한 iframe
// 문서 안을 들여다봐서 (1) 비어있지 않은 화면이 그려졌는지 (2) 그 화면이 sample-web QA 페이지인지
// (3) 클릭/에러 시점으로 시킹한 뒤에도 그러한지를 단언하고 스크린샷 증거를 남긴다.
//
// 두 가지로 쓴다.
//   - 단독 CLI: node apps/next-app/scripts/replay-visual-check.mjs <traceId>
//     (자체 Chrome을 띄우고 콘솔을 연다. 종료 코드로 판정한다 — 0=통과, 1=실패.)
//   - 라이브러리: import { assertReplayScreen } from "./replay-visual-check.mjs"
//     (이미 콘솔 리플레이 뷰가 떠 있는 CDP 세션 위에서 시각 단언만 얹는다.
//      sample-web-web-smoke.mjs가 이렇게 쓴다.)

import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const defaultConsoleUrl = process.env.JAYTRACE_CONSOLE_URL ?? "http://localhost:3022";
// 리플레이된 DOM 안에서 "이 화면은 sample-web이다"를 증명하는 오리진 앵커.
// 스테이지/프로덕션 검증이나 앵커 불일치(음성 대조) 실증에 쓰라고 env로 뺐다.
const sampleWebOrigin = process.env.SAMPLE_WEB_ORIGIN ?? "http://localhost:3014";
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 9224는 sample-web-web-smoke가 점유할 수 있어 기본값을 9226으로 둔다.
const chromePort = Number(process.env.JAYTRACE_REPLAY_CHROME_PORT ?? 9226);
const defaultDays = Number(process.env.JAYTRACE_REPLAY_DAYS ?? 1);
const shotDir = fileURLToPath(new URL("../../../.jaytrace-smoke/", import.meta.url));

// 이미 콘솔 리플레이 뷰가 렌더된 CDP 세션 위에서 시각 단언만 수행한다.
// 실패하면 throw (증거 스크린샷 경로를 메시지에 담는다), 통과하면 판정 근거를 돌려준다.
export async function assertReplayScreen(send, {
  traceId,
  sessionId,
  consoleUrl = defaultConsoleUrl,
  days = defaultDays
}) {
  // 1. rrweb 원본 이벤트로 시킹 목표를 계산한다. 세그먼트가 없으면 그릴 화면 자체가 없다.
  const replay = await readReplay(sessionId, { traceId, consoleUrl, days });
  const seek = seekTarget(replay.rrwebEvents);

  // 2. 시간 이동. 제품 어피던스(에러 마커)를 먼저 눌러보고, 실제 판정은 스크러버를
  //    클릭/에러 시점 오프셋으로 직접 밀어 넣어 결정론적으로 만든다.
  const markers = await clickErrorMarker(send);
  await pausePlayer(send);
  const seeked = await seekScrubber(send, seek.targetMs);
  await sleep(200);
  await pausePlayer(send);

  // 3. 시킹 이후의 화면을 단언한다.
  const screen = await probeReplayedScreen(send);
  const failures = assertAnchors(screen, seeked);

  // 4. 단언 시점 스크린샷 (실패해도 증거는 남긴다).
  const screenshot = await captureScreenshot(send, traceId);

  if (failures.length) {
    throw new Error(`replay visual anchors failed: ${failures.join("; ")} | probe=${JSON.stringify(screen)} | screenshot=${screenshot}`);
  }

  return {
    sessionId,
    engine: replay.engine,
    segments: replay.segments,
    seek: { ...seek, applied: seeked.applied, playToggleFlipped: seeked.playToggleFlipped },
    markers,
    screen,
    screenshot
  };
}

// 콘솔 상세 모드는 front/back 타임라인과 replays를 그대로 실어 준다 (app/api/traces/route.ts).
// 리플레이 세그먼트는 별도 플러시로 도착하므로 sessionId만 확보되면 바로 넘어간다.
async function readTrace(traceId, { consoleUrl, days }) {
  const response = await fetch(`${consoleUrl}/api/traces?traceId=${traceId}&platform=web&screens=1&days=${days}`);
  if (!response.ok) {
    throw new Error(`console read failed ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json();
  const trace = payload.traces?.find(item => item.traceId === traceId);
  if (!trace) {
    throw new Error(`no such trace in console (days=${days}): ${traceId}`);
  }
  const sessionId = trace.sessionId ?? trace.replays?.[0]?.sessionId ?? trace.traceId;
  return { sessionId, sourceMode: payload.sourceMode };
}

// v2 rrweb 이벤트 스트림. 시킹 목표(클릭 시점)를 여기서 계산하고, 404면 그릴 화면 자체가 없다.
async function readReplay(sessionId, { traceId, consoleUrl, days }) {
  for (let i = 0; i < 20; i += 1) {
    const response = await fetch(
      `${consoleUrl}/api/replay?sessionId=${encodeURIComponent(sessionId)}&days=${days}&traceId=${encodeURIComponent(traceId)}`
    );
    if (response.ok) {
      const payload = await response.json();
      if (Array.isArray(payload.rrwebEvents) && payload.rrwebEvents.length) {
        return payload;
      }
    } else if (response.status !== 404) {
      throw new Error(`console replay read failed ${response.status}: ${await response.text()}`);
    }
    await sleep(1000);
  }
  throw new Error(`no v2 rrweb replay for session ${sessionId} (trace ${traceId}); rrweb player never mounts`);
}

// rrweb 원본 이벤트에서 시킹 목표를 뽑는다. type=3/source=2가 MouseInteraction이고
// (packages/replay-web/src/startReplayWeb.ts의 record 결과 그대로) QA 시나리오의 실패는
// 그 클릭 직후에 터진다. 클릭이 없으면 마지막 이벤트 직전으로 간다.
export function seekTarget(events) {
  const startedMs = events[0]?.timestamp ?? 0;
  const click = events.find(event => event?.type === 3 && event?.data?.source === 2);
  const lastMs = (events[events.length - 1]?.timestamp ?? startedMs) - startedMs;
  if (click) {
    return { reason: "rrweb click", targetMs: Math.max(0, click.timestamp - startedMs), totalMs: lastMs };
  }
  return { reason: "no rrweb click; midpoint", targetMs: Math.floor(lastMs / 2), totalMs: lastMs };
}

async function waitForPlayer(send, traceId) {
  const startedAt = Date.now();
  for (let i = 0; i < 90; i += 1) {
    const value = await evaluate(send, `(() => {
      const stage = document.querySelector(".replayStage");
      const frame = stage?.querySelector("iframe");
      const doc = frame?.contentDocument;
      return {
        stage: Boolean(stage),
        frame: Boolean(frame),
        nodes: doc?.querySelectorAll("*").length ?? 0,
        scrubber: Boolean(document.querySelector(".replayScrubber"))
      };
    })()`);
    if (value?.nodes > 20 && value.scrubber) {
      return { waitedMs: Date.now() - startedAt, ...value };
    }
    await sleep(1000);
  }
  throw new Error(`rrweb player never rendered a populated iframe for ${traceId}`);
}

// 제품이 제공하는 시간 이동 어피던스(ReplayTimeline 마커)를 실제로 눌러 본다.
// 마커 위치는 /api/replay의 startedAt(세그먼트 업로드 시각) 기준이라 실제 이벤트
// 시작보다 뒤로 밀릴 수 있고, 그 경우 deriveMarkers가 전부 0ms로 접는다 —
// 그래서 판정은 이 클릭이 아니라 아래 스크러버 시킹으로 한다.
export async function clickErrorMarker(send) {
  return evaluate(send, `(() => {
    const nodes = [...document.querySelectorAll(".replayTimelineMarker")];
    const error = nodes.find(node => node.classList.contains("error"));
    if (error) {
      error.click();
    }
    return {
      total: nodes.length,
      error: nodes.filter(node => node.classList.contains("error")).length,
      clickedError: Boolean(error),
      lefts: nodes.map(node => node.style.left).slice(0, 8),
      labels: nodes.map(node => node.getAttribute("title")).slice(0, 8)
    };
  })()`);
}

// React 제어 input이라 value를 그냥 넣으면 onChange가 안 뜬다 — 네이티브 setter로
// 값 추적기를 우회한 뒤 input/change를 모두 쏜다. seek()가 isPlaying=true로 만들기
// 때문에 재생 버튼 라벨이 "재생"→"일시정지"로 뒤집히는 것이 React가 실제로 처리했다는 증거다.
export async function seekScrubber(send, targetMs) {
  const before = await evaluate(send, `document.querySelector(".replayPlayToggle")?.textContent ?? null`);
  const applied = await evaluate(send, `(() => {
    const input = document.querySelector(".replayScrubber");
    if (!input) {
      return { applied: false, reason: "no scrubber" };
    }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, String(${Math.round(targetMs)}));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { applied: true, max: Number(input.max) };
  })()`);
  await sleep(150);
  const after = await evaluate(send, `(() => ({
    toggle: document.querySelector(".replayPlayToggle")?.textContent ?? null,
    value: Number(document.querySelector(".replayScrubber")?.value ?? -1)
  }))()`);
  return {
    ...applied,
    targetMs: Math.round(targetMs),
    scrubberMax: applied?.max ?? 0,
    scrubberValue: after?.value ?? -1,
    playToggleFlipped: before === "재생" && after?.toggle === "일시정지"
  };
}

export async function pausePlayer(send) {
  await evaluate(send, `(() => {
    const toggle = document.querySelector(".replayPlayToggle");
    if (toggle && toggle.textContent === "일시정지") {
      toggle.click();
      return true;
    }
    return false;
  })()`);
}

// 여기가 이 스크립트의 본체. rrweb Replayer가 재구성한 iframe 문서 안을 직접 읽는다.
// - 텍스트는 maskTextSelector:"*"로 전부 별표가 되므로 (startReplayWeb.ts:241) 문구는 앵커가 못 된다.
// - 반면 태그 구조, class, href/src는 스냅샷에 원본 그대로 살아남는다.
export async function probeReplayedScreen(send) {
  return evaluate(send, `(() => {
    const stage = document.querySelector(".replayStage");
    const frame = stage?.querySelector("iframe");
    const doc = frame?.contentDocument;
    const body = doc?.body;
    if (!body) {
      return { mounted: false };
    }
    const rect = body.getBoundingClientRect();
    const painted = [...body.querySelectorAll("*")].filter(node => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    }).length;
    const origin = ${JSON.stringify(sampleWebOrigin)};
    const originHits = [...doc.querySelectorAll("[href],[src]")].filter(node => {
      const value = node.getAttribute("href") ?? node.getAttribute("src") ?? "";
      return value.startsWith(origin);
    }).length;
    const main = doc.querySelector("main");
    const mainChildTags = main ? [...main.children].map(node => node.tagName.toLowerCase()) : [];
    const cards = main ? [...main.querySelectorAll(":scope > ul > li")] : [];
    return {
      mounted: true,
      nodes: doc.querySelectorAll("*").length,
      painted,
      bodyWidth: Math.round(rect.width),
      bodyHeight: Math.round(rect.height),
      stageWidth: Math.round(stage.getBoundingClientRect().width),
      stageHeight: Math.round(stage.getBoundingClientRect().height),
      textLength: (body.innerText ?? "").replace(/\\s+/g, "").length,
      originHits,
      main: Boolean(main),
      mainChildTags,
      mainHeading: Boolean(main?.querySelector(":scope > header h1")),
      cards: cards.length,
      cardsWithHeading: cards.filter(node => node.querySelector("h2") && node.querySelector("p")).length,
      mainButtons: main ? main.querySelectorAll(":scope > button").length : 0
    };
  })()`);
}

// 앵커 판정. "뭔가 그려짐"이 아니라 "sample-web JayTrace QA 화면이 그려짐"까지 요구한다.
export function assertAnchors(probe, seeked) {
  const failures = [];
  if (!probe?.mounted) {
    return ["rrweb iframe document is not mounted"];
  }
  // (1) 비어있지 않은 시각 콘텐츠
  if (!(probe.nodes > 50)) failures.push(`replayed document too small (nodes=${probe.nodes})`);
  if (!(probe.painted > 20)) failures.push(`replayed document painted nothing (painted=${probe.painted})`);
  if (!(probe.bodyWidth > 100 && probe.bodyHeight > 100)) {
    failures.push(`replayed body has no layout (${probe.bodyWidth}x${probe.bodyHeight})`);
  }
  if (!(probe.stageWidth > 100 && probe.stageHeight > 100)) {
    failures.push(`player stage has no layout (${probe.stageWidth}x${probe.stageHeight})`);
  }
  if (!(probe.textLength > 50)) failures.push(`replayed document has no text glyphs (textLength=${probe.textLength})`);

  // (2) sample-web 화면인가 — 마스킹은 텍스트만 지우고 href/src는 남긴다.
  if (!(probe.originHits > 0)) {
    failures.push(`no sample-web-origin asset/link in the replayed DOM (origin=${sampleWebOrigin})`);
  }

  // (3) JayTrace QA 페이지인가 — main > header(h1) + ul(li 카드) + button 구조 서명.
  if (!probe.main) failures.push("replayed screen has no <main>");
  if (!hasSubsequence(probe.mainChildTags ?? [], ["header", "ul", "button"])) {
    failures.push(`main child tags do not match the QA page signature: [${(probe.mainChildTags ?? []).join(",")}]`);
  }
  if (!probe.mainHeading) failures.push("QA page header <h1> missing in the replayed screen");
  if (!(probe.cardsWithHeading >= 3)) {
    failures.push(`QA page card list missing (cards=${probe.cards}, withHeading=${probe.cardsWithHeading})`);
  }
  if (!(probe.mainButtons >= 1)) failures.push("QA page trigger button missing in the replayed screen");

  // (4) 시간 이동이 실제로 먹었는가
  if (!seeked?.applied) failures.push(`seek was not applied: ${seeked?.reason ?? "unknown"}`);
  else if (!seeked.playToggleFlipped) failures.push("scrubber seek did not reach the player (play toggle never flipped)");

  return failures;
}

function hasSubsequence(tags, wanted) {
  let index = 0;
  for (const tag of tags) {
    if (tag === wanted[index]) index += 1;
    if (index === wanted.length) return true;
  }
  return false;
}

export async function captureScreenshot(send, traceId) {
  const rect = await evaluate(send, `(() => {
    const node = document.querySelector(".replayPlayer") ?? document.body;
    const box = node.getBoundingClientRect();
    return { x: box.x + window.scrollX, y: box.y + window.scrollY, width: box.width, height: box.height };
  })()`);
  const clip = rect && rect.width > 0 && rect.height > 0
    ? { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height, scale: 1 }
    : undefined;
  const shot = await send("Page.captureScreenshot", clip ? { format: "png", clip, captureBeyondViewport: true } : { format: "png" });
  const data = shot.result?.data;
  if (!data) {
    throw new Error("Page.captureScreenshot returned no data");
  }
  await mkdir(shotDir, { recursive: true });
  const path = join(shotDir, `replay-visual-${traceId}.png`);
  await writeFile(path, Buffer.from(data, "base64"));
  return path;
}

async function openTarget(url) {
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
  await new Promise(resolve => ws.addEventListener("open", resolve, { once: true }));

  const send = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise(resolve => pending.set(id, resolve));
  };
  return { send, close: () => ws.close() };
}

export async function evaluate(send, expression) {
  const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.result?.exceptionDetails) {
    throw new Error(`page evaluate failed: ${response.result.exceptionDetails.text} ${response.result.exceptionDetails.exception?.description ?? ""}`);
  }
  return response.result?.result?.value;
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

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 단독 CLI. import될 때는 아무것도 실행하지 않는다.
// ---------------------------------------------------------------------------

async function runVisualCheck(traceId) {
  const consoleUrl = defaultConsoleUrl;
  const days = defaultDays;

  // 1. 트레이스를 먼저 확인한다. 존재하지 않는 traceId는 브라우저를 띄우기 전에 떨어진다.
  const trace = await readTrace(traceId, { consoleUrl, days });

  // 딥링크에 sessionId를 못 박는다. traceId만 넘기면 콘솔이 issues 뷰에서 같은 fingerprint의
  // 대표 트레이스(다른 세션일 수 있다)를 골라 빈 플레이어를 여는 경합이 있다.
  const { send, close } = await openTarget(
    `${consoleUrl}/?traceId=${encodeURIComponent(traceId)}&sessionId=${encodeURIComponent(trace.sessionId)}&platform=web&screens=1&view=sessions&days=${days}`
  );
  try {
    await send("Runtime.enable");
    await send("Page.enable");

    // 2. 플레이어가 마운트되고 iframe 문서가 채워질 때까지 기다린다.
    const mounted = await waitForPlayer(send, traceId);

    // 3. 시간 이동 + 화면 단언 + 스크린샷.
    const asserted = await assertReplayScreen(send, {
      traceId,
      sessionId: trace.sessionId,
      consoleUrl,
      days
    });

    return { ...asserted, mountedAfterMs: mounted.waitedMs };
  } finally {
    close();
  }
}

function fail(message, traceId) {
  console.error(JSON.stringify({ ok: false, traceId: traceId ?? null, error: message }, null, 2));
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const traceId = process.argv[2];
  if (!/^[0-9a-f]{32}$/.test(traceId ?? "")) {
    fail(`usage: node apps/next-app/scripts/replay-visual-check.mjs <traceId(32 hex)> (got: ${traceId ?? "<none>"})`, traceId);
  }

  const chrome = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${await mkdtemp(join(tmpdir(), "jaytrace-replay-visual-chrome-"))}`,
    "--window-size=1440,1200",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ], { stdio: "ignore" });

  try {
    await waitForChrome();
    const result = await runVisualCheck(traceId);
    console.log(JSON.stringify({
      ok: true,
      traceId,
      consoleUrl: defaultConsoleUrl,
      sampleWebOrigin,
      ...result
    }, null, 2));
  } catch (error) {
    chrome.kill();
    fail(error instanceof Error ? error.message : String(error), traceId);
  } finally {
    chrome.kill();
  }
}
