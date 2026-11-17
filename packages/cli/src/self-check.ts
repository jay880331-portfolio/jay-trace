import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTraceFiles, createAnalysisPrompt, joinTraces, main, parseArgs } from "./index.js";

const root = await mkdtemp(join(tmpdir(), "jaytrace-cli-"));
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const replayOnlyTraceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const frontDir = join(root, "prod", "2026", "07", "01", traceId);
await mkdir(frontDir, { recursive: true });

await writeFile(
  join(frontDir, "front.json"),
  JSON.stringify({
    schema: "jaytrace.timeline.v1",
    service: "web",
    side: "front",
    traceId,
    startedAt: "2026-07-01T12:00:00.000Z",
    endedAt: "2026-07-01T12:00:05.000Z",
    summary: "User rage-clicked Pay and saw payment failure.",
    context: {
      url: "/checkout",
      apiKey: "redacted"
    },
    timeline: [
      "0.000s navigation page loaded /checkout",
      "1.200s rage_click error rage-click button#pay count=4 withinMs=1200",
      "1.300s fetch error fetch POST /api/pay status=500 durationMs=81"
    ]
  })
);

await writeFile(
  join(frontDir, "back.json"),
  JSON.stringify({
    schema: "jaytrace.timeline.v1",
    service: "api",
    side: "back",
    traceId,
    startedAt: "2026-07-01T12:00:04.900Z",
    endedAt: "2026-07-01T12:00:05.000Z",
    summary: "POST /api/pay failed: PrismaClientKnownRequestError Unique constraint failed",
    error: {
      name: "PrismaClientKnownRequestError",
      message: "Unique constraint failed",
      code: "P2002"
    },
    timeline: [
      "0.000s request info request POST /api/pay",
      "0.080s db error db payment.create failed P2002",
      "0.100s error error PrismaClientKnownRequestError Unique constraint failed"
    ]
  })
);

await writeFile(join(frontDir, "not-a-trace.json"), JSON.stringify({ ok: true }));
await writeFile(join(frontDir, "broken.json"), "{");
await writeFile(
  join(frontDir, "replay.json"),
  JSON.stringify({
    schema: "jaytrace.replay.v1",
    platform: "web",
    traceId,
    sessionId: "session-1",
    mode: "on-error",
    startedAt: "2026-07-01T12:00:00.000Z",
    endedAt: "2026-07-01T12:00:05.000Z",
    metadata: { appVersion: "1.2.3", os: "web" },
    events: [
      "0.000s viewport 1440x900 /checkout",
      "1.250s network POST redacted status=500 durationMs=81",
      "1.200s click button#pay x=712 y=531 text=redacted",
      "2.500s error payment failed"
    ],
    frames: [
      { at: "0.000s", kind: "viewport", text: "viewport 1440x900 /checkout", type: "dom", width: 1440, height: 900, html: "<!doctype html><button>Pay</button>" },
      { at: "0.100s", kind: "mutation", text: "render header", type: "dom", width: 1440, height: 900, html: "<!doctype html><header>Checkout</header>" },
      { at: "0.200s", kind: "mutation", text: "render summary", type: "dom", width: 1440, height: 900, html: "<!doctype html><main>Summary</main>" },
      { at: "0.300s", kind: "mutation", text: "render card", type: "dom", width: 1440, height: 900, html: "<!doctype html><section>Card</section>" },
      { at: "0.400s", kind: "mutation", text: "render footer", type: "dom", width: 1440, height: 900, html: "<!doctype html><footer>Footer</footer>" },
      { at: "1.260s", kind: "error", text: "payment failed status=500", type: "dom", width: 1440, height: 900, html: "<!doctype html><button disabled>Pay</button>" }
    ],
    mutations: [
      { at: "1.260s", target: "button text=redacted", type: "attributes", attributeName: "disabled", value: "" }
    ]
  })
);
await writeFile(
  join(frontDir, "replay-rn.json"),
  JSON.stringify({
    schema: "jaytrace.replay.v1",
    platform: "react-native",
    traceId,
    sessionId: "session-rn",
    mode: "on-error",
    startedAt: "2026-07-01T12:00:00.000Z",
    events: [
      "0.100s route screen Checkout",
      "0.900s input input EmailInput value=redacted",
      "1.000s scroll scroll CheckoutList offset=320",
      "1.050s gesture performance JSFrameBlocked durationMs=124",
      "1.100s tap button#pay x=210 y=640 text=redacted",
      "1.250s network POST redacted status=500 durationMs=70"
    ],
    frames: [
      { at: "0.100s", kind: "screenshot", text: "screen Checkout", type: "image", image: "data:image/png;base64,cm4=", width: 390, height: 844 },
      { at: "0.900s", kind: "input", text: "input EmailInput value=redacted", type: "image", image: "data:image/png;base64,cm4=", width: 390, height: 844 },
      { at: "1.000s", kind: "scroll", text: "scroll CheckoutList offset=320", type: "image", image: "data:image/png;base64,cm4=", width: 390, height: 844 },
      { at: "1.050s", kind: "gesture", text: "performance JSFrameBlocked durationMs=124", type: "image", image: "data:image/png;base64,cm4=", width: 390, height: 844 },
      { at: "1.100s", kind: "screenshot", text: "tap PayButton x=210 y=640", type: "image", image: "data:image/png;base64,cm4=", width: 390, height: 844, x: 210, y: 640 },
      { at: "1.250s", kind: "network", text: "POST redacted status=500 durationMs=70", type: "image", image: "data:image/png;base64,cm4=", width: 390, height: 844 }
    ]
  })
);
await writeFile(
  join(frontDir, "replay-flutter.json"),
  JSON.stringify({
    schema: "jaytrace.replay.v1",
    platform: "flutter",
    traceId,
    sessionId: "session-flutter",
    mode: "on-error",
    startedAt: "2026-07-01T12:00:00.000Z",
    events: [
      "0.100s route screen Checkout",
      "0.920s input input EmailInput value=redacted",
      "1.020s scroll scroll CheckoutList offset=320",
      "1.080s gesture performance RasterBlocked durationMs=123",
      "1.150s tap ElevatedButton#pay x=205 y=632 text=redacted",
      "1.270s network POST redacted status=500 durationMs=73"
    ],
    frames: [
      { at: "0.100s", kind: "screenshot", text: "screen Checkout", type: "image", image: "data:image/png;base64,Zmx1dHRlcg==", width: 393, height: 852 },
      { at: "0.920s", kind: "input", text: "input EmailInput value=redacted", type: "image", image: "data:image/png;base64,Zmx1dHRlcg==", width: 393, height: 852 },
      { at: "1.020s", kind: "scroll", text: "scroll CheckoutList offset=320", type: "image", image: "data:image/png;base64,Zmx1dHRlcg==", width: 393, height: 852 },
      { at: "1.080s", kind: "gesture", text: "performance RasterBlocked durationMs=123", type: "image", image: "data:image/png;base64,Zmx1dHRlcg==", width: 393, height: 852 },
      { at: "1.150s", kind: "screenshot", text: "tap ElevatedButton#pay x=205 y=632", type: "image", image: "data:image/png;base64,Zmx1dHRlcg==", width: 393, height: 852, x: 205, y: 632 },
      { at: "1.270s", kind: "network", text: "POST redacted status=500 durationMs=73", type: "image", image: "data:image/png;base64,Zmx1dHRlcg==", width: 393, height: 852 }
    ]
  })
);
await writeFile(
  join(frontDir, "replay-legacy.json"),
  JSON.stringify({
    schema: "jaytrace.replay.v1",
    platform: "web",
    traceId,
    sessionId: "session-legacy",
    mode: "on-error",
    startedAt: "2026-07-01T12:00:00.000Z",
    events: [{ at: "1.210s", kind: "click", text: "click legacy PayButton x=700 y=530" }]
  })
);
const replayOnlyDir = join(root, "prod", "2026", "07", "01", replayOnlyTraceId);
await mkdir(replayOnlyDir, { recursive: true });
await writeFile(
  join(replayOnlyDir, "replay-only-rn.json"),
  JSON.stringify({
    schema: "jaytrace.replay.v1",
    platform: "react-native",
    traceId: replayOnlyTraceId,
    sessionId: "session-rn-only",
    mode: "on-error",
    startedAt: "2026-07-01T12:01:00.000Z",
    metadata: { "replay.screenshot": "missing", os: "ios" },
    events: [
      "0.100s gesture tap PayButton x=210 y=640",
      "0.200s network POST redacted status=500 durationMs=30",
      "0.250s error Error: rn crash"
    ]
  })
);

const files = await collectTraceFiles(root);
assert(files.length === 7, "collect trace docs");

const traces = joinTraces(files);
assert(traces.length === 2, "join full and replay-only traces");
const trace = traces.find(item => item.traceId === traceId);
if (!trace) {
  throw new Error("self-check failed: trace exists");
}
assert(Boolean(trace.front), "front joined");
assert(Boolean(trace.back), "back joined");
assert(Boolean(trace.replay), "replay joined");
assert(trace.replays.length === 4, "all replays joined");
const replayOnlyTrace = traces.find(item => item.traceId === replayOnlyTraceId);
assert(Boolean(replayOnlyTrace?.replay), "replay-only trace joined");
assert(!replayOnlyTrace?.front && !replayOnlyTrace?.back, "replay-only trace has no timelines");
assert(createAnalysisPrompt(replayOnlyTrace!).includes("screens: missing screenshot provider"), "cli prompt explains mobile replay without screenshots");

const prompt = createAnalysisPrompt(trace);
assert(prompt.includes("INCIDENT SEQUENCE"), "prompt has merged incident sequence");
assert(prompt.includes("front 1.300s fetch error fetch POST /api/pay status=500"), "sequence includes frontend network failure");
assert(prompt.includes("back 0.080s db error db payment.create failed P2002"), "sequence includes backend db failure");
assert(prompt.includes("replay:flutter 1.150s tap ElevatedButton#pay"), "sequence includes flutter replay signal");
assert(prompt.includes("FRONTEND USER TIMELINE"), "front prompt section");
assert(prompt.includes("BACKEND ERROR TIMELINE"), "back prompt section");
assert(prompt.includes("SESSION REPLAY TIMELINE"), "replay prompt section");
assert(prompt.includes("sessionId: session-1"), "replay session id in prompt");
assert(prompt.includes("sessionId: session-rn"), "react native replay session id in prompt");
assert(prompt.includes("sessionId: session-flutter"), "flutter replay session id in prompt");
assert(prompt.includes("sessionId: session-legacy"), "legacy replay session id in prompt");
assert(prompt.includes("platform: web"), "web replay platform in prompt");
assert(prompt.includes("platform: react-native"), "react native replay platform in prompt");
assert(prompt.includes("platform: flutter"), "flutter replay platform in prompt");
assert(prompt.includes("metadata:"), "replay metadata in prompt");
assert(prompt.includes("lightweight timeline and replay data"), "prompt names replay data");
assert(prompt.includes("errors:"), "replay error summary in prompt");
assert(prompt.includes("network:"), "replay network summary in prompt");
assert(prompt.includes("performance:"), "replay performance summary in prompt");
assert(prompt.includes("actions before issue:"), "replay pre-issue action summary in prompt");
assert(prompt.includes("frames: 6 captured"), "mobile replay frame count in prompt");
assert(prompt.includes("screens: 6 captured"), "mobile replay visual frame count in prompt");
assert(prompt.includes("input EmailInput value=redacted"), "mobile input signal in prompt");
assert(prompt.includes("scroll CheckoutList offset=320"), "mobile scroll signal in prompt");
assert(prompt.includes("tap PayButton x=210 y=640"), "replay frame text in prompt");
assert(prompt.includes("click legacy PayButton"), "legacy object replay event normalized");
assert(prompt.includes("point=210,640"), "react native frame point in prompt");
assert(prompt.includes("point=205,632"), "flutter frame point in prompt");
assert(prompt.includes("payment failed status=500"), "late error frame kept in prompt");
assert(prompt.includes("mutations: 1 captured"), "replay mutation count in prompt");
assert(prompt.includes("P2002"), "backend evidence");
assert(!prompt.includes("not-a-trace"), "ignore unrelated json");

const options = parseArgs(["--logs-dir", root, "--sync-s3", "s3://jaytrace-prod", "--ai", "print", "--limit", "2", "--trace-id", traceId, "--session-id", "session-rn", "--platform", "react-native", "--min-screens", "1"]);
assert(options.logsDir === root, "parse logs dir");
assert(options.syncS3 === "s3://jaytrace-prod", "parse sync s3");
assert(options.ai === "print", "parse ai");
assert(options.limit === 2, "parse limit");
assert(options.traceId === traceId, "parse trace id");
assert(options.sessionId === "session-rn", "parse session id");
assert(options.platform === "react-native", "parse platform");
assert(options.minScreens === 1, "parse min screens");
assert(parseArgs(["--list"]).limit === 20, "list default limit");
assert(parseArgs(["--list", "--limit", "3"]).limit === 3, "explicit list limit");
assert(options.syncOnly === false, "sync with explicit --ai still analyzes");
assert(parseArgs(["--sync-s3", "s3://jaytrace-prod"]).syncOnly === true, "bare sync is sync-only");
assert(parseArgs(["--sync-s3", "s3://jaytrace-prod", "--list"]).syncOnly === false, "sync with --list still lists");

const listOutput = await captureStdout(() => main(["--logs-dir", root, "--list", "--limit", "5"]));
assert(listOutput.code === 0, "list exit code");
assert(listOutput.text.includes(traceId), "list trace id");
assert(listOutput.text.includes(replayOnlyTraceId), "list replay-only trace id");
assert(listOutput.text.includes("status=error"), "list status");
assert(listOutput.text.includes("front=yes"), "list front");
assert(listOutput.text.includes("back=yes"), "list back");
assert(listOutput.text.includes("replay=yes"), "list replay");
assert(listOutput.text.includes("screens=18"), "list screen frame count");
assert(listOutput.text.includes("actions=8"), "list replay action count");
assert(listOutput.text.includes("performance=2"), "list replay performance count");
assert(listOutput.text.includes("network=3"), "list replay network count");
assert(listOutput.text.includes("errors=4"), "list replay error count");
assert(listOutput.text.includes(`${traceId} status=error front=yes back=yes replay=yes screens=18 actions=8 performance=2 network=3 errors=4 screenshots=ok`), "list shows screenshot provider ok");
assert(listOutput.text.includes(`${replayOnlyTraceId} status=error front=no back=no replay=yes screens=0 actions=1 performance=0 network=1 errors=2 screenshots=missing`), "list shows missing screenshot provider");
assert(listOutput.text.includes("platforms=flutter,react-native,web"), "list replay platforms");
assert(listOutput.text.includes("sessions=session-1,session-flutter,session-legacy,session-rn"), "list replay sessions");
assert(listOutput.text.includes("sessions=session-rn-only"), "list replay-only session");

const minScreensOutput = await captureStdout(() => main(["--logs-dir", root, "--list", "--limit", "5", "--min-screens", "2"]));
assert(minScreensOutput.code === 0, "min screens list exit code");
assert(minScreensOutput.text.includes(traceId), "min screens keeps visual trace");
assert(!minScreensOutput.text.includes(replayOnlyTraceId), "min screens filters low visual trace");

const sessionOutput = await captureStdout(() => main(["--logs-dir", root, "--list", "--limit", "5", "--session-id", "session-flutter"]));
assert(sessionOutput.code === 0, "session list exit code");
assert(sessionOutput.text.includes(traceId), "session filter keeps matching trace");
assert(!sessionOutput.text.includes(replayOnlyTraceId), "session filter removes other sessions");

const webPlatformOutput = await captureStdout(() => main(["--logs-dir", root, "--list", "--limit", "5", "--platform", "web"]));
assert(webPlatformOutput.code === 0, "web platform list exit code");
assert(webPlatformOutput.text.includes(traceId), "web platform filter keeps matching trace");
assert(!webPlatformOutput.text.includes(replayOnlyTraceId), "web platform filter removes mobile-only trace");

const reactNativePlatformOutput = await captureStdout(() => main(["--logs-dir", root, "--list", "--limit", "5", "--platform", "react-native"]));
assert(reactNativePlatformOutput.code === 0, "react native platform list exit code");
assert(reactNativePlatformOutput.text.includes(traceId), "react native platform keeps mixed trace");
assert(reactNativePlatformOutput.text.includes(replayOnlyTraceId), "react native platform keeps replay-only trace");

await rm(root, { recursive: true, force: true });

// --- v2 replay segments (rrweb) ---
const v2Root = await mkdtemp(join(tmpdir(), "jaytrace-cli-v2-"));
const v2TraceId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const v2Dir = join(v2Root, "prod", "2026", "07", "01", v2TraceId);
await mkdir(v2Dir, { recursive: true });

await writeFile(
  join(v2Dir, "replay-web-1751371200000-seq0.json"),
  JSON.stringify({
    schema: "jaytrace.replay.v2",
    engine: "rrweb",
    platform: "web",
    traceId: v2TraceId,
    sessionId: "session-v2",
    seq: 0,
    startedAt: "2026-07-01T12:00:00.000Z",
    endedAt: "2026-07-01T12:00:10.000Z",
    rrwebEvents: [{ type: 2, data: {}, timestamp: 1751371200000 }]
  })
);
await writeFile(
  join(v2Dir, "replay-web-1751371210000-seq1.json"),
  JSON.stringify({
    schema: "jaytrace.replay.v2",
    engine: "rrweb",
    platform: "web",
    traceId: v2TraceId,
    sessionId: "session-v2",
    seq: 1,
    startedAt: "2026-07-01T12:00:10.000Z",
    endedAt: "2026-07-01T12:00:18.000Z",
    rrwebEvents: [{ type: 3, data: {}, timestamp: 1751371210000 }]
  })
);

await writeFile(
  join(v2Dir, "replay-web-1751371220000-seq2.json"),
  JSON.stringify({
    schema: "jaytrace.replay.v2",
    engine: "rrweb",
    platform: "web",
    traceId: v2TraceId,
    sessionId: "session-v2",
    seq: 2,
    startedAt: "2026-07-01T12:00:18.000Z",
    endedAt: "garbage",
    rrwebEvents: []
  })
);

const v2Files = await collectTraceFiles(v2Root);
assert(v2Files.length === 3, "collect v2 replay segments");

const v2Traces = joinTraces(v2Files);
assert(v2Traces.length === 1, "join v2-only trace");
const v2Trace = v2Traces.find(item => item.traceId === v2TraceId);
if (!v2Trace) {
  throw new Error("self-check failed: v2 trace exists");
}
assert(v2Trace.replays.length === 3, "v2 segments joined into replays, grouped by traceId");

const v2ListOutput = await captureStdout(() => main(["--logs-dir", v2Root, "--list", "--limit", "5"]));
assert(v2ListOutput.code === 0, "v2 list exit code");
assert(v2ListOutput.text.includes("replay=v2 segments=3 duration=18s"), "v2 list summarizes segment count and total duration, garbage segment contributes 0 instead of NaN");
assert(!v2ListOutput.text.includes("duration=NaNs"), "malformed timestamp segment never poisons duration into NaN");

const v2SessionOutput = await captureStdout(() => main(["--logs-dir", v2Root, "--list", "--limit", "5", "--session-id", "session-v2"]));
assert(v2SessionOutput.code === 0, "v2 session filter exit code");
assert(v2SessionOutput.text.includes(v2TraceId), "v2-only trace visible to --session-id filter");

const v2PlatformOutput = await captureStdout(() => main(["--logs-dir", v2Root, "--list", "--limit", "5", "--platform", "web"]));
assert(v2PlatformOutput.code === 0, "v2 platform filter exit code");
assert(v2PlatformOutput.text.includes(v2TraceId), "v2-only trace visible to --platform filter");

const v2Prompt = createAnalysisPrompt(v2Trace);
assert(!v2Prompt.includes("rrwebEvents"), "prompt never includes raw rrweb events");
assert(v2Prompt.includes("SESSION REPLAY: v2 segments=3 duration=18s"), "prompt includes v2 summary line");

await rm(v2Root, { recursive: true, force: true });

// --- v2 replay segments (wireframe) ---
const wfRoot = await mkdtemp(join(tmpdir(), "jaytrace-cli-wf-"));
const wfTraceId = "cccccccccccccccccccccccccccccccc";
const wfDir = join(wfRoot, "prod", "2026", "07", "01", wfTraceId);
await mkdir(wfDir, { recursive: true });

await writeFile(
  join(wfDir, "replay-flutter-1751371200000-seq0.json"),
  JSON.stringify({
    schema: "jaytrace.replay.v2",
    engine: "wireframe",
    platform: "flutter",
    traceId: wfTraceId,
    sessionId: "session-wf",
    seq: 0,
    startedAt: "2026-07-01T12:00:00.000Z",
    endedAt: "2026-07-01T12:00:10.000Z",
    wireframeFrames: [
      { atMs: 0, viewport: { width: 393, height: 852 }, nodes: [] },
      { atMs: 500, viewport: { width: 393, height: 852 }, nodes: [] }
    ]
  })
);
await writeFile(
  join(wfDir, "replay-flutter-1751371210000-seq1.json"),
  JSON.stringify({
    schema: "jaytrace.replay.v2",
    engine: "wireframe",
    platform: "flutter",
    traceId: wfTraceId,
    sessionId: "session-wf",
    seq: 1,
    startedAt: "2026-07-01T12:00:10.000Z",
    endedAt: "2026-07-01T12:00:18.000Z",
    wireframeFrames: [
      { atMs: 0, viewport: { width: 393, height: 852 }, nodes: [] },
      { atMs: 500, viewport: { width: 393, height: 852 }, nodes: [{ type: "rect", x: 1, y: 2, width: 3, height: 4 }] },
      { atMs: 1000, viewport: { width: 393, height: 852 }, nodes: [] }
    ]
  })
);

const wfFiles = await collectTraceFiles(wfRoot);
assert(wfFiles.length === 2, "collect wireframe replay segments");

const wfTraces = joinTraces(wfFiles);
const wfTrace = wfTraces.find(item => item.traceId === wfTraceId);
if (!wfTrace) {
  throw new Error("self-check failed: wireframe trace exists");
}
assert(wfTrace.replays.length === 2, "wireframe segments joined into replays");

const wfListOutput = await captureStdout(() => main(["--logs-dir", wfRoot, "--list", "--limit", "5"]));
assert(wfListOutput.code === 0, "wireframe list exit code");
assert(wfListOutput.text.includes("replay=v2 segments=2 duration=18s frames=5"), "wireframe list summarizes segment count, duration, and total wireframe frame count");

const wfPrompt = createAnalysisPrompt(wfTrace);
assert(wfPrompt.includes("SESSION REPLAY: v2 segments=2 duration=18s frames=5"), "prompt includes wireframe frame count in summary line");
assert(!wfPrompt.includes("\"type\":\"rect\""), "prompt never includes raw wireframe node content");
assert(!wfPrompt.includes("wireframeFrames"), "prompt never includes raw wireframeFrames content");

await rm(wfRoot, { recursive: true, force: true });

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`self-check failed: ${message}`);
  }
}

async function captureStdout(run: () => Promise<number>): Promise<{ code: number; text: string }> {
  const originalWrite = process.stdout.write;
  let text = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    text += chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  try {
    return {
      code: await run(),
      text
    };
  } finally {
    process.stdout.write = originalWrite;
  }
}
