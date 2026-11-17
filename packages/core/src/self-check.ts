import {
  createChildTraceparent,
  createSessionManager,
  createTimelineDocument,
  createTimelineEvent,
  createTraceparent,
  getTraceId,
  isSensitiveKey,
  parseTraceparent,
  redact,
  SESSION_MAX_DURATION_MS,
  SESSION_TIMEOUT_MS,
  type SessionState,
  type SessionStorage
} from "./index.js";

const traceparent = createTraceparent();
assert(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(traceparent.value), "traceparent format");
assert(parseTraceparent(traceparent.value)?.traceId === traceparent.traceId, "traceparent parse");
assert(getTraceId(traceparent.value) === traceparent.traceId, "getTraceId");
assert(parseTraceparent("00-00000000000000000000000000000000-1111111111111111-01") === null, "reject zero traceId");

const child = createChildTraceparent(traceparent.value);
assert(child.traceId === traceparent.traceId, "child traceId");
assert(child.spanId !== traceparent.spanId, "child spanId");

const redacted = redact({
  password: "secret",
  "user.token": "secret",
  nested: {
    authorization: "Bearer token",
    keep: "visible",
    stack: "Error at /checkout?token=live_token authorization: Bearer abc.def"
  }
});
assertJsonEqual(redacted, {
  password: "redacted",
  "user.token": "redacted",
  nested: {
    authorization: "redacted",
    keep: "visible",
    stack: "Error at /checkout?token=redacted authorization=redacted"
  }
});

const event = createTimelineEvent({
  at: "00:01",
  kind: "error",
  severity: "error",
  text: "POST /api/pay failed"
});

const document = createTimelineDocument({
  service: "api",
  side: "back",
  traceId: traceparent.traceId,
  sessionId: "session-1",
  traceparent: traceparent.value,
  summary: "Payment failed",
  events: [event],
  context: {
    apiKey: "secret",
    route: "/api/pay"
  },
  error: {
    name: "Error",
    message: "Payment failed"
  }
});

assert(document.schema === "jaytrace.timeline.v1", "timeline schema");
assert(document.sessionId === "session-1", "timeline session id");
assert(document.context?.apiKey === "redacted", "timeline redaction");
assertJsonEqual(document.timeline, ["00:01 error error POST /api/pay failed"]);

// Boundary: broadened sensitive-key list redacts new key families, nested and top-level.
const newSensitiveKeys = [
  "sessionToken",
  "session_token",
  "session-token",
  "accessToken",
  "access_token",
  "access-token",
  "refreshToken",
  "refresh_token",
  "refresh-token",
  "privateKey",
  "private_key",
  "private-key",
  "clientSecret",
  "client_secret",
  "client-secret",
  "idToken",
  "id_token",
  "id-token"
];
for (const key of newSensitiveKeys) {
  assert(isSensitiveKey(key), `isSensitiveKey should flag ${key}`);
  const flat = redact({ [key]: "leaked-value" }) as Record<string, unknown>;
  assert(flat[key] === "redacted", `top-level ${key} redacted`);
  const nested = redact({ outer: { [key]: "leaked-value" } }) as { outer: Record<string, unknown> };
  assert(nested.outer[key] === "redacted", `nested ${key} redacted`);
}

// Boundary: sessionId / session_id are the session join key and must never be redacted,
// even though the new "*token" entries above share the "session" prefix.
assert(!isSensitiveKey("sessionId"), "sessionId must stay unredacted");
assert(!isSensitiveKey("session_id"), "session_id must stay unredacted");
const sessionPassthrough = redact({ sessionId: "abc-123", session_id: "abc-123" }) as Record<string, unknown>;
assert(sessionPassthrough.sessionId === "abc-123", "sessionId value passes through redact()");
assert(sessionPassthrough.session_id === "abc-123", "session_id value passes through redact()");

// Boundary: pre-existing keys still behave as before.
assert(isSensitiveKey("token"), "existing key token still sensitive");
assert(isSensitiveKey("apiKey"), "existing key apiKey still sensitive");
assert(!isSensitiveKey("keep"), "unrelated key stays unredacted");

// --- Session manager (Datadog-style sessionization) ---
{
  let counter = 0;
  const generateId = () => `sess-${(counter += 1)}`;

  // ① consecutive touches within the idle timeout return the same session id.
  let clock = 1_000_000;
  const idle = createSessionManager({ generateId, now: () => clock });
  const first = idle.touch();
  clock += SESSION_TIMEOUT_MS; // exactly at the boundary, still the same session
  assert(idle.touch() === first, "touch within timeout keeps the same session id");

  // ② after >timeout idle a new session id is minted.
  clock += SESSION_TIMEOUT_MS + 1;
  const afterIdle = idle.touch();
  assert(afterIdle !== first, "touch after 15min+1ms idle rotates the session id");
  assert(idle.touch() === afterIdle, "the rotated session is stable while activity continues");

  // ③ continuous activity still rotates once the 4h max duration is exceeded.
  let t = 0;
  const capped = createSessionManager({ generateId, now: () => t });
  const startId = capped.touch(); // session starts at t=0
  let lastId = startId;
  for (t = 10 * 60 * 1000; t <= SESSION_MAX_DURATION_MS; t += 10 * 60 * 1000) {
    lastId = capped.touch(); // touch every 10min, always within the idle window
  }
  assert(lastId === startId, "continuous activity keeps one session up to max duration");
  t = SESSION_MAX_DURATION_MS + 1;
  assert(capped.touch() !== startId, "session rotates once 4h max duration is exceeded despite activity");

  // ④ storage save/load roundtrip: the last active state is persisted and resumed.
  let stored: SessionState | undefined;
  const storage: SessionStorage = {
    load: () => stored,
    save: (state) => {
      stored = { ...state };
    }
  };
  let st = 5000;
  const persisted = createSessionManager({ generateId, now: () => st, storage });
  const persistedId = persisted.touch();
  assert(stored?.id === persistedId, "storage.save persists the active session id");
  assert(stored?.lastActivityAt === 5000, "storage.save records the last activity timestamp");
  st = 6000;
  persisted.touch();
  assert(stored?.lastActivityAt === 6000, "a later touch updates the persisted last activity");
  st = 7000;
  const resumed = createSessionManager({ generateId, now: () => st, storage });
  assert(resumed.touch() === persistedId, "a fresh manager resumes the persisted session from storage");

  // ⑤ a throwing or corrupt load still recovers with a fresh session.
  const throwingStorage: SessionStorage = {
    load: () => {
      throw new Error("boom load");
    },
    save: () => {}
  };
  const recoveredFromThrow = createSessionManager({ generateId, now: () => 1000, storage: throwingStorage }).touch();
  assert(recoveredFromThrow.length > 0, "throwing storage.load recovers with a fresh session");

  const brokenStorage: SessionStorage = {
    load: () => ({ id: "", startedAt: Number.NaN, lastActivityAt: Number.NaN }) as SessionState,
    save: () => {}
  };
  const recoveredFromBroken = createSessionManager({ generateId, now: () => 2000, storage: brokenStorage }).touch();
  assert(recoveredFromBroken.length > 0, "corrupt persisted state recovers with a fresh session");
}

// queue kind — RMQ publish 이벤트용
const queueEvent = createTimelineEvent({ at: "0.100s", kind: "queue", text: "publish get-user" });
assert(queueEvent.kind === "queue", "queue kind");

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`self-check failed: ${message}`);
  }
}

function assertJsonEqual(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(actualJson === expectedJson, `${actualJson} !== ${expectedJson}`);
}
