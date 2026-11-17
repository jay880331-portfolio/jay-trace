import {
  ReplayBuffer,
  isReplayDocument,
  maskReplayInput,
  maskReplayText,
  sanitizeReplayLine,
  ReplaySegmenter,
  ErrorTailBuffer,
  decideReplaySampling,
  isReplayV2SegmentDocument
} from "./index.js";

let now = 0;
const buffer = new ReplayBuffer({
  platform: "web",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  sessionId: "session-1",
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  metadata: { appVersion: "1.2.3", apiKey: "should-redact" },
  mode: "on-error",
  maxEvents: 3,
  maxDurationMs: 10_000,
  now: () => new Date(now)
});

buffer.add("viewport", "viewport 1440x900 /checkout");
now += 100;
buffer.addFrame("click", "click button#pay x=10 y=20 text=redacted", {
  type: "dom",
  url: "https://example.test/checkout",
  width: 1440,
  height: 900,
  x: 10,
  y: 20,
  html: "<button>redacted</button>"
});
now += 100;
buffer.add("input", `input card value=${maskReplayInput("4111111111111111")}`);
now += 100;
buffer.addMutation({ target: "button#pay", type: "attributes", attributeName: "disabled", value: "" });
now += 100;
buffer.add("error", "error payment failed");

const document = buffer.document();
assert(isReplayDocument(document), "replay document shape");
assert(document.sessionId === "session-1", "replay session id");
assert(document.metadata?.appVersion === "1.2.3", "keeps replay metadata");
assert(document.metadata?.apiKey === "redacted", "redacts metadata secrets");
assert(document.events.length === 3, "ring buffer max events");
assert(document.frames?.[0]?.html?.includes("button") === true, "keeps replay frame html");
assert(document.mutations?.[0]?.attributeName === "disabled", "keeps mutation diff");
assert(document.events.some((line) => line.includes("payment failed")), "keeps error");
assert(isReplayDocument({
  schema: "jaytrace.replay.v1",
  platform: "react-native",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  mode: "on-error",
  startedAt: "2026-07-01T12:00:00.000Z",
  events: ["0.000s screenshot tap PayButton"],
  frames: [{ at: "0.000s", kind: "screenshot", text: "tap PayButton", type: "image", image: "data:image/png;base64,cm4=", mediaType: "image/png", width: 390, height: 844 }]
}), "accept mobile screenshot replay frame");
assert(isReplayDocument({
  schema: "jaytrace.replay.v1",
  platform: "flutter",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  mode: "on-error",
  startedAt: "2026-07-01T12:00:00.000Z",
  events: ["0.000s screenshot tap PayButton"],
  frames: [{ at: "0.000s", kind: "screenshot", text: "tap PayButton", type: "image", image: "data:image/png;base64,Zmxy=", mediaType: "image/png", width: 390, height: 844 }]
}), "accept flutter screenshot replay frame");
assert(!isReplayDocument({
  schema: "jaytrace.replay.v1",
  platform: "react-native",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  mode: "on-error",
  startedAt: "2026-07-01T12:00:00.000Z",
  events: ["0.000s screenshot tap PayButton"],
  frames: [{ at: "0.000s", kind: "screenshot", text: "tap PayButton", type: "dom", html: "<button>Pay</button>" }]
}), "reject mobile dom replay frame");
assert(!isReplayDocument({
  schema: "jaytrace.replay.v1",
  platform: "flutter",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  mode: "on-error",
  startedAt: "2026-07-01T12:00:00.000Z",
  events: ["0.000s screenshot tap PayButton"],
  frames: [{ at: "0.000s", kind: "screenshot", text: "tap PayButton", type: "image", mediaType: "image/png" }]
}), "reject mobile image frame without image");
assert(!isReplayDocument({
  schema: "jaytrace.replay.v1",
  platform: "web",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  mode: "on-error",
  startedAt: "2026-07-01T12:00:00.000Z",
  events: [{ at: "0.000s", kind: "click", text: "click a" }]
}), "reject non-string replay events");
assert(!isReplayDocument({
  schema: "jaytrace.replay.v1",
  platform: "web",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  mode: "on-error",
  startedAt: "2026-07-01T12:00:00.000Z",
  events: ["0.000s click a"],
  frames: [{ at: "0.000s", kind: "click", text: 123 }]
}), "reject invalid replay frame shape");
assert(!isReplayDocument({
  schema: "jaytrace.replay.v1",
  platform: "web",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  mode: "on-error",
  startedAt: "2026-07-01T12:00:00.000Z",
  events: ["0.000s click a"],
  frames: [{ at: "0.000s", kind: "click", text: "click a", type: "video" }]
}), "reject invalid replay frame type");
assert(!isReplayDocument({
  schema: "jaytrace.replay.v1",
  platform: "web",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  mode: "on-error",
  startedAt: "2026-07-01T12:00:00.000Z",
  events: ["0.000s click a"],
  frames: [{ at: "0.000s", kind: "video", text: "click a", type: "dom" }]
}), "reject invalid replay frame kind");
assert(!isReplayDocument({
  schema: "jaytrace.replay.v1",
  platform: "web",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  mode: "on-error",
  startedAt: "2026-07-01T12:00:00.000Z",
  events: ["0.000s click a"],
  frames: [{ at: "0.000s", kind: "click", text: "click a", image: "https://example.test/screen.png" }]
}), "reject remote replay image");
assert(maskReplayText("Pay now") === "redacted", "text masked");
assert(maskReplayInput("secret") === "redacted", "input masked");
assert(maskReplayInput("token=abc123", false) === "token=redacted", "input inline token masked");

const sanitized = sanitizeReplayLine("error authorization=Bearer abc.def cookie=session password=hunter2 apiKey=live_key");
assert(!sanitized.includes("abc.def"), "bearer value removed");
assert(!sanitized.includes("session"), "cookie value removed");
assert(!sanitized.includes("hunter2"), "password value removed");
assert(!sanitized.includes("live_key"), "apiKey value removed");
assert(sanitized.includes("authorization=redacted"), "authorization redacted");

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`self-check failed: ${message}`);
  }
}

{
  let nowMs = 0;
  const seg = new ReplaySegmenter({ flushMs: 10_000, maxBytes: 1000, maxSessionMs: 60_000, now: () => new Date(nowMs) });
  assert(seg.add({ t: 1 }) === "buffered", "small event buffers");
  nowMs = 10_001;
  assert(seg.add({ t: 2 }) === "flush", "elapsed flushMs triggers flush");
  const first = seg.drain();
  assert(first !== null && first.seq === 0 && first.events.length === 2, "first segment seq 0 with both events");
  assert(seg.add({ big: "x".repeat(2000) }) === "flush", "oversized buffer triggers flush");
  const second = seg.drain();
  assert(second !== null && second.seq === 1, "seq increments");
  nowMs = 60_002;
  assert(seg.add({ t: 3 }) === "session-ended", "maxSessionMs ends session");
  assert(seg.drain() !== null, "final drain returns tail");
  assert(seg.drain() === null, "empty drain returns null");

  assert(decideReplaySampling(1, () => 0.99) === true, "sampleRate 1 always samples");
  assert(decideReplaySampling(0, () => 0.01) === false, "sampleRate 0 never samples");
  assert(decideReplaySampling(0.5, () => 0.4) === true, "random below rate samples");
  assert(decideReplaySampling(0.5, () => 0.6) === false, "random above rate skips");

  const tail = new ErrorTailBuffer({ maxEvents: 3 });
  for (let i = 0; i < 5; i += 1) tail.add({ i });
  const drained = tail.drainTail() as Array<{ i: number }>;
  assert(drained.length === 3 && drained[0]?.i === 2, "tail keeps most recent maxEvents");
  assert(tail.drainTail().length === 0, "drainTail empties buffer");

  const byteSum = (events: unknown[]): number =>
    events.reduce<number>((sum, e) => sum + (JSON.stringify(e)?.length ?? 64), 0);

  const bytesTail = new ErrorTailBuffer({ maxEvents: 1000, maxBytes: 2500 });
  for (let i = 0; i < 5; i += 1) bytesTail.add({ i, pad: "x".repeat(1000) });
  const bytesDrained = bytesTail.drainTail() as Array<{ i: number }>;
  assert(byteSum(bytesDrained) <= 2500, "error tail keeps byte sum under maxBytes");
  assert(bytesDrained.length === 2 && bytesDrained[0]?.i === 3, "error tail evicts oldest first on byte cap");

  const oversizedTail = new ErrorTailBuffer({ maxEvents: 1000, maxBytes: 100 });
  oversizedTail.add({ big: "x".repeat(5000) });
  assert(oversizedTail.drainTail().length === 1, "single oversized event is kept despite maxBytes");

  const noBytesTail = new ErrorTailBuffer({ maxEvents: 2 });
  for (let i = 0; i < 5; i += 1) noBytesTail.add({ i, pad: "x".repeat(1000) });
  const noBytesDrained = noBytesTail.drainTail() as Array<{ i: number }>;
  assert(noBytesDrained.length === 2 && noBytesDrained[0]?.i === 3, "maxEvents behavior unchanged without maxBytes");

  assert(
    isReplayV2SegmentDocument({ schema: "jaytrace.replay.v2", engine: "rrweb", platform: "web", traceId: "a".repeat(32), sessionId: "s", seq: 0, startedAt: "2026-07-10T00:00:00.000Z", endedAt: "2026-07-10T00:00:10.000Z", rrwebEvents: [] }),
    "valid v2 segment accepted"
  );
  assert(!isReplayV2SegmentDocument({ schema: "jaytrace.replay.v1" }), "v1 rejected by v2 guard");
  assert(!isReplayV2SegmentDocument({ schema: "jaytrace.replay.v2", engine: "rrweb", platform: "web", traceId: "a".repeat(32), sessionId: "s", seq: -1, startedAt: "x", endedAt: "y", rrwebEvents: [] }), "negative seq rejected");

  const wireframeFrame = {
    atMs: 0,
    viewport: { width: 393, height: 852 },
    pointer: { x: 205, y: 632, kind: "tap" },
    nodes: [
      { type: "rect", x: 0, y: 0, w: 393, h: 852, bg: "#ffffff" },
      { type: "text", x: 24, y: 132, w: 200, h: 20, chars: 9, fontSize: 16, color: "#111111" },
      { type: "image", x: 16, y: 200, w: 80, h: 80 }
    ]
  };
  assert(
    isReplayV2SegmentDocument({ schema: "jaytrace.replay.v2", engine: "wireframe", platform: "flutter", traceId: "a".repeat(32), sessionId: "s", seq: 0, startedAt: "2026-07-10T00:00:00.000Z", endedAt: "2026-07-10T00:00:10.000Z", wireframeFrames: [wireframeFrame] }),
    "valid wireframe v2 segment accepted"
  );
  assert(
    !isReplayV2SegmentDocument({ schema: "jaytrace.replay.v2", engine: "wireframe", platform: "flutter", traceId: "a".repeat(32), sessionId: "s", seq: 0, startedAt: "2026-07-10T00:00:00.000Z", endedAt: "2026-07-10T00:00:10.000Z" }),
    "wireframe segment missing wireframeFrames rejected"
  );
  assert(
    !isReplayV2SegmentDocument({ schema: "jaytrace.replay.v2", engine: "wireframe", platform: "flutter", traceId: "a".repeat(32), sessionId: "s", seq: 0, startedAt: "2026-07-10T00:00:00.000Z", endedAt: "2026-07-10T00:00:10.000Z", wireframeFrames: [{ atMs: 0, viewport: { width: 393, height: 852 } }] }),
    "wireframe frame missing nodes array rejected"
  );
  assert(
    !isReplayV2SegmentDocument({ schema: "jaytrace.replay.v2", engine: "wireframe", platform: "flutter", traceId: "a".repeat(32), sessionId: "s", seq: 0, startedAt: "2026-07-10T00:00:00.000Z", endedAt: "2026-07-10T00:00:10.000Z", wireframeFrames: [{ atMs: "not-a-number", viewport: { width: 393, height: 852 }, nodes: [] }] }),
    "wireframe frame with non-number atMs rejected"
  );
  assert(
    !isReplayV2SegmentDocument({ schema: "jaytrace.replay.v2", engine: "rrweb", platform: "web", traceId: "a".repeat(32), sessionId: "s", seq: 0, startedAt: "2026-07-10T00:00:00.000Z", endedAt: "2026-07-10T00:00:10.000Z" }),
    "rrweb segment missing rrwebEvents rejected"
  );
  assert(
    isReplayV2SegmentDocument({ schema: "jaytrace.replay.v2", engine: "rrweb", platform: "web", traceId: "a".repeat(32), sessionId: "s", seq: 0, startedAt: "2026-07-10T00:00:00.000Z", endedAt: "2026-07-10T00:00:10.000Z", rrwebEvents: [] }),
    "existing rrweb valid case regression"
  );
}
