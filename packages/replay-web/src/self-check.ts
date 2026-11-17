import { startReplayWeb, buildSegmentDocument, normalize } from "./index.js";
import { mutationDiff } from "./dom.js";
import { snapshotHtml } from "./snapshot.js";
import { isReplayV2SegmentDocument, type ReplayV2SegmentDocument } from "@jaytrace/replay-core";

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

class FakeElement extends FakeTarget {
  readonly tagName: string = "BUTTON";
  readonly id: string = "pay";
  readonly textContent: string = "Pay now";
  readonly attributes: Array<{ name: string; value: string }> = [];
  getAttribute(_name?: string): string | null {
    return null;
  }
}

class FakeInputElement extends FakeElement {
  override readonly tagName = "INPUT";
  override readonly id = "email";
  override readonly textContent = "";
  readonly value = "secret@example.test";
}

class FakeSelectElement extends FakeElement {
  override readonly tagName = "SELECT";
  override readonly id = "plan";
  override readonly textContent = "";
  readonly value = "enterprise";
}

class FakeMutationObserver {
  observe(): void {}
  disconnect(): void {}
}

class FakeNode {
  constructor(public textContent: string) {}
  readonly nodeType = 3;
}

class FakeBody {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly attributes: Array<{ name: string; value: string }> = [];
  childNodes: unknown[] = [];

  constructor(private rawHtml: string, tagName = "BODY") {
    this.tagName = tagName;
  }

  get innerHTML(): string {
    return this.childNodes.length
      ? this.childNodes.map(child => childHtml(child)).join("")
      : this.rawHtml;
  }

  cloneNode(): FakeBody {
    return new FakeBody(this.innerHTML);
  }

  removeAttribute(name: string): void {
    const index = this.attributes.findIndex(attribute => attribute.name === name);
    if (index >= 0) {
      this.attributes.splice(index, 1);
    }
  }
  setAttribute(name: string, value: string): void {
    const attribute = this.attributes.find(item => item.name === name);
    if (attribute) {
      attribute.value = value;
    } else {
      this.attributes.push({ name, value });
    }
  }
  getAttribute(name?: string): string | null {
    return this.attributes.find(attribute => attribute.name === name)?.value ?? null;
  }
  hasAttribute(_name?: string): boolean {
    return false;
  }

  remove(): void {
    this.rawHtml = "";
    this.childNodes = [];
  }
}

class FakeAttributeBody extends FakeBody {
  constructor() {
    super("");
    this.childNodes = [new FakeAttributeElement()];
  }

  override cloneNode(): FakeAttributeBody {
    return new FakeAttributeBody();
  }
}

class FakeAttributeElement extends FakeBody {
  constructor() {
    super("Visible label", "A");
    this.attributes.push(
      { name: "href", value: "https://example.test/pay?token=secret#frag" },
      { name: "data-token", value: "secret" },
      { name: "values", value: "0 0 0 0 0" },
      { name: "aria-label", value: "Jane Doe checkout" },
      { name: "onclick", value: "steal()" }
    );
  }

  override cloneNode(): FakeAttributeElement {
    return new FakeAttributeElement();
  }

  get outerHTML(): string {
    const attrs = this.attributes.map(attribute => ` ${attribute.name}="${attribute.value}"`).join("");
    return `<a${attrs}>${this.innerHTML}</a>`;
  }
}

class FakeMaskedBody extends FakeBody {
  constructor() {
    super("");
    this.childNodes = [new FakeMaskedElement(), new FakeHiddenElement()];
    this.attributes.push(
      { name: "class", value: "font-sans app-shell" },
      { name: "data-theme", value: "light" },
      { name: "data-user-token", value: "secret" },
      { name: "onclick", value: "steal()" }
    );
  }

  override cloneNode(): FakeMaskedBody {
    return new FakeMaskedBody();
  }
}

class FakeMaskedElement extends FakeBody {
  constructor() {
    super("", "SECTION");
    this.childNodes = [new FakeNode("secret name")];
  }

  override hasAttribute(name: string): boolean {
    return name === "data-jaytrace-mask";
  }

  get outerHTML(): string {
    return `<section data-jaytrace-mask>${this.innerHTML}</section>`;
  }
}

class FakeHiddenElement extends FakeBody {
  constructor() {
    super("", "ASIDE");
    this.childNodes = [new FakeNode("hidden token")];
  }

  override hasAttribute(name: string): boolean {
    return name === "data-jaytrace-hidden";
  }

  get outerHTML(): string {
    return this.innerHTML ? `<aside data-jaytrace-hidden>${this.innerHTML}</aside>` : "";
  }
}

class FakeMutationElement extends FakeBody {
  readonly attributes = [];
  readonly id = "";
  readonly parentElement = null;
  readonly previousElementSibling = null;

  constructor(
    private text: string,
    private readonly attributeNames: string[] = [],
    private readonly values: Record<string, string> = {}
  ) {
    super("", "SPAN");
  }

  override cloneNode(): FakeMutationElement {
    return new FakeMutationElement(this.text, this.attributeNames, this.values);
  }

  override hasAttribute(name: string): boolean {
    return this.attributeNames.includes(name);
  }

  override getAttribute(name: string): string | null {
    return this.values[name] ?? null;
  }

  closest(selector: string): FakeMutationElement | null {
    return this.attributeNames.some(name => selector.includes(name)) ? this : null;
  }

  querySelectorAll(): FakeMutationElement[] {
    return [];
  }

  override get innerHTML(): string {
    return this.text;
  }

  get textContent(): string {
    return this.text;
  }

  set textContent(value: string) {
    this.text = value;
  }

  get outerHTML(): string {
    return `<span>${this.text}</span>`;
  }
}

function childHtml(child: unknown): string {
  if (child && typeof child === "object" && "outerHTML" in child && typeof child.outerHTML === "string") {
    return child.outerHTML;
  }
  if (child && typeof child === "object" && "textContent" in child && typeof child.textContent === "string") {
    return child.textContent;
  }
  return "";
}

const fakeWindow = new FakeTarget() as FakeTarget & Window;
const fakeDocument = new FakeTarget() as FakeTarget & Document;
const flushed: unknown[] = [];
let now = 0;

Object.assign(fakeWindow, {
  innerWidth: 390,
  innerHeight: 844,
  scrollX: 0,
  scrollY: 10,
  location: {
    href: "https://example.test/checkout",
    pathname: "/checkout",
    hash: ""
  },
  history: {
    pushState(_state: unknown, _unused: string, url?: string | URL | null) {
      setPath(url);
    },
    replaceState(_state: unknown, _unused: string, url?: string | URL | null) {
      setPath(url);
    }
  }
});

Object.assign(fakeDocument, {
  documentElement: new FakeElement(),
  head: {
    querySelectorAll() {
      return [
        { tagName: "STYLE", outerHTML: '<style>.pay{color:red}</style>', getAttribute: () => null },
        { tagName: "LINK", outerHTML: '<link rel="stylesheet" href="/_next/app.css">', getAttribute: () => "/_next/app.css" },
        { tagName: "LINK", outerHTML: '<link rel="stylesheet" href="https://cdn.example.test/app.css">', getAttribute: () => "https://cdn.example.test/app.css" }
      ];
    }
  }
});

Object.assign(globalThis, {
  window: fakeWindow,
  document: fakeDocument,
  Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
  Element: FakeBody,
  MutationObserver: FakeMutationObserver,
  HTMLInputElement: FakeInputElement,
  HTMLTextAreaElement: class {},
  HTMLSelectElement: FakeSelectElement
});

Object.assign(fakeDocument, { body: new FakeBody(`<main>${"x".repeat(512)}</main>`) });
assert(snapshotHtml(true, true, 64) === "", "oversized dom snapshot skipped");
Object.assign(fakeDocument, { body: new FakeMaskedBody() });
const privacySnapshot = snapshotHtml(false, false);
assert(privacySnapshot.includes("redacted"), "data-jaytrace-mask masks subtree");
assert(!privacySnapshot.includes("hidden token"), "data-jaytrace-hidden removes subtree");
assert(privacySnapshot.includes('<body class="font-sans app-shell" data-theme="light">'), "snapshot preserves safe body attributes");
assert(!privacySnapshot.includes("data-user-token"), "snapshot skips arbitrary data attributes");
assert(!privacySnapshot.includes("onclick"), "snapshot skips event attributes");
Object.assign(fakeDocument, { body: new FakeAttributeBody() });
const attributeSnapshot = snapshotHtml(true, true);
assert(attributeSnapshot.includes('href="https://example.test/pay"'), "snapshot strips url query secrets");
assert(!attributeSnapshot.includes("token=secret"), "snapshot url does not leak token query");
assert(!attributeSnapshot.includes("data-token"), "snapshot removes sensitive data attributes");
assert(attributeSnapshot.includes('values="0 0 0 0 0"'), "snapshot preserves svg filter values");
assert(attributeSnapshot.includes('aria-label="redacted"'), "snapshot masks text attributes");
assert(!attributeSnapshot.includes("Jane Doe"), "snapshot text attributes do not leak");
assert(!attributeSnapshot.includes("onclick"), "snapshot removes child event attributes");
const maskedMutation = mutationDiff({
  type: "childList",
  target: new FakeBody("", "DIV"),
  addedNodes: [new FakeMutationElement("new secret card", ["data-jaytrace-mask"])],
  removedNodes: []
} as unknown as MutationRecord, false);
assert(JSON.stringify(maskedMutation).includes("redacted"), "data-jaytrace-mask masks mutation html");
assert(!JSON.stringify(maskedMutation).includes("new secret card"), "masked mutation html does not leak text");
const hiddenMutation = mutationDiff({
  type: "childList",
  target: new FakeBody("", "DIV"),
  addedNodes: [new FakeMutationElement("hidden secret", ["data-jaytrace-hidden"])],
  removedNodes: []
} as unknown as MutationRecord, false);
assert(!JSON.stringify(hiddenMutation).includes("hidden secret"), "data-jaytrace-hidden removes mutation html");
const tokenMutation = mutationDiff({
  type: "attributes",
  target: new FakeMutationElement("", [], { "data-token": "plain-secret-token" }),
  attributeName: "data-token"
} as unknown as MutationRecord, false);
assert(JSON.stringify(tokenMutation).includes("redacted"), "sensitive mutation attribute is redacted");
assert(!JSON.stringify(tokenMutation).includes("plain-secret-token"), "sensitive mutation attribute does not leak");
const bearerMutation = mutationDiff({
  type: "attributes",
  target: new FakeMutationElement("", [], { title: "Bearer abc123" }),
  attributeName: "title"
} as unknown as MutationRecord, false);
assert(JSON.stringify(bearerMutation).includes("Bearer redacted"), "mutation attribute inline secret is redacted");
assert(!JSON.stringify(bearerMutation).includes("abc123"), "mutation attribute inline secret does not leak");
Object.assign(fakeDocument, { body: new FakeBody(`<main>${"x".repeat(512)}</main>`) });

const controller = startReplayWeb({
  enabled: true,
  mode: "on-error",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  metadata: { release: "1.2.3", environment: "test" },
  flush: (document) => {
    flushed.push(document);
  },
  now: () => new Date(now)
});

assert(Boolean(controller), "controller created");
assert(
  startReplayWeb({
    enabled: true,
    mode: "on-error",
    engine: "snapshot",
    sampleRate: 0,
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    flush: () => {}
  }) === null,
  "sampleRate 0 disables replay (v1/snapshot)"
);
const click = {
  target: new FakeElement(),
  clientX: 10,
  clientY: 20
} as unknown as MouseEvent;
fakeDocument.dispatch("click", click as unknown as Event);
fakeDocument.dispatch("input", { target: new FakeInputElement() } as unknown as Event);
fakeDocument.dispatch("change", { target: new FakeSelectElement() } as unknown as Event);
now = 1000;
fakeWindow.dispatch("scroll", {} as Event);
window.history.pushState({}, "", "/checkout/review");
window.history.replaceState({}, "", "/checkout/confirm#pay");
controller?.recordPerformance("long_task durationMs=99 path=/checkout/confirm#pay");
controller?.recordNetwork("fetch POST /api/pay status=500 durationMs=42");
controller?.markError("payment failed");
await new Promise((resolve) => setTimeout(resolve, 0));
assert(flushed.length === 1, "flushed on error");
assert(JSON.stringify(flushed[0]).includes("payment failed"), "error captured");
const payload = JSON.stringify(flushed[0]);
assert(payload.includes("route /checkout/review"), "pushState route frame");
assert(payload.includes("route /checkout/confirm#pay"), "replaceState route frame");
assert(payload.includes("input input#email value=redacted"), "input frame captured");
assert(payload.includes("input select#plan value=redacted"), "change frame captured");
assert(payload.includes("scroll x=0 y=10 /checkout"), "scroll frame captured");
assert(payload.includes("fetch POST /api/pay status=500 durationMs=42"), "network captured");
assert(payload.includes('"kind":"network"'), "network frame captured");
assert(payload.includes("performance long_task durationMs=99 path=/checkout/confirm#pay"), "performance frame captured");
assert(payload.includes('"html":"<!doctype html>'), "default dom snapshot captured");
assert(payload.includes('<base href=\\"https://example.test/checkout\\">'), "base href captured");
assert(payload.includes(".pay{color:red}"), "stylesheet snapshot captured");
assert(payload.includes("/_next/app.css"), "same-origin stylesheet captured");
assert(!payload.includes("cdn.example.test"), "cross-origin stylesheet skipped");
assert(payload.includes("text=redacted"), "text masked");
assert(payload.includes('"release":"1.2.3"'), "metadata captured");
controller?.stop();

Object.assign(fakeDocument, {
  body: {
    cloneNode() {
      throw new Error("snapshot failed");
    }
  }
});
const snapshotFailFlushes: unknown[] = [];
const snapshotFailController = startReplayWeb({
  enabled: true,
  mode: "on-error",
  traceId: "snapshot-failure-trace",
  flush: (document) => {
    snapshotFailFlushes.push(document);
  },
  now: () => new Date(0)
});
snapshotFailController?.markError("crash despite snapshot failure");
await new Promise((resolve) => setTimeout(resolve, 0));
assert(snapshotFailFlushes.length === 1, "snapshot failure does not block web flush");
assert(JSON.stringify(snapshotFailFlushes[0]).includes("crash despite snapshot failure"), "web error kept without snapshot");
snapshotFailController?.stop();

// --- v2 rrweb raw-event capture ---------------------------------------------
// rrweb record() cannot be driven under the node fake DOM, so the runtime tap is
// covered by the Task 8 E2E. Here we verify the pure pieces: option normalization,
// segment-document assembly, and controller wiring (engine field + sendSegment).

const v2Normalized = normalize({
  traceId: "b".repeat(32),
  enabled: true,
  mode: "always",
  flush: () => {}
});
assert(v2Normalized.engine === "rrweb", "default engine is rrweb");
assert(v2Normalized.sampled === true, "default sampleRate 1 -> sampled");
assert(v2Normalized.segmentFlushMs === 10_000, "default segmentFlushMs");
assert(v2Normalized.maxSegmentBytes === 262_144, "default maxSegmentBytes");
assert(v2Normalized.maxSessionMs === 1_800_000, "default maxSessionMs");
assert(v2Normalized.idlePauseMs === 300_000, "default idlePauseMs");
assert(
  normalize({ traceId: "b".repeat(32), enabled: true, mode: "always", engine: "snapshot", flush: () => {} }).engine === "snapshot",
  "engine snapshot honored"
);
assert(
  normalize({ traceId: "b".repeat(32), enabled: true, mode: "always", sampleRate: 0, flush: () => {} }).sampled === false,
  "sampleRate 0 -> not sampled (v2 routes to error tail)"
);
// legacy v1 callers pass 0-100 percentages; rrweb path must reinterpret >1 as percent, not treat it as always-sampled
assert(
  normalize({ traceId: "b".repeat(32), enabled: true, mode: "always", sampleRate: 50, random: () => 0.4, flush: () => {} }).sampled === true,
  "legacy sampleRate 50 (percent) + random 0.4 -> sampled true"
);
assert(
  normalize({ traceId: "b".repeat(32), enabled: true, mode: "always", sampleRate: 50, random: () => 0.6, flush: () => {} }).sampled === false,
  "legacy sampleRate 50 (percent) + random 0.6 -> sampled false"
);

const segDoc = buildSegmentDocument(
  {
    seq: 3,
    events: [{ type: 2, data: {} }, { type: 3, data: {} }],
    startedAt: new Date("2026-07-10T00:00:00.000Z"),
    endedAt: new Date("2026-07-10T00:00:10.000Z")
  },
  { traceId: "b".repeat(32), sessionId: "seg-session", metadata: { release: "9.9.9" } }
);
assert(isReplayV2SegmentDocument(segDoc), "buildSegmentDocument produces a valid v2 segment");
assert(segDoc.seq === 3, "segment seq preserved");
assert(segDoc.rrwebEvents?.length === 2, "raw rrweb events preserved");
assert(segDoc.startedAt === "2026-07-10T00:00:00.000Z", "segment startedAt is ISO");
assert(segDoc.endedAt === "2026-07-10T00:00:10.000Z", "segment endedAt is ISO");
assert(JSON.stringify(segDoc).includes('"release":"9.9.9"'), "segment carries options metadata");

const sentSegments: ReplayV2SegmentDocument[] = [];
const v2Controller = startReplayWeb({
  traceId: "b".repeat(32),
  sessionId: "v2-session",
  enabled: true,
  mode: "always",
  engine: "rrweb",
  sampleRate: 1,
  segmentFlushMs: 10,
  sendSegment: doc => { sentSegments.push(doc); },
  flush: async () => {},
  now: () => new Date("2026-07-10T00:00:00.000Z")
});
assert(v2Controller !== null, "v2 controller created");
assert(v2Controller!.engine === "rrweb" || v2Controller!.engine === "snapshot", "controller exposes engine");
void v2Controller!.flush("manual"); // drains pending segment buffer (empty here — no rrweb events under fake DOM)
v2Controller!.stop();

// --- Track C: crash-isolation forced-failure regression ----------------------
// A throwing now() poisons every buffer timestamp; a throwing host flush and
// sendSegment poison the transport. No controller entry point, DOM listener,
// history patch, or timer callback may throw into the host loop.
Object.assign(fakeDocument, { body: new FakeBody(`<main>${"x".repeat(64)}</main>`) });
{
  let poisonNow = false;
  const hostileController = startReplayWeb({
    enabled: true,
    mode: "always",
    engine: "rrweb",
    sampleRate: 1,
    segmentFlushMs: 10,
    traceId: "c".repeat(32),
    sessionId: "iso-session",
    traceparent: `00-${"c".repeat(32)}-00f067aa0ba902b7-01`,
    now: () => {
      if (poisonNow) {
        throw new Error("boom now");
      }
      return new Date(0);
    },
    sendSegment: () => {
      throw new Error("boom sendSegment");
    },
    flush: () => {
      throw new Error("boom host flush");
    }
  });
  assert(hostileController !== null, "hostile controller still constructs");

  poisonNow = true;
  const hostileUser: Record<string, unknown> = {};
  Object.defineProperty(hostileUser, "id", {
    enumerable: true,
    get() {
      throw new Error("boom user getter");
    }
  });

  let threw = false;
  try {
    hostileController!.recordAction("iso action");
    hostileController!.recordNetwork("fetch GET /iso status=200 durationMs=1");
    hostileController!.recordPerformance("long_task durationMs=9 path=/iso");
    hostileController!.setUser(hostileUser as unknown as Record<string, string>);
    hostileController!.markError("iso error");
    await hostileController!.flush("manual");
    await hostileController!.flush("error");
    // host-facing DOM / history surfaces must survive a poisoned buffer too
    fakeDocument.dispatch("click", { target: new FakeElement(), clientX: 1, clientY: 2 } as unknown as Event);
    fakeWindow.dispatch("scroll", {} as Event);
    window.history.pushState({}, "", "/iso/next"); // app navigation must not break
    window.history.replaceState({}, "", "/iso/replace");
    hostileController!.stop();
  } catch {
    threw = true;
  }
  assert(!threw, "forced internal errors never escape replay-web entry points, listeners, or timers");

  // Sanity: the host loop survives — a healthy controller still flushes afterwards.
  poisonNow = false;
  Object.assign(fakeDocument, { body: new FakeBody(`<main>${"x".repeat(64)}</main>`) });
  const survivorFlushes: unknown[] = [];
  const survivor = startReplayWeb({
    enabled: true,
    mode: "on-error",
    traceId: "d".repeat(32),
    flush: (document) => {
      survivorFlushes.push(document);
    },
    now: () => new Date(0)
  });
  survivor!.markError("survivor error");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(survivorFlushes.length === 1, "a healthy controller still flushes after injected failures");
  survivor!.stop();
}

function setPath(url?: string | URL | null): void {
  if (!url) {
    return;
  }
  const next = new URL(String(url), "https://example.test");
  Object.assign(fakeWindow.location, {
    pathname: next.pathname,
    hash: next.hash
  });
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`self-check failed: ${message}`);
  }
}
