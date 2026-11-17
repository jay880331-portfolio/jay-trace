import { createHash } from "node:crypto";

export function normalizeIssueMessage(message) {
  return String(message ?? "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
    .replace(/\b\d{4,}\b/g, "<id>")
    .replace(/\s+/g, " ")
    .trim();
}

export function isIssueFingerprint(value) {
  return /^[0-9a-f]{64}$/.test(String(value));
}

export function issueFingerprint(trace) {
  const document = errorDocument(trace);
  const error = document?.error;
  const frame = errorFrame(error?.stack);
  const message = error?.message ?? normalizedReplaySummary(trace.summary);
  const input = [
    "v1",
    traceDimension(trace, "environment"),
    document?.service ?? trace.services?.[0] ?? "",
    error?.name ?? "",
    normalizeIssueMessage(message),
    frame,
    frame ? "" : trace.route ?? ""
  ];
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function deriveIssueStatus(state, lastSeen) {
  if (!state) return "new";
  if (state.status !== "resolved") return state.status;
  return Date.parse(lastSeen) > Date.parse(state.lastOccurrenceAtResolution ?? "") ? "regressed" : "resolved";
}

export function resolutionBlocked(status, rawDocumentsTruncated) {
  return status === "resolved" && rawDocumentsTruncated;
}

export function groupIssues(traces, states = {}) {
  const rows = new Map();

  for (const trace of traces) {
    if (trace.status !== "error") continue;

    const fingerprint = issueFingerprint(trace);
    const row = rows.get(fingerprint) ?? newIssueRow(fingerprint, trace);
    row.count += 1;
    row.firstSeen = row.firstSeen < trace.lastSeen ? row.firstSeen : trace.lastSeen;
    row.traceIds.add(trace.traceId);
    addAll(row.services, trace.services ?? []);
    addValue(row.environments, traceDimension(trace, "environment"));
    addValue(row.releases, traceDimension(trace, "release"));
    addAll(row.platforms, (trace.replays ?? []).map(replay => replay.platform));
    addAll(row.sessionIds, traceSessionIds(trace));
    addValue(row.users, traceUserKey(trace));

    if (trace.lastSeen > row.lastSeen) {
      setRepresentative(row, trace);
    }
    rows.set(fingerprint, row);
  }

  const statusOrder = { regressed: 0, new: 1, acknowledged: 2, resolved: 3 };
  return [...rows.values()]
    .map(row => ({
      fingerprint: row.fingerprint,
      traceId: row.traceId,
      title: row.title,
      cause: row.cause,
      impact: `${row.baseImpact} · ${scopeImpact(row.sessionIds.size, row.users.size)}`,
      status: deriveIssueStatus(states[row.fingerprint], row.lastSeen),
      count: row.count,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      services: [...row.services],
      environments: [...row.environments],
      releases: [...row.releases],
      platforms: [...row.platforms],
      sessionIds: [...row.sessionIds],
      userCount: row.users.size,
      traceIds: [...row.traceIds].slice(0, 100)
    }))
    .sort((left, right) => statusOrder[left.status] - statusOrder[right.status]
      || right.lastSeen.localeCompare(left.lastSeen)
      || right.count - left.count);
}

function newIssueRow(fingerprint, trace) {
  const row = {
    fingerprint,
    count: 0,
    firstSeen: trace.lastSeen,
    services: new Set(),
    environments: new Set(),
    releases: new Set(),
    platforms: new Set(),
    sessionIds: new Set(),
    users: new Set(),
    traceIds: new Set()
  };
  setRepresentative(row, trace);
  return row;
}

function setRepresentative(row, trace) {
  const error = errorDocument(trace)?.error;
  const fatalPlatform = trace.replays?.find(replay => replay.events?.some(event => replayEventLine(event).includes("fatal=true")))?.platform;
  row.traceId = trace.traceId;
  row.lastSeen = trace.lastSeen;
  row.title = error ? `${error.name}: ${error.message}` : trace.summary || "알 수 없는 에러";
  row.cause = error?.code ? `${error.name} ${error.code}` : error?.name || (fatalPlatform ? `${fatalPlatform} 치명적 리플레이` : trace.summary) || "원인 미확인";
  const paired = trace.front && trace.back ? "프론트+백" : trace.front ? "프론트만" : trace.back ? "백엔드만" : "리플레이만";
  row.baseImpact = `${paired} · ${trace.replays?.length ? `리플레이 ${trace.replays.length}건` : "리플레이 없음"}`;
}

function errorDocument(trace) {
  return trace.back?.error ? trace.back : trace.front?.error ? trace.front : undefined;
}

function errorFrame(stack) {
  if (!stack) return "";
  const lines = String(stack).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const dependency = /(?:node_modules|site-packages|\/packages\/flutter\/|package:(?:flutter|dart|async|collection)\/)/;
  const known = lines.find(line => !dependency.test(line) && (
    /^at\s/.test(line)
    || /^.+@.+:\d+:\d+$/.test(line)
    || /^#\d+\s+.+(?:\(.+:\d+:\d+\)|\s.+:\d+:\d+)$/.test(line)
    || /^File\s+["'].+["'],\s+line\s+\d+,\s+in\s+.+$/.test(line)
  ));
  const raw = lines.find(line => !dependency.test(line)
    && !/^Traceback\b|^(?:Caused by:\s*)?[A-Za-z_$][\w.$]*(?::|$)/.test(line)
    && /(?:[/\\]|\.[a-z][\w]*)(?::\d+|\bline\s+\d+)/i.test(line));
  return (known ?? raw ?? "")
    .replace(/:\d+(?::\d+)?(?=\)?$)/, "")
    .replace(/:\d+(?=:in\s)/, "")
    .replace(/,\s+line\s+\d+(?=,\s+in\s+)/, "")
    .slice(0, 300);
}

function normalizedReplaySummary(summary) {
  return String(summary ?? "")
    .replace(/^\d+(?:\.\d+)?s\s+/, "")
    .replace(/\bdurationMs=\d+\b/g, "durationMs=*")
    .replace(/\bx=\d+\s+y=\d+\b/g, "x=* y=*");
}

function replayEventLine(event) {
  if (typeof event === "string") return event;
  if (!event || typeof event !== "object") return "";
  return [event.at, event.kind, event.level, event.message, event.text].filter(value => typeof value === "string").join(" ");
}

function traceDimension(trace, key) {
  return trace.back?.context?.[key] ?? trace.front?.context?.[key] ?? trace.replays?.[0]?.metadata?.[key] ?? "";
}

function traceSessionIds(trace) {
  const values = [trace.sessionId, ...(trace.replays ?? []).map(replay => replay.sessionId)].filter(Boolean);
  return values.length ? [...new Set(values)] : [trace.traceId];
}

function traceUserKey(trace) {
  for (const document of [trace.back, trace.front]) {
    const value = document?.context?.["user.id"] ?? document?.context?.userId;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const replayValue = trace.replays?.[0]?.metadata?.["user.id"];
  return typeof replayValue === "string" ? replayValue.trim() : "";
}

function addAll(target, values) {
  for (const value of values) addValue(target, value);
}

function addValue(target, value) {
  if ((typeof value === "string" || typeof value === "number" || typeof value === "boolean") && String(value)) {
    target.add(String(value));
  }
}

function scopeImpact(sessionCount, userCount) {
  return `${sessionCount ? `세션 ${sessionCount}건` : "세션 없음"} · ${userCount ? `사용자 ${userCount}명` : "사용자 없음"}`;
}
