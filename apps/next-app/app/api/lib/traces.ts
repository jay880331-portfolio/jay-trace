import { isReplayDocument as isCoreReplayDocument } from "@jaytrace/replay-core";
import type { ReplayDocument } from "@jaytrace/replay-core";
import { collectRawDocuments } from "./documents.ts";

export type TimelineDocument = {
  schema: "jaytrace.timeline.v1";
  service: string;
  side: "front" | "back";
  traceId: string;
  sessionId?: string;
  startedAt: string;
  endedAt?: string;
  summary: string;
  timeline: string[];
  events?: TimelineEvent[];
  user?: JayTraceUser;
  context?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
};

export type TimelineEvent = {
  at: string;
  kind: string;
  text: string;
  severity?: string;
  durationMs?: number;
  slow?: boolean;
  data?: Record<string, unknown>;
};

export type JayTraceUser = {
  id: string;
  email?: string;
  name?: string;
  [key: string]: unknown;
};

export type TraceRow = {
  traceId: string;
  sessionId?: string;
  lastSeen: string;
  status: "error" | "warning" | "ok";
  services: string[];
  route?: string;
  summary: string;
  // Set only by the MySQL list path (db.ts), where front/back bodies are not
  // loaded and identity comes from the index columns instead.
  user?: JayTraceUser;
  front?: TimelineDocument;
  back?: TimelineDocument;
  replays: ReplayDocument[];
};

export type SessionRow = {
  sessionId: string;
  firstSeen: string;
  lastSeen: string;
  traceCount: number;
  errorCount: number;
  replayCount: number;
  services: string[];
  platforms: ReplayDocument["platform"][];
  summary: string;
  user: JayTraceUser;
};

export type UserRow = JayTraceUser & {
  sessionCount: number;
  lastSeen: string;
  sessions: SessionRow[];
};

export async function loadTraceRows(days: number, limit: number, traceId?: string | null) {
  const clampedDays = Math.max(1, Math.min(days, 14));
  const collected = await collectRawDocuments({ days: clampedDays, limit, traceId });
  const documents = filterDocumentsByDays(
    collected.documents
      .map(documentFromJson)
      .filter((doc): doc is TimelineDocument | ReplayDocument => Boolean(doc)),
    clampedDays
  );
  return { ...collected, traces: groupTraces(documents) };
}

export function sourceNotice(sourceMode: "s3" | "local" | "local-fallback" | "db+s3"): string | undefined {
  if (sourceMode === "local") {
    return "Reading local files. Set JAYTRACE_BUCKET or JAYTRACE_S3_BUCKET on the console to read S3 directly.";
  }
  if (sourceMode === "local-fallback") {
    return "S3 read failed, so the console is showing local fallback files.";
  }
  return undefined;
}

function documentFromJson(value: unknown): TimelineDocument | ReplayDocument | null {
  if (isTimelineDocument(value) || isReplayDocument(value)) {
    return value;
  }
  const document = value && typeof value === "object" ? (value as { document?: unknown }).document : null;
  if (isTimelineDocument(document) || isReplayDocument(document)) {
    return document;
  }
  const replay = normalizeReplayDocument(value) ?? normalizeReplayDocument(document);
  return replay && isReplayDocument(replay) ? replay : null;
}

function normalizeReplayDocument(value: unknown): unknown | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schema !== "jaytrace.replay.v1" || !Array.isArray(candidate.events)) {
    return null;
  }
  return {
    ...candidate,
    events: candidate.events.map(eventLine).filter(Boolean)
  };
}

function filterDocumentsByDays(
  documents: Array<TimelineDocument | ReplayDocument>,
  days: number
): Array<TimelineDocument | ReplayDocument> {
  const earliest = Date.now() - days * 24 * 60 * 60 * 1000;
  return documents.filter(document => {
    const timestamp = Date.parse(document.endedAt ?? document.startedAt);
    return Number.isFinite(timestamp) && timestamp >= earliest;
  });
}

function isTimelineDocument(value: unknown): value is TimelineDocument {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<TimelineDocument>;
  return candidate.schema === "jaytrace.timeline.v1" && typeof candidate.traceId === "string";
}

function isReplayDocument(value: unknown): value is ReplayDocument {
  return isCoreReplayDocument(value);
}

function groupTraces(documents: Array<TimelineDocument | ReplayDocument>): TraceRow[] {
  const rows = new Map<string, TraceRow>();

  for (const document of documents) {
    const row = rows.get(document.traceId) ?? {
      traceId: document.traceId,
      sessionId: document.sessionId,
      lastSeen: document.endedAt ?? document.startedAt,
      status: "ok",
      services: [],
      summary: "",
      replays: []
    };

    row.lastSeen = latest(row.lastSeen, document.endedAt ?? document.startedAt);
    row.sessionId = row.sessionId ?? document.sessionId;

    if (document.schema === "jaytrace.replay.v1") {
      row.replays.push(document);
      addService(row, `replay:${document.platform}`);
      if (replayHasError(document)) {
        row.status = "error";
        row.summary = row.summary || replaySummary(document);
      }
    } else {
      addService(row, document.service);
      row.summary = document.error?.message ?? document.summary ?? row.summary;
      row.route = routeFromContext(document.context) ?? row.route;
      row.status = document.error ? "error" : row.status;
      if (document.side === "front") {
        row.front = document;
      } else {
        row.back = document;
      }
    }

    if (!row.front || !row.back) {
      row.status = row.status === "error" ? "error" : "warning";
    }

    rows.set(document.traceId, row);
  }

  return [...rows.values()]
    .map(row => ({
      ...row,
      replays: row.replays.sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt))
    }))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

function addService(row: TraceRow, service: string): void {
  if (!row.services.includes(service)) {
    row.services.push(service);
  }
}

function replayHasError(document: ReplayDocument): boolean {
  return replayEventLines(document).some(line => /\berror\b|status=5\d\d/.test(line));
}

function replaySummary(document: ReplayDocument): string {
  return replayEventLines(document).find(line => /\berror\b|status=5\d\d/.test(line)) ?? `${document.platform} replay captured`;
}

function replayEventLines(document: ReplayDocument): string[] {
  return document.events.map(eventLine).filter(Boolean);
}

function eventLine(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const item = value as Record<string, unknown>;
  return [
    typeof item.at === "string" ? item.at : "",
    typeof item.kind === "string" ? item.kind : "",
    typeof item.level === "string" ? item.level : "",
    typeof item.message === "string" ? item.message : "",
    typeof item.text === "string" ? item.text : ""
  ].filter(Boolean).join(" ");
}

function routeFromContext(context: TimelineDocument["context"]): string | undefined {
  if (typeof context?.route === "string") {
    return context.route;
  }
  if (typeof context?.url !== "string") {
    return undefined;
  }
  try {
    return new URL(context.url).pathname;
  } catch {
    return context.url.startsWith("/") ? context.url.split("?")[0] : undefined;
  }
}

export function groupSessions(traces: TraceRow[]): SessionRow[] {
  const sessions = new Map<string, SessionRow>();

  for (const trace of traces) {
    const user = traceUser(trace);
    for (const sessionId of traceSessionIds(trace)) {
      const sessionReplays = trace.replays.filter(replay => (replay.sessionId ?? trace.sessionId ?? trace.traceId) === sessionId);
      const session = sessions.get(sessionId) ?? {
        sessionId,
        firstSeen: trace.lastSeen,
        lastSeen: trace.lastSeen,
        traceCount: 0,
        errorCount: 0,
        replayCount: 0,
        services: [],
        platforms: [],
        summary: trace.summary,
        user,
      };

      session.firstSeen = earliest(session.firstSeen, trace.lastSeen);
      session.lastSeen = latest(session.lastSeen, trace.lastSeen);
      session.traceCount += 1;
      session.errorCount += trace.status === "error" ? 1 : 0;
      session.replayCount += sessionReplays.length;
      session.summary = session.summary || trace.summary;
      session.user = mergeUser(session.user, user);
      for (const service of trace.services) {
        if (!session.services.includes(service)) {
          session.services.push(service);
        }
      }
      for (const replay of sessionReplays) {
        if (!session.platforms.includes(replay.platform)) {
          session.platforms.push(replay.platform);
        }
      }
      sessions.set(sessionId, session);
    }
  }

  return [...sessions.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export function groupUsers(sessions: SessionRow[]): UserRow[] {
  const users = new Map<string, UserRow>();

  for (const session of sessions) {
    const user = session.user;
    const row = users.get(user.id) ?? {
      ...user,
      sessionCount: 0,
      lastSeen: session.lastSeen,
      sessions: []
    };
    row.email ??= user.email;
    row.name ??= user.name;
    row.sessionCount += 1;
    row.lastSeen = latest(row.lastSeen, session.lastSeen);
    row.sessions.push(session);
    users.set(user.id, row);
  }

  return [...users.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export function traceSessionIds(trace: TraceRow): string[] {
  const explicit = [
    trace.sessionId,
    ...trace.replays.map(replay => replay.sessionId)
  ].filter((id): id is string => Boolean(id));
  return explicit.length ? [...new Set(explicit)] : [trace.traceId];
}

export function traceUserKey(trace: TraceRow): string {
  return traceUser(trace).id;
}

export function traceUser(trace: TraceRow): JayTraceUser {
  const indexed = normalizeUser(trace.user);
  if (indexed) return indexed;
  for (const document of [trace.front, trace.back]) {
    const user = normalizeUser(document?.user);
    if (user) return user;
  }
  for (const document of [trace.front, trace.back]) {
    const user = normalizeUser(document?.context?.user);
    if (user) return user;
  }
  for (const document of [trace.front, trace.back]) {
    const user = normalizeUser(document?.context?.["user.id"] ?? document?.context?.userId);
    if (user) return user;
  }
  for (const replay of trace.replays) {
    const user = normalizeUser(replay.metadata?.userId);
    if (user) return user;
  }
  for (const replay of trace.replays) {
    const user = normalizeUser(replay.metadata?.["user.id"] ?? replay.metadata?.user);
    if (user) return user;
  }
  return { id: "anonymous" };
}

function normalizeUser(value: unknown): JayTraceUser | null {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id } : null;
  }
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) return null;
  return {
    ...candidate,
    id: candidate.id.trim(),
    email: typeof candidate.email === "string" && candidate.email.trim() ? candidate.email.trim() : undefined,
    name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : undefined
  };
}

function mergeUser(current: JayTraceUser, next: JayTraceUser): JayTraceUser {
  if (current.id === "anonymous" && next.id !== "anonymous") return next;
  if (current.id !== next.id) return current;
  return {
    ...next,
    ...current,
    email: current.email ?? next.email,
    name: current.name ?? next.name
  };
}

function latest(left: string, right: string): string {
  return left.localeCompare(right) >= 0 ? left : right;
}

function earliest(left: string, right: string): string {
  return left.localeCompare(right) <= 0 ? left : right;
}
