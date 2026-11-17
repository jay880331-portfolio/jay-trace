"use client";

import { Fragment, type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { IssueRow } from "./lib/issues.mjs";
import { deriveMarkers } from "./lib/replayMarkers.mjs";
import { formatLatency, formatRank, histogramRank } from "./lib/percentile.mjs";
import type { HostContext, WaterfallBar, WaterfallTone } from "./lib/waterfall.mjs";
import {
  eventAttrs,
  formatWaterfallSeconds,
  hostContext,
  stackFrames,
  waterfallBarStyle,
  waterfallBars,
  waterfallTicks,
  waterfallTotalSeconds
} from "./lib/waterfall.mjs";

// rrweb touches window at import time, so keep the player client-only.
const ReplayPlayer = dynamic(() => import("./components/ReplayPlayer"), { ssr: false });
const WireframePlayer = dynamic(() => import("./components/WireframePlayer"), { ssr: false });

type TimelineDocument = {
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

type TimelineEvent = {
  at: string;
  kind: string;
  text: string;
  severity?: string;
  durationMs?: number;
  slow?: boolean;
  data?: Record<string, unknown>;
  // SDK 확장 필드 — 전부 optional. 없으면 워터폴은 평면(depth 0)으로 그린다.
  depth?: number;
  spanId?: string;
  parentSpanId?: string;
  attrs?: Record<string, string | number>;
};

type JayTraceUser = {
  id: string;
  email?: string;
  name?: string;
  [key: string]: unknown;
};

type ReplayDocument = {
  platform: "web" | "react-native" | "flutter";
  traceId: string;
  sessionId?: string;
  startedAt: string;
  endedAt?: string;
  metadata?: Record<string, unknown>;
  // 목록 응답은 replay 본문(events/frames/mutations)을 비우고 파생값만 담은 스텁을 준다.
  // 상세 조회(traceId)나 지연 로딩 후에는 전체 문서가 채워진다.
  events?: string[];
  frames?: ReplayFrame[];
  mutations?: ReplayMutation[];
  visualFrames?: number;
  fatal?: boolean;
};

type TraceRow = {
  traceId: string;
  sessionId?: string;
  lastSeen: string;
  status: "error" | "warning" | "ok";
  services: string[];
  route?: string;
  summary: string;
  front?: TimelineDocument;
  back?: TimelineDocument;
  replays: ReplayDocument[];
  // 목록 응답에서만 true. replays가 요약 스텁이며 상세는 지연 로딩으로 채운다.
  light?: boolean;
};

type TraceResponse = {
  generatedAt: string;
  sourceMode?: "s3" | "db+s3" | "local" | "local-fallback";
  sourceNotice?: string;
  sourceDirs: string[];
  traces: TraceRow[];
  sessions: SessionRow[];
  users: UserRow[];
};

type IssueResponse = {
  aggregateIncomplete?: boolean;
  issues: IssueRow[];
};

type TraceFilter = "all" | "errors" | "paired" | "replays";
type ViewMode = "traces" | "sessions" | "users" | "issues";
type ReplayPlatformFilter = "all" | ReplayDocument["platform"];
type ReplayEventFilter = "all" | "screens" | "actions" | "inputs" | "scroll" | "performance" | "network" | "errors";

type SessionRow = {
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

type UserRow = JayTraceUser & {
  sessionCount: number;
  lastSeen: string;
  sessions: SessionRow[];
};

type ReplayFrame = {
  line?: string;
  at: string;
  seconds: number;
  kind: string;
  text: string;
  type?: "dom" | "image";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  html?: string;
  image?: string;
  mediaType?: string;
};

type ReplayMutation = {
  at: string;
  target: string;
  targetPath?: string;
  type: "attributes" | "childList";
  attributeName?: string;
  value?: string | null;
  addedHtml?: string[];
  removedCount?: number;
};

export default function Page() {
  const [data, setData] = useState<TraceResponse | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string>("");
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [viewMode, setViewMode] = useState<ViewMode>("sessions");
  const [filter, setFilter] = useState<TraceFilter>("all");
  const [replayPlatform, setReplayPlatform] = useState<ReplayPlatformFilter>("all");
  const [visualOnly, setVisualOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [days, setDays] = useState(2);
  const [isLoading, setIsLoading] = useState(true);
  const [issues, setIssues] = useState<IssueRow[]>([]);
  const [issueAggregateIncomplete, setIssueAggregateIncomplete] = useState(false);
  const [issuesLoading, setIssuesLoading] = useState(true);
  const [issueError, setIssueError] = useState("");
  const [issuePending, setIssuePending] = useState("");
  const [failedIssueUpdate, setFailedIssueUpdate] = useState<{ issue: IssueRow; status: "new" | "acknowledged" | "resolved" } | null>(null);
  const [selectedIssueFingerprint, setSelectedIssueFingerprint] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const [issueDetailLoading, setIssueDetailLoading] = useState(false);
  const [issueDetailError, setIssueDetailError] = useState("");
  const [issueAnnouncement, setIssueAnnouncement] = useState("");
  const [issueFocusTarget, setIssueFocusTarget] = useState<{ fingerprint: string; fallbackFingerprint?: string } | null>(null);
  const [copiedSessionLink, setCopiedSessionLink] = useState(false);
  const issueRequestController = useRef<AbortController | null>(null);
  const issueTraceRequestController = useRef<AbortController | null>(null);
  const traceHydrateController = useRef<AbortController | null>(null);
  // 지연 로딩을 이미 시도한 `${days}:${traceId}` 키. 빈 응답/실패 후 무한 재조회를 막는다.
  const hydratedTraceKeys = useRef(new Set<string>());
  const issueRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const issueTabRef = useRef<HTMLButtonElement>(null);
  const daysRef = useRef(days);
  daysRef.current = days;

  async function refresh() {
    setIsLoading(true);
    const params = new URLSearchParams({ limit: "100", days: String(days) });
    // 딥링크 traceId/sessionId는 선택 상태로만 쓰고 목록 필터로는 넘기지 않는다.
    // 넘기면 새로고침 시 세션 리스트가 해당 세션 1건으로 줄어든다.
    const linkedTraceId = initialTraceId();
    const linkedSessionId = initialSessionId();
    if (replayPlatform !== "all") {
      params.set("platform", replayPlatform);
    }
    if (visualOnly) {
      params.set("screens", "1");
    }
    const response = await fetch(`/api/traces?${params.toString()}`, { cache: "no-store" });
    const nextData = (await response.json()) as TraceResponse;
    nextData.sessions ??= [];
    nextData.users ??= [];
    // 딥링크된 trace가 목록 창(days/limit) 밖이면 상세 경로로 백필해 선택이 비지 않게 한다.
    if (linkedTraceId && !nextData.traces.some(trace => trace.traceId === linkedTraceId)) {
      const detailResponse = await fetch(`/api/traces?days=${days}&limit=1&traceId=${encodeURIComponent(linkedTraceId)}`, { cache: "no-store" });
      if (detailResponse.ok) {
        const detail = (await detailResponse.json()) as TraceResponse;
        const linkedTrace = detail.traces.find(trace => trace.traceId === linkedTraceId);
        if (linkedTrace) {
          nextData.traces = [linkedTrace, ...nextData.traces];
          const knownSessionIds = new Set(nextData.sessions.map(session => session.sessionId));
          nextData.sessions = [...(detail.sessions ?? []).filter(session => !knownSessionIds.has(session.sessionId)), ...nextData.sessions];
        }
      }
    }
    setData(nextData);
    setSelectedTraceId(current => current || linkedTraceId || nextData.traces[0]?.traceId || "");
    setSelectedSessionId(current => current || linkedSessionId || nextData.sessions[0]?.sessionId || "");
    setSelectedUserId(current => current || nextData.users.find(user => user.sessions.some(session => session.sessionId === linkedSessionId))?.id || nextData.users[0]?.id || "");
    if (linkedSessionId) {
      setViewMode("sessions");
    }
    setIsLoading(false);
  }

  async function refreshIssues(requestedDays = daysRef.current, requestedTraceId = ""): Promise<IssueRow[] | null> {
    issueRequestController.current?.abort();
    const controller = new AbortController();
    issueRequestController.current = controller;
    const days = requestedDays;
    setIssuesLoading(true);
    setIssueError("");
    setFailedIssueUpdate(null);
    try {
      const traceParam = requestedTraceId ? `&traceId=${encodeURIComponent(requestedTraceId)}` : "";
      const response = await fetch(`/api/issues?days=${days}${traceParam}`, { signal: controller.signal });
      if (!response.ok) {
        throw new Error("이슈 목록을 불러오지 못했습니다.");
      }
      const nextData = (await response.json()) as IssueResponse;
      if (controller.signal.aborted || issueRequestController.current !== controller) return null;
      const nextIssues = nextData.issues ?? [];
      setIssueAggregateIncomplete(Boolean(nextData.aggregateIncomplete));
      setIssues(nextIssues);
      return nextIssues;
    } catch (error) {
      if (controller.signal.aborted || issueRequestController.current !== controller) return null;
      setIssueError(error instanceof Error ? error.message : "이슈 목록을 불러오지 못했습니다.");
      return null;
    } finally {
      if (!controller.signal.aborted && issueRequestController.current === controller) {
        issueRequestController.current = null;
        setIssuesLoading(false);
      }
    }
  }

  async function updateIssue(issue: IssueRow, status: "new" | "acknowledged" | "resolved") {
    const issueIndex = visibleIssues.findIndex(item => item.fingerprint === issue.fingerprint);
    const fallbackFingerprint = visibleIssues[issueIndex + 1]?.fingerprint ?? visibleIssues[issueIndex - 1]?.fingerprint;
    setIssuePending(issue.fingerprint);
    setIssueError("");
    setFailedIssueUpdate(null);
    try {
      const response = await fetch(`/api/issues/${issue.fingerprint}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, lastSeen: issue.lastSeen })
      });
      if (response.status === 409) {
        const conflict = await response.json() as { error?: string };
        if (conflict.error === "issue occurrence changed") {
          setFailedIssueUpdate(null);
          await refreshIssues(daysRef.current);
          setIssueAnnouncement("새 발생이 확인되어 목록을 갱신했습니다. 내용을 검토한 뒤 다시 시도하세요.");
          setIssueFocusTarget({ fingerprint: issue.fingerprint, fallbackFingerprint });
          return;
        }
        throw new Error("전체 발생을 확인할 수 없어 해결할 수 없습니다.");
      }
      if (!response.ok) throw new Error("이슈 상태를 저장하지 못했습니다.");
      await refreshIssues(daysRef.current);
      setIssueAnnouncement(`${issue.title} 상태가 ${statusLabel(status)}으로 변경되었습니다.`);
      setIssueFocusTarget({ fingerprint: issue.fingerprint, fallbackFingerprint });
    } catch (error) {
      const message = error instanceof Error ? error.message : "이슈 상태를 저장하지 못했습니다.";
      setIssueError(message);
      setIssueAnnouncement(message);
      setFailedIssueUpdate({ issue, status });
    } finally {
      setIssuePending("");
    }
  }

  async function loadIssueTrace(issue: IssueRow, days = daysRef.current) {
    issueTraceRequestController.current?.abort();
    const controller = new AbortController();
    issueTraceRequestController.current = controller;
    setIssueDetailLoading(true);
    setIssueDetailError("");
    try {
      const response = await fetch(`/api/traces?days=${days}&limit=1&traceId=${encodeURIComponent(issue.traceId)}`, { signal: controller.signal });
      if (!response.ok) throw new Error("대표 트레이스를 불러오지 못했습니다.");
      const nextData = (await response.json()) as TraceResponse;
      const trace = nextData.traces.find(trace => trace.traceId === issue.traceId);
      if (!trace) throw new Error("대표 트레이스를 찾을 수 없습니다.");
      if (controller.signal.aborted || issueTraceRequestController.current !== controller) return;
      setData(current => current ? {
        ...current,
        traces: [trace, ...current.traces.filter(item => item.traceId !== trace.traceId)]
      } : nextData);
    } catch (error) {
      if (controller.signal.aborted || issueTraceRequestController.current !== controller) return;
      setIssueDetailError(error instanceof Error ? error.message : "대표 트레이스를 불러오지 못했습니다.");
    } finally {
      if (!controller.signal.aborted && issueTraceRequestController.current === controller) {
        issueTraceRequestController.current = null;
        setIssueDetailLoading(false);
      }
    }
  }

  // 세션/트레이스 뷰에서 선택된 요약 스텁 트레이스를 traceId 재조회로 전체 문서로 교체한다.
  // loadIssueTrace 패턴을 따르되 순서는 유지하고 실패/빈 응답 시 조용히 요약을 그대로 둔다.
  async function hydrateTrace(traceId: string, requestedDays = daysRef.current) {
    traceHydrateController.current?.abort();
    const controller = new AbortController();
    traceHydrateController.current = controller;
    try {
      const response = await fetch(`/api/traces?days=${requestedDays}&limit=1&traceId=${encodeURIComponent(traceId)}`, { signal: controller.signal });
      if (!response.ok) return;
      const nextData = (await response.json()) as TraceResponse;
      if (controller.signal.aborted || traceHydrateController.current !== controller) return;
      const trace = nextData.traces.find(item => item.traceId === traceId);
      if (!trace) return;
      setData(current => current ? {
        ...current,
        traces: current.traces.map(item => item.traceId === trace.traceId ? trace : item)
      } : current);
    } catch {
      // 네트워크 실패는 조용히 무시하고 기존 요약 상세를 유지한다.
    } finally {
      if (!controller.signal.aborted && traceHydrateController.current === controller) {
        traceHydrateController.current = null;
      }
    }
  }

  async function copySessionLink() {
    if (!selectedSessionId) {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("sessionId", selectedSessionId);
    url.searchParams.set("view", "sessions");
    await navigator.clipboard?.writeText(url.toString());
    setCopiedSessionLink(true);
    window.setTimeout(() => setCopiedSessionLink(false), 1200);
  }

  useEffect(() => {
    setSelectedTraceId(initialTraceId());
    setSelectedSessionId(initialSessionId());
    setViewMode(initialViewMode());
    setFilter(initialFilter());
    setReplayPlatform(initialReplayPlatform());
    setVisualOnly(initialVisualOnly());
    setQuery(initialQuery());
    setDays(initialDays());
  }, []);

  useEffect(() => {
    void refresh();
  }, [days, replayPlatform, visualOnly]);

  useEffect(() => {
    void refreshIssues(days, initialTraceId());
    return () => issueRequestController.current?.abort();
  }, [days]);

  useEffect(() => {
    if (!selectedTraceId) {
      return;
    }
    const url = new URL(window.location.href);
    if (url.searchParams.get("traceId") === selectedTraceId) {
      return;
    }
    url.searchParams.set("traceId", selectedTraceId);
    window.history.replaceState(null, "", url);
  }, [selectedTraceId]);

  useEffect(() => {
    if (!selectedSessionId) {
      return;
    }
    const url = new URL(window.location.href);
    if (url.searchParams.get("sessionId") === selectedSessionId) {
      return;
    }
    url.searchParams.set("sessionId", selectedSessionId);
    window.history.replaceState(null, "", url);
  }, [selectedSessionId]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (replayPlatform === "all") {
      url.searchParams.delete("platform");
    } else {
      url.searchParams.set("platform", replayPlatform);
    }
    url.searchParams.set("screens", visualOnly ? "1" : "0");
    window.history.replaceState(null, "", url);
  }, [replayPlatform, visualOnly]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const next = query.trim();
    if (next) {
      url.searchParams.set("q", next);
    } else {
      url.searchParams.delete("q");
    }
    window.history.replaceState(null, "", url);
  }, [query]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (viewMode === "sessions") {
      url.searchParams.delete("view");
    } else {
      url.searchParams.set("view", viewMode);
    }
    window.history.replaceState(null, "", url);
  }, [viewMode]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (filter === "all") {
      url.searchParams.delete("filter");
    } else {
      url.searchParams.set("filter", filter);
    }
    window.history.replaceState(null, "", url);
  }, [filter]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("days", String(days));
    window.history.replaceState(null, "", url);
  }, [days]);

  const traces = data?.traces ?? [];
  const sessions = data?.sessions ?? [];
  const users = data?.users ?? [];
  const filteredTraces = traces.filter(trace => matchesFilter(trace, filter) && matchesReplayPlatform(trace, replayPlatform) && matchesVisualReplay(trace, visualOnly) && matchesQuery(traceSearchText(trace), query));
  const visibleSessions = sessions.filter(session => matchesSessionReplayPlatform(session, replayPlatform) && (!visualOnly || traces.some(trace => traceSessionIds(trace).includes(session.sessionId) && replayScreenCount(trace) > 0)) && matchesQuery(sessionSearchText(session), query));
  const visibleUsers = users.filter(user =>
    user.sessions.some(session => matchesSessionReplayPlatform(session, replayPlatform) && (!visualOnly || traces.some(trace => traceSessionIds(trace).includes(session.sessionId) && replayScreenCount(trace) > 0)))
    && matchesQuery(userSearchText(user), query)
  );
  const selectedUser = visibleUsers.find(user => user.id === selectedUserId) ?? visibleUsers[0];
  const selectedUserSessions = selectedUser?.sessions.filter(session =>
    matchesSessionReplayPlatform(session, replayPlatform)
    && (!visualOnly || traces.some(trace => traceSessionIds(trace).includes(session.sessionId) && replayScreenCount(trace) > 0))
  ) ?? [];
  const selectedUserSessionId = selectedUserSessions.some(session => session.sessionId === selectedSessionId)
    ? selectedSessionId
    : selectedUserSessions[0]?.sessionId ?? "";
  const visibleIssues = issues.filter(issue =>
    (showResolved || issue.status !== "resolved")
    && (replayPlatform === "all" || issue.platforms.includes(replayPlatform))
    && matchesQuery([
      issue.fingerprint,
      issue.traceId,
      issue.status,
      issue.title,
      issue.cause,
      issue.impact,
      issue.services.join(" "),
      issue.environments.join(" "),
      issue.releases.join(" "),
      issue.platforms.join(" "),
      issue.sessionIds.join(" ")
    ].join(" "), query)
  );
  const sessionTraces = selectedSessionId
    ? traces.filter(trace => traceSessionIds(trace).includes(selectedSessionId) && matchesReplayPlatform(trace, replayPlatform) && matchesVisualReplay(trace, visualOnly) && matchesQuery(traceSearchText(trace), query))
    : traces;
  const userSessionTraces = selectedUserSessionId
    ? traces.filter(trace => traceSessionIds(trace).includes(selectedUserSessionId))
    : [];
  const visibleTraces = viewMode === "sessions" ? sessionTraces : viewMode === "users" ? userSessionTraces : viewMode === "issues" ? traces : filteredTraces;
  const selectedIssue = viewMode === "issues"
    ? issues.find(issue => issue.fingerprint === selectedIssueFingerprint) ?? issues.find(issue => issue.traceIds.includes(selectedTraceId))
    : undefined;
  const selectedTrace = useMemo(
    () => viewMode === "issues"
      ? selectedIssue ? traces.find(trace => trace.traceId === selectedIssue.traceId) : undefined
      : visibleTraces.find(trace => trace.traceId === selectedTraceId) ?? visibleTraces[0],
    [selectedIssue, selectedTraceId, traces, viewMode, visibleTraces]
  );
  const relatedTraces = selectedIssue ? traces.filter(trace => selectedIssue.traceIds.includes(trace.traceId)) : [];
  const selectedIssueTraceAvailable = Boolean(selectedIssue && traces.some(trace => trace.traceId === selectedIssue.traceId && trace.light !== true));
  const errors = traces.filter(trace => trace.status === "error").length;

  useEffect(() => {
    if (viewMode !== "issues" || !selectedIssue) {
      issueTraceRequestController.current?.abort();
      setIssueDetailLoading(false);
      setIssueDetailError("");
      return;
    }
    if (selectedIssueTraceAvailable) {
      issueTraceRequestController.current?.abort();
      setIssueDetailLoading(false);
      setIssueDetailError("");
      return;
    }
    void loadIssueTrace(selectedIssue, days);
    return () => issueTraceRequestController.current?.abort();
  }, [days, selectedIssue?.fingerprint, selectedIssue?.traceId, selectedIssueTraceAvailable, viewMode]);

  // 세션/트레이스 뷰: 선택된 트레이스가 요약 스텁이면 전체 문서를 지연 로딩한다.
  // issues 뷰는 loadIssueTrace가 담당하므로 건드리지 않는다.
  useEffect(() => {
    if (viewMode !== "sessions" && viewMode !== "traces") {
      return;
    }
    const traceId = selectedTrace?.traceId;
    if (!traceId) {
      return;
    }
    const trace = traces.find(item => item.traceId === traceId);
    if (!trace) {
      return;
    }
    const needsHydration = trace.light === true || (!trace.front && !trace.back && trace.replays.length === 0);
    if (!needsHydration) {
      return;
    }
    const key = `${days}:${traceId}`;
    if (hydratedTraceKeys.current.has(key)) {
      return;
    }
    hydratedTraceKeys.current.add(key);
    void hydrateTrace(traceId, days);
    return () => traceHydrateController.current?.abort();
  }, [days, selectedTrace?.traceId, traces, viewMode]);

  useEffect(() => {
    if (!issueFocusTarget || issuesLoading) return;
    const frame = window.requestAnimationFrame(() => {
      const target = issueRowRefs.current.get(issueFocusTarget.fingerprint)
        ?? (issueFocusTarget.fallbackFingerprint ? issueRowRefs.current.get(issueFocusTarget.fallbackFingerprint) : undefined);
      if (target) target.focus();
      else issueTabRef.current?.focus();
      setIssueFocusTarget(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [issueFocusTarget, issuesLoading, visibleIssues]);

  const listSummary = isLoading
    ? "불러오는 중"
    : viewMode === "traces"
      ? `${traces.length}건 · 에러 ${errors}`
      : listCountLabel(viewMode, traces.length, sessions.length, visibleIssues.length, users.length);

  return (
    <main className="console">
      <section className="topbar">
        <h1>JayTrace</h1>
        <div className="actions">
          <div className="modeToggle" role="group" aria-label="보기 모드">
            <button
              aria-pressed={viewMode === "sessions" || viewMode === "traces"}
              className={viewMode === "sessions" || viewMode === "traces" ? "active" : ""}
              onClick={() => setViewMode("sessions")}
              type="button"
            >
              통합
            </button>
            <button
              aria-pressed={viewMode === "issues"}
              className={viewMode === "issues" ? "active" : ""}
              onClick={() => setViewMode("issues")}
              ref={issueTabRef}
              type="button"
            >
              이슈
            </button>
            <button
              aria-pressed={viewMode === "users"}
              className={viewMode === "users" ? "active" : ""}
              onClick={() => setViewMode("users")}
              type="button"
            >
              유저별
            </button>
          </div>
          <select aria-label="조회 기간" className="rangeSelect" onChange={event => setDays(Number(event.currentTarget.value))} value={days}>
            <option value={1}>1일</option>
            <option value={2}>2일</option>
            <option value={7}>7일</option>
            <option value={14}>14일</option>
          </select>
          <button className="iconButton" onClick={() => void Promise.all([refresh(), refreshIssues()])} aria-label="새로고침" title="새로고침">
            ↻
          </button>
          <span className={`sourceBadge ${data?.sourceMode ?? "local"}`}>{sourceLabel(data)}</span>
        </div>
      </section>
      {data?.sourceNotice ? <p className={`sourceNotice ${data.sourceMode ?? "local"}`}>{data.sourceNotice}</p> : null}

      <section className="workspace">
        <aside className="traceList" aria-label={viewMode === "issues" ? "이슈 목록" : viewMode === "users" ? "유저 목록" : viewMode === "sessions" ? "세션 목록" : "트레이스 목록"}>
          <div className="panelHeader">
            <div className="panelHeaderInfo">
              <span className="listContext">{viewModeNoun(viewMode)}</span>
              <span className="listSummary">{viewMode === "issues" ? (issuesLoading ? "불러오는 중" : listCountLabel(viewMode, traces.length, sessions.length, visibleIssues.length, users.length)) : listSummary}</span>
            </div>
            <div className="panelHeaderMeta">
              <span aria-live="polite" role="status">{viewMode === "issues" ? issueAnnouncement : ""}</span>
              {viewMode === "sessions" && selectedSessionId ? (
                <button className="miniButton" onClick={() => void copySessionLink()} type="button">
                  {copiedSessionLink ? "복사됨" : "세션 복사"}
                </button>
              ) : null}
            </div>
          </div>
          <label className="searchBox">
            <input
              aria-label={viewMode === "issues" ? "이슈 검색" : viewMode === "users" ? "유저 검색" : viewMode === "sessions" ? "세션 검색" : "트레이스 검색"}
              onChange={event => setQuery(event.currentTarget.value)}
              placeholder="트레이스, 세션, 유저, 서비스, 에러 검색"
              type="search"
              value={query}
            />
          </label>
          {viewMode === "issues" ? (
            <p className="listNote">서비스 · 에러 이름 · 정규화한 요약으로 묶은 그룹입니다. 발생 횟수와 처음/마지막 발생은 최근 {days}일 조회 창 안에서만 집계합니다.</p>
          ) : null}
          {viewMode === "issues" && issueError ? (
            <div aria-live="assertive" className="inlineError" role="alert">
              <span>{issueError}</span>
              <button className="miniButton" disabled={Boolean(issuePending)} onClick={() => void (failedIssueUpdate ? updateIssue(failedIssueUpdate.issue, failedIssueUpdate.status) : refreshIssues())} type="button">
                다시 시도
              </button>
            </div>
          ) : null}
          {viewMode === "issues" && issueAggregateIncomplete ? <p className="sourceNotice local-fallback">집계 일부만 표시 · 원본 문서 읽기 한도에 도달해 전체 발생을 확인할 수 없어 해결할 수 없습니다.</p> : null}
          <div className="rows">
            {viewMode === "users" ? visibleUsers.map(user => {
              const active = user.id === selectedUser?.id;
              return (
                <Fragment key={user.id}>
                  <button
                    className={`traceRow userRow ${active ? "active" : ""}`}
                    onClick={() => {
                      const session = user.sessions[0];
                      setSelectedUserId(user.id);
                      setSelectedSessionId(session?.sessionId ?? "");
                      setSelectedTraceId(session ? traces.find(trace => traceSessionIds(trace).includes(session.sessionId))?.traceId ?? "" : "");
                    }}
                    title={`${user.name || user.id}${user.email ? ` · ${user.email}` : ""}`}
                    type="button"
                  >
                    <span className={`statusDot ${user.sessions.some(session => session.errorCount > 0) ? "error" : "ok"}`} />
                    <span className="traceSummary">{user.name || user.id}</span>
                    <span className="rowTime">{relativeTime(user.lastSeen)}</span>
                    <span className="srOnly">{user.email ? `${user.email} · ` : ""}세션 {user.sessionCount}건 · 최근 {timeLabel(user.lastSeen)}</span>
                  </button>
                  {active ? selectedUserSessions.map(session => (
                    <button
                      className={`traceRow sessionRow userSessionRow ${session.sessionId === selectedUserSessionId ? "active" : ""}`}
                      key={session.sessionId}
                      onClick={() => {
                        setSelectedUserId(user.id);
                        setSelectedSessionId(session.sessionId);
                        setSelectedTraceId(traces.find(trace => traceSessionIds(trace).includes(session.sessionId))?.traceId ?? "");
                      }}
                      title={session.summary || "세션"}
                      type="button"
                    >
                      <span className={`statusDot ${session.errorCount > 0 ? "error" : "ok"}`} />
                      <span className="traceSummary">{session.summary || "세션"}</span>
                      <span className="rowTime">{relativeTime(session.lastSeen)}</span>
                    </button>
                  )) : null}
                </Fragment>
              );
            }) : null}
            {viewMode === "sessions" ? visibleSessions.map(session => (
              <button
                className={`traceRow sessionRow ${session.sessionId === selectedSessionId ? "active" : ""}`}
                key={session.sessionId}
                onClick={() => {
                  setSelectedSessionId(session.sessionId);
                  setSelectedTraceId(traces.find(trace => traceSessionIds(trace).includes(session.sessionId))?.traceId ?? "");
                }}
                title={session.summary || "세션"}
                type="button"
              >
                <span className={`statusDot ${session.errorCount > 0 ? "error" : "ok"}`} />
                <span className="traceSummary">{session.summary || "세션"}</span>
                <span className="rowTime">{relativeTime(session.lastSeen)}</span>
                <span className="srOnly">
                  최근 {timeLabel(session.lastSeen)} · 에러 {session.errorCount}건 · 트레이스 {session.traceCount}건 · 리플레이 {session.replayCount}건 · {sessionDuration(session)} · {session.platforms.join(", ") || "리플레이 없음"} · {session.services.join(", ") || "서비스 미상"}
                </span>
              </button>
            )) : null}
            {viewMode === "issues" ? visibleIssues.map(issue => {
              const active = issue.fingerprint === selectedIssue?.fingerprint;
              return (
                <Fragment key={issue.fingerprint}>
                  <button
                    className={`traceRow ${active ? "active" : ""}`}
                    onClick={() => {
                      setSelectedIssueFingerprint(issue.fingerprint);
                      setSelectedTraceId(issue.traceId);
                      setIssueDetailLoading(!traces.some(trace => trace.traceId === issue.traceId));
                      setIssueDetailError("");
                    }}
                    ref={element => {
                      if (element) issueRowRefs.current.set(issue.fingerprint, element);
                      else issueRowRefs.current.delete(issue.fingerprint);
                    }}
                    title={`${issue.title} · ${issue.cause}`}
                    type="button"
                  >
                    <span className={`statusDot ${issue.status}`} />
                    <span className="traceSummary">{issue.title}</span>
                    <span className="rowTime">{relativeTime(issue.lastSeen)}</span>
                    <span className="srOnly">{statusLabel(issue.status)} · {issue.count}회 · {issue.cause} · {issue.platforms.join(", ") || "리플레이 없음"} · {issue.impact} · 릴리스 {issue.releases.join(", ") || "미상"} · 처음 {timeLabel(issue.firstSeen)} · 마지막 {timeLabel(issue.lastSeen)}</span>
                  </button>
                  {active ? (
                    <div className="issueActions">
                      {issue.status === "new" || issue.status === "regressed" ? <button className="miniButton" disabled={Boolean(issuePending)} onClick={() => void updateIssue(issue, "acknowledged")} type="button">선택한 이슈 확인</button> : null}
                      {!issueAggregateIncomplete && issue.status !== "resolved" ? <button className="miniButton" disabled={Boolean(issuePending)} onClick={() => void updateIssue(issue, "resolved")} type="button">선택한 이슈 해결</button> : null}
                      {issue.status === "resolved" ? <button className="miniButton" disabled={Boolean(issuePending)} onClick={() => void updateIssue(issue, "new")} type="button">선택한 이슈 다시 열기</button> : null}
                    </div>
                  ) : null}
                </Fragment>
              );
            }) : null}
            {viewMode === "traces" ? visibleTraces.map(trace => (
              <button
                className={`traceRow ${trace.traceId === selectedTrace?.traceId ? "active" : ""}`}
                key={trace.traceId}
                onClick={() => setSelectedTraceId(trace.traceId)}
                title={trace.summary || trace.route || trace.traceId}
                type="button"
              >
                <span className={`statusDot ${trace.status}`} />
                <span className="traceSummary">{trace.summary || trace.route || "요약 없음"}</span>
                <span className="rowTime">{relativeTime(trace.lastSeen)}</span>
              </button>
            )) : null}
            {!(viewMode === "issues" ? issuesLoading : isLoading) && visibleRowCount(viewMode, visibleTraces.length, visibleSessions.length, visibleIssues.length, visibleUsers.length) === 0 ? (
              <div className="empty">
                <strong>표시할 {viewModeNoun(viewMode)}{subjectParticle(viewModeNoun(viewMode))} 없습니다</strong>
              </div>
            ) : null}
          </div>
        </aside>

        <section className="detail">
          {viewMode === "issues" ? (
            issueDetailLoading ? <div className="empty">대표 트레이스를 불러오는 중입니다</div>
              : issueDetailError ? (
                <div aria-live="assertive" className="inlineError" role="alert">
                  <span>{issueDetailError}</span>
                  <button className="miniButton" onClick={() => selectedIssue && void loadIssueTrace(selectedIssue)} type="button">다시 시도</button>
                </div>
              ) : selectedTrace ? <TraceDetail trace={selectedTrace} relatedTraces={relatedTraces} occurrenceTotal={selectedIssue?.count} days={days} />
                : <div className="empty">{selectedIssue ? "대표 트레이스를 찾을 수 없습니다" : "선택된 이슈가 없습니다"}</div>
          ) : selectedTrace ? <TraceDetail trace={selectedTrace} relatedTraces={relatedTraces} days={days} /> : <div className="empty">선택된 트레이스가 없습니다</div>}
        </section>
      </section>

      <footer>
        <span>데이터 소스: {sourceLabel(data)} · {(data?.sourceDirs ?? []).join(" · ")}</span>
        <span>{data?.generatedAt ? `업데이트 ${new Date(data.generatedAt).toLocaleTimeString()}` : ""}</span>
      </footer>
    </main>
  );
}

function statusLabel(status: string): string {
  if (status === "error") {
    return "오류";
  }
  if (status === "warning") {
    return "경고";
  }
  if (status === "ok") {
    return "정상";
  }
  if (status === "new") {
    return "신규";
  }
  if (status === "acknowledged") {
    return "확인됨";
  }
  if (status === "resolved") {
    return "해결됨";
  }
  if (status === "regressed") {
    return "재발";
  }
  return status;
}

function viewModeNoun(viewMode: ViewMode): string {
  if (viewMode === "sessions") {
    return "세션";
  }
  if (viewMode === "users") {
    return "유저";
  }
  if (viewMode === "issues") {
    return "이슈";
  }
  return "트레이스";
}

// Korean subject particle: 이 after a final consonant (batchim), 가 after a vowel.
function subjectParticle(word: string): string {
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) {
    return "가";
  }
  return (code - 0xac00) % 28 !== 0 ? "이" : "가";
}

function timelineEventCount(document?: TimelineDocument): number {
  if (!document) {
    return 0;
  }
  return document.events?.length ? document.events.length : document.timeline?.length ?? 0;
}

function matchesFilter(trace: TraceRow, filter: TraceFilter): boolean {
  if (filter === "errors") {
    return trace.status === "error";
  }
  if (filter === "paired") {
    return Boolean(trace.front && trace.back);
  }
  if (filter === "replays") {
    return trace.replays.length > 0;
  }
  return true;
}

function initialTraceId(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return new URL(window.location.href).searchParams.get("traceId") ?? "";
}

function initialSessionId(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return new URL(window.location.href).searchParams.get("sessionId") ?? "";
}

// 상단 모드 토글은 통합(sessions)·이슈(issues)·유저별(users) 세 갈래를 노출한다.
// 알 수 없는 view 값은 통합(sessions)으로 폴백한다.
function initialViewMode(): ViewMode {
  if (typeof window === "undefined") {
    return "sessions";
  }
  const value = new URL(window.location.href).searchParams.get("view");
  return value === "sessions" || value === "users" || value === "issues" ? value : "sessions";
}

function initialFilter(): TraceFilter {
  if (typeof window === "undefined") {
    return "all";
  }
  const value = new URL(window.location.href).searchParams.get("filter");
  return value === "errors" || value === "paired" || value === "replays" ? value : "all";
}

function initialReplayPlatform(): ReplayPlatformFilter {
  if (typeof window === "undefined") {
    return "all";
  }
  const value = new URL(window.location.href).searchParams.get("platform");
  return value === "web" || value === "react-native" || value === "flutter" ? value : "all";
}

function initialVisualOnly(): boolean {
  return typeof window !== "undefined" && new URL(window.location.href).searchParams.get("screens") === "1";
}

function initialQuery(): string {
  return typeof window === "undefined" ? "" : new URL(window.location.href).searchParams.get("q") ?? "";
}

function initialDays(): number {
  if (typeof window === "undefined") {
    return 2;
  }
  const value = Number(new URL(window.location.href).searchParams.get("days") ?? 2);
  return [1, 2, 7, 14].includes(value) ? value : 2;
}

function initialReplayFrame(): number | null {
  if (typeof window === "undefined") {
    return null;
  }
  const value = Number(new URL(window.location.href).searchParams.get("frame"));
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function initialReplayIndex(): number {
  if (typeof window === "undefined") {
    return 0;
  }
  const value = Number(new URL(window.location.href).searchParams.get("replay"));
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function matchesReplayPlatform(trace: TraceRow, platform: ReplayPlatformFilter): boolean {
  return platform === "all" || trace.replays.some(replay => replay.platform === platform);
}

function matchesSessionReplayPlatform(session: SessionRow, platform: ReplayPlatformFilter): boolean {
  return platform === "all" || session.platforms.includes(platform);
}

function matchesVisualReplay(trace: TraceRow, enabled: boolean): boolean {
  return !enabled || replayScreenCount(trace) > 0;
}

function replayScreenCount(trace: TraceRow): number {
  return trace.replays.reduce((total, replay) => total + visualFrameCount(replay), 0);
}


function issueCause(trace: TraceRow): string {
  const error = primaryError(trace);
  if (error?.code) {
    return `${error.name} ${error.code}`;
  }
  if (error) {
    return error.name;
  }
  const fatalPlatform = fatalReplayPlatform(trace);
  if (fatalPlatform) {
    return `${fatalPlatform} 치명적 리플레이`;
  }
  return trace.summary || "원인 미확인";
}

function fatalReplayPlatform(trace: TraceRow): string {
  return trace.replays.find(replay => replay.fatal === true || replayEventLines(replay).some(line => line.includes("fatal=true")))?.platform ?? "";
}

function primaryError(trace: TraceRow): TimelineDocument["error"] {
  return trace.back?.error ?? trace.front?.error;
}

function issueImpact(trace: TraceRow): string {
  const paired = trace.front && trace.back ? "프론트+백" : trace.front ? "프론트만" : trace.back ? "백엔드만" : "리플레이만";
  const replay = trace.replays.length ? `리플레이 ${trace.replays.length}건` : "리플레이 없음";
  return `${paired} · ${replay}`;
}

function listCountLabel(viewMode: ViewMode, traceCount: number, sessionCount: number, issueCount: number, userCount: number): string {
  if (viewMode === "sessions") {
    return `세션 ${sessionCount}건`;
  }
  if (viewMode === "users") {
    return `유저 ${userCount}명`;
  }
  if (viewMode === "issues") {
    return `이슈 ${issueCount}건`;
  }
  return `${traceCount}건`;
}

function visibleRowCount(viewMode: ViewMode, traceCount: number, sessionCount: number, issueCount: number, userCount: number): number {
  if (viewMode === "sessions") {
    return sessionCount;
  }
  if (viewMode === "users") {
    return userCount;
  }
  if (viewMode === "issues") {
    return issueCount;
  }
  return traceCount;
}

function sourceLabel(data: TraceResponse | null): string {
  if (data?.sourceMode === "db+s3") {
    return "DB+S3";
  }
  if (data?.sourceMode === "s3") {
    return "S3";
  }
  if (data?.sourceMode === "local-fallback") {
    return "로컬 폴백";
  }
  return "로컬";
}

function timeLabel(value: string): string {
  return new Date(value).toLocaleTimeString();
}

// 목록 1줄 행의 우측 상대시간 (lastSeen 기준, 한국어).
function relativeTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  const diffMinutes = Math.floor((Date.now() - parsed) / 60000);
  if (diffMinutes < 1) {
    return "방금 전";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}분 전`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}시간 전`;
  }
  return `${Math.floor(diffHours / 24)}일 전`;
}

function sessionDuration(session: SessionRow): string {
  const start = Date.parse(session.firstSeen);
  const end = Date.parse(session.lastSeen);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return "길이 ?";
  }
  return `길이 ${formatReplayClock(Math.max(0, (end - start) / 1000))}`;
}

function matchesQuery(text: string, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return !normalized || text.toLowerCase().includes(normalized);
}

function traceSearchText(trace: TraceRow): string {
  return [
    trace.traceId,
    trace.sessionId,
    trace.status,
    trace.summary,
    trace.route,
    trace.services.join(" "),
    trace.front?.summary,
    trace.front?.user ? JSON.stringify(trace.front.user) : "",
    trace.front?.context ? JSON.stringify(trace.front.context) : "",
    trace.back?.summary,
    trace.back?.user ? JSON.stringify(trace.back.user) : "",
    trace.back?.context ? JSON.stringify(trace.back.context) : "",
    trace.back?.error?.name,
    trace.back?.error?.message,
    ...trace.replays.flatMap(replay => [
      replay.platform,
      replay.sessionId,
      replay.metadata ? JSON.stringify(replay.metadata) : "",
      replayEventLines(replay).join(" "),
      replay.frames?.map(frameLine).join(" ")
    ])
  ].filter(Boolean).join(" ");
}

function traceSessionIds(trace: TraceRow): string[] {
  const explicit = [
    trace.sessionId,
    ...trace.replays.map(replay => replay.sessionId)
  ].filter((id): id is string => Boolean(id));
  return explicit.length ? [...new Set(explicit)] : [trace.traceId];
}

function sessionSearchText(session: SessionRow): string {
  return [
    session.sessionId,
    session.summary,
    session.services.join(" "),
    session.platforms.join(" "),
    session.errorCount > 0 ? "error" : "ok"
  ].filter(Boolean).join(" ");
}

function userSearchText(user: UserRow): string {
  return [
    user.id,
    user.email,
    user.name,
    ...user.sessions.map(sessionSearchText)
  ].filter(Boolean).join(" ");
}

function DetailMetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="detailMetaRow">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function TraceDetail({ trace, relatedTraces, occurrenceTotal, days }: { trace: TraceRow; relatedTraces?: TraceRow[]; occurrenceTotal?: number; days: number }) {
  const [copied, setCopied] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);

  async function copyTraceLink() {
    const url = new URL(window.location.href);
    url.searchParams.set("traceId", trace.traceId);
    if (relatedTraces?.length) {
      url.searchParams.set("view", "issues");
    }
    await navigator.clipboard?.writeText(url.toString());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  async function copyIncidentSummary() {
    await navigator.clipboard?.writeText(incidentShareSummary(trace, relatedTraces, occurrenceTotal));
    setCopiedSummary(true);
    window.setTimeout(() => setCopiedSummary(false), 1200);
  }

  const metaRows: { label: string; value: string }[] = [{ label: "트레이스 ID", value: trace.traceId }];
  if (trace.sessionId) {
    metaRows.push({ label: "세션", value: trace.sessionId });
  }
  if (trace.replays.length) {
    metaRows.push({ label: "리플레이", value: Array.from(new Set(trace.replays.map(replay => replay.platform))).join(", ") });
  }
  for (const tag of traceTags(trace)) {
    const gap = tag.indexOf(" ");
    metaRows.push(gap > 0 ? { label: tag.slice(0, gap), value: tag.slice(gap + 1) } : { label: tag, value: "" });
  }
  const user = userLine(trace);
  if (user) {
    metaRows.push({ label: "사용자", value: user.replace(/^사용자 /, "") });
  }

  // 세션 중심 상세: 위→아래로 ① 세션 리플레이 ② 백엔드 워터폴 ③ 4종+에러 이벤트 스트림
  // ④ 접힘 "전체 데이터"(기존 상세 전부: 헤더·통합 타임라인·프론트/백 타임라인·이슈 이력·AI 프롬프트·메타데이터).
  return (
    <div className="detailGrid">
      <SessionReplay trace={trace} days={days} />
      {trace.back ? <BackendWaterfall document={trace.back} /> : null}
      <EventStream trace={trace} />
      <details className="collapsePanel full allData">
        <summary>전체 데이터</summary>
        <div className="allDataInner">
          <div className="detailHeader">
            <div className="detailTitleRow">
              <span className={`status ${trace.status}`}>{statusLabel(trace.status)}</span>
              <h2>{trace.summary || "트레이스 상세"}</h2>
              <div className="detailActions">
                <button className="miniButton" onClick={() => void copyIncidentSummary()} type="button">
                  {copiedSummary ? "복사됨" : "요약 복사"}
                </button>
                <button className="miniButton" onClick={() => void copyTraceLink()} type="button">
                  {copied ? "복사됨" : "링크 복사"}
                </button>
              </div>
            </div>
            <details className="detailRawMeta">
              <summary>메타데이터 전체</summary>
              <dl className="detailMeta">
                {metaRows.map(row => <DetailMetaRow key={`${row.label}:${row.value}`} label={row.label} value={row.value} />)}
              </dl>
              {trace.replays[0]?.metadata ? <code>{metadataLine(trace.replays[0].metadata)}</code> : null}
            </details>
          </div>
          <div className="detailGrid">
            <IncidentSequencePanel trace={trace} />
            <details className="collapsePanel">
              <summary>프론트엔드 사용자 타임라인 · {timelineEventCount(trace.front)}건</summary>
              <TimelinePanel title="프론트엔드 사용자 타임라인" document={trace.front} />
            </details>
            <details className="collapsePanel">
              <summary>백엔드 에러 타임라인 · {timelineEventCount(trace.back)}건</summary>
              <TimelinePanel title="백엔드 에러 타임라인" document={trace.back} />
            </details>
            {relatedTraces?.length ? (
              <details className="collapsePanel full">
                <summary>이슈 발생 이력 · 전체 {occurrenceTotal ?? relatedTraces.length}건</summary>
                <IssueOccurrences traces={relatedTraces} total={occurrenceTotal ?? relatedTraces.length} />
              </details>
            ) : null}
            <details className="collapsePanel full">
              <summary>AI 분석 프롬프트</summary>
              <AnalysisPromptPanel trace={trace} relatedTraces={relatedTraces} occurrenceTotal={occurrenceTotal} />
            </details>
          </div>
        </div>
      </details>
    </div>
  );
}

type StreamCategory = "click" | "view" | "api" | "log" | "error";
type StreamFilter = "all" | StreamCategory;

type StreamEvent = {
  category: StreamCategory;
  side: "front" | "back";
  at: string;
  time: number;
  text: string;
  durationMs?: number;
  slow?: boolean;
  data?: Record<string, unknown>;
};

const STREAM_CHIP: Record<StreamCategory, { label: string; className: string }> = {
  click: { label: "클릭", className: "click" },
  view: { label: "뷰", className: "view" },
  api: { label: "API", className: "fetch" },
  log: { label: "로그", className: "info" },
  error: { label: "에러", className: "error" }
};

// 세션 상세의 신규 이벤트 스트림: front/back 문서의 events를 시간순 병합해
// 4종(클릭·뷰·API·에러)만 노출하고, performance/scroll/mutation 등은 숨긴다.
function EventStream({ trace }: { trace: TraceRow }) {
  const [filter, setFilter] = useState<StreamFilter>("all");
  const [expanded, setExpanded] = useState<string>("");
  const events = useMemo(() => sessionStreamEvents(trace), [trace]);
  const counts = useMemo(() => streamCounts(events), [events]);
  const visible = filter === "all" ? events : events.filter(event => event.category === filter);

  return (
    <section className="timelinePanel full">
      <header>
        <h3>이벤트 스트림</h3>
        <span>이벤트 {events.length}건</span>
      </header>
      <div className="eventStreamFilters" aria-label="이벤트 스트림 필터">
        <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")} type="button">전체 {events.length}</button>
        <button className={filter === "click" ? "active" : ""} onClick={() => setFilter("click")} type="button">클릭 {counts.click}</button>
        <button className={filter === "view" ? "active" : ""} onClick={() => setFilter("view")} type="button">뷰 {counts.view}</button>
        <button className={filter === "api" ? "active" : ""} onClick={() => setFilter("api")} type="button">API {counts.api}</button>
        <button className={filter === "log" ? "active" : ""} onClick={() => setFilter("log")} type="button">로그 {counts.log}</button>
        <button className={filter === "error" ? "active" : ""} onClick={() => setFilter("error")} type="button">에러 {counts.error}</button>
      </div>
      <div className="eventStreamRows">
        {visible.map((event, index) => {
          const chip = STREAM_CHIP[event.category];
          const key = `${event.time}-${event.side}-${index}`;
          const expandable = streamExpandable(event);
          const open = expandable && expanded === key;
          const bodies = apiBodies(event);
          return (
            <div className="eventStreamItem" key={key}>
              <button
                className={`eventLine structured ${expandable ? "expandable" : ""} ${open ? "active" : ""}`}
                onClick={() => {
                  if (expandable) {
                    setExpanded(open ? "" : key);
                  }
                }}
                type="button"
              >
                <span className="eventTime" title={`세션 시작 +${event.at}`}>{wallClock(event.time)}</span>
                <span className="eventTimeOffset">+{event.at}</span>
                <span className={`eventKind ${chip.className}`}>{chip.label}</span>
                {event.side === "back" ? <span className="eventKind ssr">SSR</span> : null}
                <span className="eventBody">{event.text}</span>
                {expandable ? <span className="eventExpand">{open ? "▾" : "▸"}</span> : null}
              </button>
              {open ? (
                <div className="eventData">
                  {typeof event.durationMs === "number" || event.slow ? (
                    <div className="eventStreamMeta">
                      {typeof event.durationMs === "number" ? <span className="eventKind info">{event.durationMs}ms</span> : null}
                      {event.slow ? <span className="eventKind slow">SLOW</span> : null}
                    </div>
                  ) : null}
                  {bodies.requestBody !== undefined ? (
                    <>
                      <p className="selectedEventLabel">requestBody</p>
                      <pre>{prettyJson(bodies.requestBody)}</pre>
                    </>
                  ) : null}
                  {bodies.responseBody !== undefined ? (
                    <>
                      <p className="selectedEventLabel">responseBody</p>
                      <pre>{prettyJson(bodies.responseBody)}</pre>
                    </>
                  ) : null}
                  {bodies.requestBody === undefined && bodies.responseBody === undefined && event.data ? (
                    <>
                      <p className="selectedEventLabel">데이터</p>
                      <pre>{prettyJson(event.data)}</pre>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {!visible.length ? <div className="emptyLine">이 필터에 해당하는 이벤트가 없습니다.</div> : null}
      </div>
    </section>
  );
}

// 이벤트가 실제로 찍힌 벽시계 시각(로컬) — 스트림 행의 기본 표기.
function wallClock(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "";
  }
  const d = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function sessionStreamEvents(trace: TraceRow): StreamEvent[] {
  const merged = [
    ...streamEventsFromDocument(trace.front, "front"),
    ...streamEventsFromDocument(trace.back, "back")
  ].sort((left, right) => left.time - right.time || (left.side === right.side ? 0 : left.side === "front" ? -1 : 1));

  // front는 "0.5s" 오프셋, back(SSR)은 ISO 시각으로 들어온다 — 스트림 최초 이벤트를
  // 0초로 삼는 단일 시계로 표시를 통일한다 (SSR prefetch가 보통 t0가 된다).
  const t0 = merged.length ? Math.min(...merged.map(event => event.time)) : 0;
  return merged.map(event =>
    Number.isFinite(event.time) ? { ...event, at: `${((event.time - t0) / 1000).toFixed(3)}s` } : event
  );
}

function streamEventsFromDocument(document: TimelineDocument | undefined, side: "front" | "back"): StreamEvent[] {
  if (!document) {
    return [];
  }
  const startedAt = Date.parse(document.startedAt);
  const base = Number.isFinite(startedAt) ? startedAt : 0;
  const structured = document.events?.length ? document.events : timelineEventsFromLines(document.timeline);
  return structured.flatMap(event => {
    const category = streamCategory(event.kind);
    if (!category) {
      return [];
    }
    // front 이벤트의 at은 "0.5s" 오프셋, back(SSR)은 ISO 타임스탬프 — 형식별로 절대시각화한다.
    const isOffset = /^\d+(?:\.\d+)?s$/.test(event.at);
    const isoTime = isOffset ? Number.NaN : Date.parse(event.at);
    const time = isOffset || !Number.isFinite(isoTime)
      ? base + Math.round(promptOffsetSeconds(event.at) * 1000)
      : isoTime;
    return [{
      category,
      side,
      at: event.at,
      time,
      text: event.text,
      durationMs: event.durationMs,
      slow: event.slow,
      data: event.data
    }];
  });
}

// 4종 분류: 클릭(click/rage_click), 뷰(navigation/route/view), API(front fetch + back
// fetch/request/db 등 API성 이벤트), 에러(error). 그 외 kind는 스트림에서 제외한다.
function streamCategory(kind: string): StreamCategory | null {
  const value = kind.toLowerCase();
  if (value === "click" || value === "rage_click") {
    return "click";
  }
  if (value === "navigation" || value === "route" || value === "view") {
    return "view";
  }
  if (value === "fetch" || value === "xhr" || value === "request" || value === "network" || value === "db" || value === "query" || value === "sql" || value === "http") {
    return "api";
  }
  if (value === "log" || value === "action") {
    return "log";
  }
  if (value === "error") {
    return "error";
  }
  return null;
}

function streamCounts(events: StreamEvent[]): Record<StreamCategory, number> {
  return {
    click: events.filter(event => event.category === "click").length,
    view: events.filter(event => event.category === "view").length,
    api: events.filter(event => event.category === "api").length,
    log: events.filter(event => event.category === "log").length,
    error: events.filter(event => event.category === "error").length
  };
}

function apiBodies(event: StreamEvent): { requestBody?: unknown; responseBody?: unknown } {
  const data = event.data ?? {};
  return { requestBody: data.requestBody, responseBody: data.responseBody };
}

function streamExpandable(event: StreamEvent): boolean {
  if (event.category === "log") {
    return event.data !== undefined && event.data !== null;
  }
  if (event.category !== "api") {
    return false;
  }
  const bodies = apiBodies(event);
  return bodies.requestBody !== undefined
    || bodies.responseBody !== undefined
    || typeof event.durationMs === "number"
    || Boolean(event.slow)
    || Boolean(event.data && Object.keys(event.data).length);
}

function prettyJson(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// events 배열이 없는 레거시 문서는 timeline 문자열을 원시 kind까지 보존해 파싱한다.
function timelineEventsFromLines(lines: string[]): TimelineEvent[] {
  return lines.map(timelineLine).filter(Boolean).map(line => {
    const match = /^(\d+(?:\.\d+)?s)\s+(\S+)\s+(?:(info|warn|warning|error|debug|log)\s+)?([\s\S]*)$/.exec(line);
    if (!match) {
      return { at: "0.000s", kind: "info", text: line };
    }
    return { at: match[1] ?? "0.000s", kind: match[2] ?? "info", severity: match[3], text: match[4] || line };
  });
}

function IncidentSequencePanel({ trace }: { trace: TraceRow }) {
  const [selectedLine, setSelectedLine] = useState("");
  const events = useMemo(() => incidentSequenceEvents(trace), [trace]);

  return (
    <section className="timelinePanel full">
      <header>
        <h3>통합 타임라인</h3>
        <span>이벤트 {events.length}건</span>
      </header>
      <EventList events={events.map(event => `${event.iso} ${event.source} ${event.line}`)} eventDetails={events.map(event => event.detail)} selected={selectedLine} onSelect={setSelectedLine} structured />
    </section>
  );
}

function AnalysisPromptPanel({ trace, relatedTraces, occurrenceTotal }: { trace: TraceRow; relatedTraces?: TraceRow[]; occurrenceTotal?: number }) {
  const [copied, setCopied] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const prompt = useMemo(() => analysisPrompt(trace, relatedTraces, occurrenceTotal), [trace, relatedTraces, occurrenceTotal]);
  const summaryJson = useMemo(() => aiSessionJson(trace, relatedTraces, occurrenceTotal), [trace, relatedTraces, occurrenceTotal]);
  const filename = useMemo(() => aiSessionFilename(trace), [trace]);
  const command = useMemo(() => localAiCommand(filename), [filename]);

  async function copyPrompt() {
    await navigator.clipboard?.writeText(prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  async function openAiTroubleshooting() {
    setExpanded(true);
    await navigator.clipboard?.writeText(command);
    setCopiedCommand(true);
    window.setTimeout(() => setCopiedCommand(false), 1200);
  }

  async function copyCommand() {
    await navigator.clipboard?.writeText(command);
    setCopiedCommand(true);
    window.setTimeout(() => setCopiedCommand(false), 1200);
  }

  function downloadSummary() {
    const url = URL.createObjectURL(new Blob([summaryJson], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="timelinePanel full" id="ai-troubleshooting">
      <header>
        <h3>로컬 AI 트러블슈팅</h3>
        <div className="panelActions">
          <button className="miniButton" onClick={() => void openAiTroubleshooting()} type="button">
            {copiedCommand ? "명령어 복사됨" : "AI 트러블슈팅 분석"}
          </button>
          <button className="miniButton" onClick={downloadSummary} type="button">
            JSON 다운로드
          </button>
          <button className="miniButton" onClick={() => void copyPrompt()} type="button">
            {copied ? "프롬프트 복사됨" : "프롬프트 복사"}
          </button>
        </div>
      </header>
      {expanded ? (
        <>
          <p className="summary">세션 JSON을 다운로드한 뒤, 로컬 터미널에서 이 명령어를 실행하세요.</p>
          <pre className="commandBox">{command}</pre>
          <div className="panelActions inline">
            <button className="miniButton" onClick={() => void copyCommand()} type="button">
              {copiedCommand ? "복사됨" : "명령어 복사"}
            </button>
            <button className="miniButton" onClick={downloadSummary} type="button">
              {filename}
            </button>
          </div>
          <textarea className="promptBox" readOnly value={summaryJson} />
        </>
      ) : (
        <textarea className="promptBox" readOnly value={prompt} />
      )}
    </section>
  );
}

function IssueOccurrences({ traces, total }: { traces: TraceRow[]; total: number }) {
  const trace = traces[0];
  const sorted = [...traces].sort((left, right) => left.lastSeen.localeCompare(right.lastSeen));
  const firstSeen = sorted[0]?.lastSeen;
  const latest = sorted[sorted.length - 1]?.lastSeen;
  return (
    <section className="timelinePanel full">
      <header>
        <h3>이슈 발생 이력</h3>
        <span>전체 {total}건 · 최근 로드 {traces.length}건{firstSeen && latest ? ` · ${timeLabel(firstSeen)} ~ ${timeLabel(latest)}` : ""}</span>
      </header>
      {trace ? <p className="summary">{issueCause(trace)} · {issueImpact(trace)}</p> : null}
      <div className="occurrenceList">
        {sorted.slice(-8).reverse().map(trace => (
          <div className="occurrenceRow" key={trace.traceId}>
            <strong>{timeLabel(trace.lastSeen)}</strong>
            <span>{trace.services.join(", ") || "서비스 미상"}</span>
            <em>{trace.replays.map(replay => replay.platform).join(", ") || "리플레이 없음"}</em>
            <code>{trace.traceId}</code>
          </div>
        ))}
      </div>
    </section>
  );
}

function incidentShareSummary(trace: TraceRow, relatedTraces?: TraceRow[], occurrenceTotal?: number): string {
  const platforms = compactUnique(trace.replays.map(replay => replay.platform)).join(", ") || "none";
  const sessions = traceSessionIds(trace).join(", ");
  const front = trace.front?.summary ? `frontend: ${trace.front.summary}` : "frontend: missing";
  const back = trace.back?.summary ? `backend: ${trace.back.summary}` : "backend: missing";
  const replay = trace.replays.length
    ? `replay: ${platforms}, screens=${trace.replays.reduce((total, item) => total + visualFrameCount(item), 0)}`
    : "replay: missing";

  return [
    `JayTrace incident: ${trace.summary || issueCause(trace)}`,
    `traceId: ${trace.traceId}`,
    `sessions: ${sessions}`,
    `status: ${trace.status}`,
    `impact: ${relatedTraces?.length ? `${occurrenceTotal ?? relatedTraces.length} total traces · ${relatedTraces.length} recent traces loaded · ${issueImpact(trace)}` : issueImpact(trace)}`,
    front,
    back,
    replay
  ].join("\n");
}

function metadataLine(metadata: Record<string, unknown>): string {
  return Object.entries(metadata)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}

function traceTags(trace: TraceRow): string[] {
  return compactUnique([
    trace.front?.service ? `서비스 ${trace.front.service}` : "",
    tagValue("환경", traceDimension(trace, "environment")),
    tagValue("릴리스", traceDimension(trace, "release"))
  ]);
}

function traceDimension(trace: TraceRow, key: "environment" | "release"): unknown {
  return trace.front?.context?.[key] ?? trace.replays[0]?.metadata?.[key];
}

function tagValue(label: string, value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? `${label} ${String(value)}` : "";
}

function compactUnique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function replayLabel(replay: ReplayDocument): string {
  const metadata = replay.metadata ?? {};
  const device = [metadata.os, metadata.device, metadata.appVersion]
    .filter(value => typeof value === "string" || typeof value === "number")
    .map(String)
    .join(" ");
  return device ? `${replay.platform} ${device}` : replay.platform;
}

function userLine(trace: TraceRow): string {
  const frontUser = trace.front?.context?.user;
  if (frontUser && typeof frontUser === "object") {
    return `사용자 ${metadataLine(frontUser as Record<string, unknown>)}`;
  }

  const replayUser = Object.fromEntries(
    Object.entries(trace.replays[0]?.metadata ?? {})
      .filter(([key]) => key.startsWith("user."))
      .map(([key, value]) => [key.replace(/^user\./, ""), value])
  );
  return Object.keys(replayUser).length ? `사용자 ${metadataLine(replayUser)}` : "";
}

function analysisPrompt(trace: TraceRow, relatedTraces?: TraceRow[], occurrenceTotal?: number): string {
  return [
    "You are analyzing a JayTrace full-stack incident.",
    "Find the most likely root cause, explain the front-to-back sequence, and suggest the smallest safe fix.",
    "Use only the provided lightweight timeline and replay data.",
    "",
    `Trace ID: ${trace.traceId}`,
    traceSessionIds(trace).length ? `Session IDs: ${traceSessionIds(trace).join(", ")}` : "",
    "",
    issueOccurrencesSection(trace, relatedTraces, occurrenceTotal),
    incidentSequenceSection(trace),
    "",
    timelinePromptSection("FRONTEND USER TIMELINE", trace.front),
    "",
    timelinePromptSection("BACKEND ERROR TIMELINE", trace.back),
    "",
    replayPromptSections(trace.replays),
    "",
    "Return:",
    "1. Root cause",
    "2. Evidence chain",
    "3. Minimal fix",
    "4. Verification command or manual check"
  ].filter(Boolean).join("\n");
}

function aiSessionJson(trace: TraceRow, relatedTraces?: TraceRow[], occurrenceTotal?: number): string {
  return JSON.stringify({
    schema: "jaytrace.ai-session.v1",
    generatedAt: new Date().toISOString(),
    traceId: trace.traceId,
    sessionIds: traceSessionIds(trace),
    issue: issueJson(trace, relatedTraces, occurrenceTotal),
    status: trace.status,
    summary: trace.summary || issueCause(trace),
    rootCauseHint: issueCause(trace),
    impact: issueImpact(trace),
    sequence: incidentSequenceEvents(trace).slice(0, 120),
    front: compactTimelineDocument(trace.front),
    back: compactTimelineDocument(trace.back),
    replays: trace.replays.map(compactReplayDocument)
  }, null, 2);
}

// 같은 이슈(동일 근본원인)의 다른 발생 건들을 요약해 AI 페이로드에 동봉한다.
// 대표 trace는 풀 컨텍스트, 나머지는 한 줄 요약으로 프롬프트 크기를 관리 (최대 20건).
function issueOccurrencesSection(trace: TraceRow, relatedTraces?: TraceRow[], occurrenceTotal?: number): string {
  const others = (relatedTraces ?? []).filter(item => item.traceId !== trace.traceId);
  if (!others.length && (occurrenceTotal ?? 1) <= 1) {
    return "";
  }
  const sorted = [...others].sort((left, right) => left.lastSeen.localeCompare(right.lastSeen));
  const lines = sorted.slice(-20).map(item =>
    `- ${item.lastSeen} · ${item.services.join(",") || "unknown"} · ${compactUnique(item.replays.map(replay => replay.platform)).join(",") || "no-replay"} · ${issueCause(item)} · trace ${item.traceId}`
  );
  return [
    `ISSUE OCCURRENCES SAMPLE (same root cause; ${occurrenceTotal ?? (relatedTraces ?? []).length} total, ${relatedTraces?.length ?? 0} recent traces loaded, showing up to 20 other occurrences)`,
    "Use recurrence patterns across these occurrences (shared pages, platforms, timing) to narrow the root cause.",
    ...lines,
    ""
  ].join("\n");
}

function issueJson(trace: TraceRow, relatedTraces?: TraceRow[], occurrenceTotal?: number) {
  const others = (relatedTraces ?? []).filter(item => item.traceId !== trace.traceId);
  if (!others.length && (occurrenceTotal ?? 1) <= 1) {
    return null;
  }
  const sorted = [...(relatedTraces ?? [])].sort((left, right) => left.lastSeen.localeCompare(right.lastSeen));
  return {
    totalTraces: occurrenceTotal ?? (relatedTraces ?? []).length,
    loadedRecentTraces: (relatedTraces ?? []).length,
    occurrencesAreSample: true,
    firstSeen: sorted[0]?.lastSeen,
    lastSeen: sorted[sorted.length - 1]?.lastSeen,
    occurrences: others.slice(-20).map(compactOccurrence)
  };
}

function compactOccurrence(trace: TraceRow) {
  return {
    traceId: trace.traceId,
    at: trace.lastSeen,
    status: trace.status,
    services: trace.services,
    platforms: compactUnique(trace.replays.map(replay => replay.platform)),
    cause: issueCause(trace)
  };
}

function aiSessionFilename(trace: TraceRow): string {
  const sessionId = traceSessionIds(trace)[0] ?? trace.traceId;
  return `download_session_${safeFilePart(sessionId)}.json`;
}

function localAiCommand(filename: string): string {
  return `cat ${shellQuote(filename)} | claude code ${shellQuote("이 세션에서 발생한 Unhandled Runtime Error의 원인을 분석하고 가독성 높은 픽스 코드를 제안해줘")}`;
}

function compactTimelineDocument(document?: TimelineDocument) {
  if (!document) {
    return null;
  }
  const events = document.events?.length ? document.events : undefined;
  const bodyIndexes = events ? attachableBodyIndexes(events) : new Set<number>();
  return {
    service: document.service,
    side: document.side,
    traceId: document.traceId,
    sessionId: document.sessionId,
    startedAt: document.startedAt,
    endedAt: document.endedAt,
    summary: document.summary,
    context: document.context,
    error: document.error,
    timeline: timelineEventLines(document).slice(0, PROMPT_TIMELINE_LINE_CAP),
    events: events
      ? events.slice(0, PROMPT_TIMELINE_LINE_CAP).map((event, index) => compactPromptEvent(event, bodyIndexes.has(index)))
      : undefined
  };
}

// JSON 페이로드용 이벤트: 선별된 행에만 요약 body(requestBody/responseBody)를 유지한다.
function compactPromptEvent(event: TimelineEvent, withBody: boolean) {
  const base: Record<string, unknown> = {
    at: event.at,
    kind: event.kind,
    severity: event.severity,
    text: event.text,
    durationMs: event.durationMs,
    slow: event.slow
  };
  if (withBody) {
    const body = promptEventBody(event);
    if (body) {
      base.data = body;
    }
  }
  return base;
}

function compactReplayDocument(replay: ReplayDocument) {
  const frames = replaySummaryFrames(replayFrames(replay));
  return {
    platform: replay.platform,
    traceId: replay.traceId,
    sessionId: replay.sessionId,
    startedAt: replay.startedAt,
    endedAt: replay.endedAt,
    metadata: replay.metadata,
    signals: replayPromptSignals(replay),
    events: replayEventLines(replay).slice(0, 120),
    frames: frames.map(frame => ({
      at: frame.at,
      kind: frame.kind,
      text: frame.text,
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height
    })),
    mutations: replay.mutations?.slice(0, 40)
  };
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._=-]/g, "_").slice(0, 80) || "trace";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function incidentSequenceSection(trace: TraceRow): string {
  const events = incidentSequenceEvents(trace);

  if (!events.length) {
    return "INCIDENT SEQUENCE\nmissing";
  }

  return [
    "INCIDENT SEQUENCE",
    ...events.slice(0, 80).map(event => `- ${event.iso} ${event.source} ${event.line}`)
  ].join("\n");
}

function incidentSequenceEvents(trace: TraceRow): Array<{ iso: string; line: string; source: string; time: number; detail?: TimelineEvent }> {
  return [
    ...promptTimelineEvents("front", trace.front),
    ...promptTimelineEvents("back", trace.back),
    ...trace.replays.flatMap(replay => promptTimelineEvents(`replay:${replay.platform}`, replay))
  ].sort((left, right) => left.time - right.time);
}

function promptTimelineEvents(source: string, document?: TimelineDocument | ReplayDocument): Array<{ iso: string; line: string; source: string; time: number; detail?: TimelineEvent }> {
  if (!document) {
    return [];
  }
  const startedAt = Date.parse(document.startedAt);
  const entries = "platform" in document
    ? replayEventLines(document).map(line => ({ line, detail: undefined as TimelineEvent | undefined }))
    : timelineEventEntries(document);
  return entries.map(({ line, detail }) => {
    const time = startedAt + Math.round(promptOffsetSeconds(line) * 1000);
    return {
      iso: Number.isFinite(time) ? new Date(time).toISOString() : document.startedAt,
      line,
      source,
      time: Number.isFinite(time) ? time : startedAt,
      detail
    };
  });
}

// timeline[i] is formatTimelineLine(events[i]) at document build time, so index
// alignment is how a merged line recovers its structured event (body data, duration).
function timelineEventEntries(document: TimelineDocument): Array<{ line: string; detail?: TimelineEvent }> {
  const aligned = document.events?.length === document.timeline.length ? document.events : undefined;
  return document.timeline
    .map((value, index) => ({ line: timelineLine(value), detail: aligned?.[index] }))
    .filter(entry => Boolean(entry.line));
}

function timelineEventLines(document: TimelineDocument): string[] {
  return document.timeline.map(timelineLine).filter(Boolean);
}

function timelineLine(value: unknown): string {
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

function promptOffsetSeconds(line: string): number {
  return Number.parseFloat(line.match(/^(\d+(?:\.\d+)?)s\b/)?.[1] ?? "0") || 0;
}

const PROMPT_TIMELINE_LINE_CAP = 120;
const PROMPT_BODY_ROW_CAP = 8;
const PROMPT_BODY_MAX_CHARS = 1000;

// AI 프롬프트에 body 근거를 붙일 이벤트 행을 선별한다: kind fetch/error 중
// ① status>=400 ② slow=true ③ error 직전 3건 이내의 fetch. 최대 8행.
function attachableBodyIndexes(events: TimelineEvent[]): Set<number> {
  const errorIndexes = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind.toLowerCase() === "error")
    .map(({ index }) => index);
  const selected = new Set<number>();
  events.forEach((event, index) => {
    if (selected.size >= PROMPT_BODY_ROW_CAP) {
      return;
    }
    const kind = event.kind.toLowerCase();
    if (kind !== "fetch" && kind !== "error") {
      return;
    }
    if (!promptEventBody(event)) {
      return;
    }
    const status = Number(/status=(\d+)/.exec(event.text)?.[1]);
    const nearError = kind === "fetch" && errorIndexes.some(errorIndex => errorIndex > index && errorIndex - index <= 3);
    if ((Number.isFinite(status) && status >= 400) || event.slow === true || nearError) {
      selected.add(index);
    }
  });
  return selected;
}

// requestBody/responseBody만 추려 각 body를 개별적으로 1,000자 초과 시 절단한다.
function promptEventBody(event: TimelineEvent): Record<string, unknown> | null {
  const data = event.data;
  if (!data) {
    return null;
  }
  const body: Record<string, unknown> = {};
  if (data.requestBody !== undefined) {
    body.requestBody = truncateBodyValue(data.requestBody);
  }
  if (data.responseBody !== undefined) {
    body.responseBody = truncateBodyValue(data.responseBody);
  }
  return Object.keys(body).length ? body : null;
}

function truncateBodyValue(value: unknown): unknown {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return String(value);
  }
  if (text === undefined) {
    return value;
  }
  return text.length > PROMPT_BODY_MAX_CHARS ? `${text.slice(0, PROMPT_BODY_MAX_CHARS)}…truncated` : value;
}

function timelinePromptSection(title: string, document?: TimelineDocument): string {
  if (!document) {
    return `${title}\nmissing`;
  }

  const events = document.events?.length ? document.events : undefined;
  const bodyIndexes = events ? attachableBodyIndexes(events) : new Set<number>();
  const rawLines = events ? events.map(timelineEventLine) : document.timeline.map(timelineLine).filter(Boolean);
  const timelineLines: string[] = [];
  rawLines.slice(0, PROMPT_TIMELINE_LINE_CAP).forEach((line, index) => {
    timelineLines.push(`- ${line}`);
    const event = events?.[index];
    if (event && bodyIndexes.has(index)) {
      const body = promptEventBody(event);
      if (body) {
        timelineLines.push(`  data: ${JSON.stringify(body)}`);
      }
    }
  });
  if (rawLines.length > PROMPT_TIMELINE_LINE_CAP) {
    timelineLines.push(`- …(${rawLines.length - PROMPT_TIMELINE_LINE_CAP} more lines omitted)`);
  }

  return [
    title,
    `service: ${document.service}`,
    `side: ${document.side}`,
    `startedAt: ${document.startedAt}`,
    document.endedAt ? `endedAt: ${document.endedAt}` : "",
    `summary: ${document.summary}`,
    document.context ? `context: ${JSON.stringify(document.context)}` : "",
    document.error ? `error: ${JSON.stringify(document.error)}` : "",
    "timeline:",
    ...timelineLines
  ].filter(Boolean).join("\n");
}

function replayPromptSection(replay?: ReplayDocument): string {
  if (!replay) {
    return "SESSION REPLAY TIMELINE\nmissing";
  }

  return [
    "SESSION REPLAY TIMELINE",
    `platform: ${replay.platform}`,
    `startedAt: ${replay.startedAt}`,
    replay.endedAt ? `endedAt: ${replay.endedAt}` : "",
    replay.sessionId ? `sessionId: ${replay.sessionId}` : "",
    replay.metadata ? `metadata: ${JSON.stringify(replay.metadata)}` : "",
    replay.frames?.length ? `frames: ${replay.frames.length} captured` : "",
    visualFrameCount(replay) ? `screens: ${visualFrameCount(replay)} captured` : "",
    replayScreenshotMissing(replay) ? "screens: missing screenshot provider" : "",
    replay.mutations?.length ? `mutations: ${replay.mutations.length} captured` : "",
    ...replayPromptSignals(replay),
    "events:",
    ...replayEventLines(replay).slice(0, 60).map(line => `- ${line}`)
  ].filter(Boolean).join("\n");
}

function visualFrameCount(replay: ReplayDocument): number {
  // 상세 문서는 frames로 실측하고, 목록 스텁은 서버가 담아준 visualFrames로 폴백한다.
  return replay.frames?.filter(frame => frame.html || frame.image).length ?? replay.visualFrames ?? 0;
}

function replayPromptSignals(replay: ReplayDocument): string[] {
  const signals: string[] = [];
  const lines = replayEventLines(replay);
  const errors = lines.filter(line => /\berror\b|status=5\d\d/.test(line));
  if (errors.length) {
    signals.push("errors:");
    signals.push(...errors.slice(0, 5).map(line => `- ${line}`));
  }
  const network = lines.filter(line => line.includes(" network "));
  if (network.length) {
    signals.push("network:");
    signals.push(...network.slice(0, 5).map(line => `- ${line}`));
  }
  const performance = lines.filter(line => /\bperformance\b|long_task/.test(line));
  if (performance.length) {
    signals.push("performance:");
    signals.push(...performance.slice(0, 5).map(line => `- ${line}`));
  }
  const actionsBeforeError = actionLinesBeforeIssue(lines);
  if (actionsBeforeError.length) {
    signals.push("actions before issue:");
    signals.push(...actionsBeforeError.map(line => `- ${line}`));
  }
  if (replay.frames?.length) {
    signals.push("frame summary:");
    signals.push(...replaySummaryFrames(replay.frames).map(replayFrameSummaryLine));
  }
  if (replay.mutations?.length) {
    signals.push("mutation summary:");
    signals.push(...replay.mutations.slice(0, 5).map(mutation => `- ${mutation.at} ${mutation.type} ${mutation.target}`));
  }
  return signals;
}

function actionLinesBeforeIssue(lines: string[]): string[] {
  const issueTime = Math.min(...lines.filter(line => /\berror\b|status=5\d\d|failed/i.test(line)).map(promptOffsetSeconds));
  if (!Number.isFinite(issueTime)) {
    return [];
  }
  return lines
    .filter(line => /\b(click|tap|gesture|action|input|scroll)\b/i.test(line) && promptOffsetSeconds(line) <= issueTime)
    .sort((left, right) => promptOffsetSeconds(left) - promptOffsetSeconds(right))
    .slice(-3);
}

function replayFrameSummaryLine(frame: ReplayFrame): string {
  const point = typeof frame.x === "number" && typeof frame.y === "number" ? ` point=${frame.x},${frame.y}` : "";
  return `- ${frame.at} ${frame.kind} ${frame.width ?? "?"}x${frame.height ?? "?"}${point}${frame.text ? ` ${frame.text}` : ""}`;
}

function replaySummaryFrames(frames: ReplayFrame[]): ReplayFrame[] {
  const selected = [
    ...frames.slice(0, 3),
    ...frames.filter(frame => /\berror\b|network|status=5\d\d/i.test(`${frame.kind} ${frame.text}`)),
    [...frames].reverse().find(frame => frame.html || frame.image)
  ].filter((frame): frame is ReplayFrame => Boolean(frame));

  return [...new Map(selected.map(frame => [`${frame.at}:${frame.kind}:${frame.text}`, frame])).values()].slice(0, 8);
}

function replayPromptSections(replays: ReplayDocument[]): string {
  if (!replays.length) {
    return "SESSION REPLAY TIMELINE\nmissing";
  }

  return replays.map(replayPromptSection).join("\n\n");
}

// ── 백엔드 워터폴 ───────────────────────────────────────────────────────────
// Datadog 스타일 가로 시간축. 막대 시작은 event.at, 폭은 durationMs(없으면 점 마커).
// depth/spanId/parentSpanId/attrs/context.host/error.stack은 전부 optional SDK 확장
// 필드라 없으면 평면 워터폴 + 축약 패널로 그대로 동작한다.

const WATERFALL_TONE_LABEL: Record<WaterfallTone, string> = {
  request: "요청",
  db: "DB",
  fetch: "외부",
  log: "로그",
  error: "에러",
  other: "기타"
};

// /api/stats는 (service, route)마다 같은 답을 주므로 모듈 캐시에 담는다 — 이벤트를 클릭할
// 때마다, 또 같은 라우트의 다른 트레이스를 열 때마다 다시 부르지 않기 위해서다.
// null은 "집계 없음"(available:false 또는 실패)이며, 이 경우 배지는 그냥 렌더하지 않는다.
type RouteStats = {
  available: true;
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  histogram: number[];
};

const routeStatsCache = new Map<string, RouteStats | null>();

function useRouteStats(service: string | undefined, route: string | undefined): RouteStats | null {
  const query = service && route
    ? `service=${encodeURIComponent(service)}&route=${encodeURIComponent(route)}`
    : "";
  const [stats, setStats] = useState<RouteStats | null>(null);

  useEffect(() => {
    if (!query) {
      setStats(null);
      return;
    }
    const cached = routeStatsCache.get(query);
    if (cached !== undefined) {
      setStats(cached);
      return;
    }
    let cancelled = false;
    // 통계는 부가 정보라 실패는 조용히 삼킨다 — 배지만 사라지고 상세 화면은 그대로 뜬다.
    fetch(`/api/stats?${query}`)
      .then(res => (res.ok ? res.json() : null))
      .then((json: { available?: boolean } | null) => {
        const value = json?.available ? (json as RouteStats) : null;
        routeStatsCache.set(query, value);
        if (!cancelled) setStats(value);
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  return stats;
}

/**
 * 라우트 키: jaytrace_route_stats.route와 동일한 라벨이어야 조회가 맞는다.
 * SDK 규칙(SERVER): `${METHOD} ${http.route}` — method 없으면 "REQUEST", 항상 대문자.
 * route 소스는 context.route가 1순위, 없으면 request 이벤트의 http.route attr.
 * MSG(CONSUMER) 문서는 context.route가 없어 undefined → 배지 숨김(v1 범위 밖).
 */
function documentRoute(document: TimelineDocument, events: TimelineEvent[]): string | undefined {
  let route: string | undefined;
  // 통계 키(rootRouteLabel)와 같은 소스인 http.route 템플릿이 1순위.
  // context.route는 url.path 폴백이 섞인 표시용 값이라 파라미터 라우트에서 키가 어긋난다.
  for (const event of events) {
    const attr = event.attrs?.["http.route"];
    if (typeof attr === "string" && attr.trim()) {
      route = attr.trim();
      break;
    }
  }
  if (!route) {
    const contextRoute = document.context?.route;
    if (typeof contextRoute === "string" && contextRoute.trim()) {
      route = contextRoute.trim();
    }
  }
  if (!route) {
    return undefined;
  }
  const contextMethod = document.context?.method;
  const method =
    typeof contextMethod === "string" && contextMethod.trim() ? contextMethod.trim() : "REQUEST";
  return `${method.toUpperCase()} ${route}`;
}

function BackendWaterfall({ document }: { document: TimelineDocument }) {
  const [selected, setSelected] = useState(-1);
  const events = useMemo(
    () => (document.events?.length ? document.events : timelineEventsFromLines(document.timeline)),
    [document]
  );
  const bars = useMemo(() => waterfallBars(events, document), [events, document]);
  const total = useMemo(() => waterfallTotalSeconds(bars, document), [bars, document]);
  const stats = useRouteStats(document.service, documentRoute(document, events));
  const selectedBar = bars.find(bar => bar.index === selected);
  const host = hostContext(document.context);

  if (!bars.length) {
    return null;
  }

  return (
    <section className="timelinePanel full waterfallPanel">
      <header>
        <h3>백엔드 워터폴</h3>
        <span>{document.service} · 이벤트 {bars.length}건 · {formatWaterfallSeconds(total)}</span>
      </header>
      <div className="waterfallAxis" aria-hidden="true">
        <span />
        <span className="waterfallTicks">
          {waterfallTicks(total).map(tick => <span key={tick.ratio}>{tick.label}</span>)}
        </span>
        <span />
      </div>
      <div className="waterfallRows">
        {bars.map(bar => (
          <button
            aria-pressed={bar.index === selected}
            className={`waterfallRow ${bar.index === selected ? "active" : ""}`}
            key={`${bar.event.at}-${bar.index}`}
            onClick={() => setSelected(bar.index === selected ? -1 : bar.index)}
            title={`+${bar.event.at} ${bar.event.kind} ${bar.event.text}`}
            type="button"
          >
            <span className="waterfallLabel" style={{ paddingLeft: `${bar.depth * 12}px` }}>
              <span className={`eventKind ${bar.tone}`}>{WATERFALL_TONE_LABEL[bar.tone]}</span>
              <span className="waterfallText">{bar.event.text}</span>
            </span>
            <span className="waterfallTrack">
              <span className={`waterfallBar ${bar.tone} ${bar.duration > 0 ? "" : "point"}`} style={waterfallBarStyle(bar, total)} />
            </span>
            <span className="waterfallDuration">
              {typeof bar.event.durationMs === "number" ? formatWaterfallSeconds(bar.event.durationMs / 1000) : `+${bar.event.at}`}
            </span>
          </button>
        ))}
      </div>
      {selectedBar ? <EventAttributes bar={selectedBar} document={document} host={host} stats={stats} /> : null}
    </section>
  );
}

/**
 * "이 요청 412ms · p95 180ms · 상위 2%". 집계가 없으면 호출부에서 아예 렌더하지 않는다 —
 * 자리만 차지하는 플레이스홀더는 두지 않는다.
 */
function LatencyBadge({ durationMs, stats }: { durationMs: number; stats: RouteStats }) {
  const rank = formatRank(histogramRank(stats.histogram, durationMs));
  return (
    <span
      className="eventKind info"
      title={`최근 ${stats.count}건 · p50 ${formatLatency(stats.p50)} · p95 ${formatLatency(stats.p95)} · p99 ${formatLatency(stats.p99)}`}
    >
      이 요청 {formatLatency(durationMs)} · p95 {formatLatency(stats.p95)}{rank ? ` · ${rank}` : ""}
    </span>
  );
}

function EventAttributes({ bar, document, host, stats }: { bar: WaterfallBar; document: TimelineDocument; host: HostContext | null; stats: RouteStats | null }) {
  const [copied, setCopied] = useState(false);
  const event = bar.event;
  const attrs = eventAttrs(event);
  const stack = bar.tone === "error" && document.error?.stack ? stackFrames(document.error.stack) : [];

  async function copyText() {
    await navigator.clipboard?.writeText(event.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="eventAttrs">
      <div className="eventAttrsHead">
        <span className={`eventKind ${bar.tone}`}>{WATERFALL_TONE_LABEL[bar.tone]}</span>
        <span className="eventAttrsAt">+{event.at}</span>
        {typeof event.durationMs === "number" ? <span className="eventKind info">{formatWaterfallSeconds(event.durationMs / 1000)}</span> : null}
        {event.slow ? <span className="eventKind slow">SLOW</span> : null}
        {bar.tone === "request" && stats && typeof event.durationMs === "number"
          ? <LatencyBadge durationMs={event.durationMs} stats={stats} />
          : null}
        <button className="miniButton" onClick={() => void copyText()} type="button">{copied ? "복사됨" : "본문 복사"}</button>
      </div>
      <pre className="eventAttrsText">{event.text}</pre>
      {event.spanId || event.parentSpanId ? (
        <dl className="detailMeta">
          {event.spanId ? <DetailMetaRow label="spanId" value={event.spanId} /> : null}
          {event.parentSpanId ? <DetailMetaRow label="parentSpanId" value={event.parentSpanId} /> : null}
        </dl>
      ) : null}
      {attrs.length ? (
        <>
          <p className="selectedEventLabel">attrs</p>
          <dl className="detailMeta">
            {attrs.map(([key, value]) => <DetailMetaRow key={key} label={key} value={value} />)}
          </dl>
        </>
      ) : null}
      {host ? (
        <>
          <p className="selectedEventLabel">호스트</p>
          <dl className="detailMeta">
            {host.pod ? <DetailMetaRow label="pod" value={host.pod} /> : null}
            {host.rssMb ? <DetailMetaRow label="RSS" value={`${host.rssMb} MB`} /> : null}
            {host.heapUsedMb ? <DetailMetaRow label="heap used" value={`${host.heapUsedMb} MB`} /> : null}
          </dl>
        </>
      ) : null}
      {stack.length ? (
        <>
          <p className="selectedEventLabel">스택</p>
          <ol className="stackFrames">
            {stack.map((frame, index) => <li key={`${index}-${frame}`}>{frame}</li>)}
          </ol>
        </>
      ) : null}
      {event.data ? (
        <>
          <p className="selectedEventLabel">데이터</p>
          <pre>{prettyJson(event.data)}</pre>
        </>
      ) : null}
    </div>
  );
}

function TimelinePanel({ title, document }: { title: string; document?: TimelineDocument }) {
  const [selectedLine, setSelectedLine] = useState("");

  if (!document) {
    return (
      <section className="timelinePanel">
        <header>
          <h3>{title}</h3>
          <span>없음</span>
        </header>
        <p className="summary">아직 이 영역의 데이터가 없습니다.</p>
      </section>
    );
  }

  const events = document.events?.length ? document.events.map(timelineEventLine) : document.timeline;

  return (
    <section className="timelinePanel">
      <header>
        <h3>{title}</h3>
        <span>{document.service}</span>
      </header>
      {document.error ? (
        <div className="errorBox">
          <strong>{document.error.name}: {document.error.message}</strong>
          {document.error.stack ? (
            <details className="errorStack">
              <summary>스택 보기</summary>
              <pre>{document.error.stack}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
      <EventList events={events} eventDetails={document.events} selected={selectedLine} onSelect={setSelectedLine} structured />
    </section>
  );
}

function timelineEventLine(event: TimelineEvent): string {
  return `${event.at} ${event.kind}${event.severity ? ` ${event.severity}` : ""} ${event.text}`.trim();
}

// Branch: probe /api/replay once. v2 segments -> rrweb player; otherwise the v1 filmstrip (unchanged).
function SessionReplay({ trace, days }: { trace: TraceRow; days: number }) {
  const sessionId = trace.sessionId ?? trace.replays[0]?.sessionId ?? trace.traceId;
  const traceId = trace.traceId;
  const hasFilmstrip = trace.replays.length > 0;
  const [probe, setProbe] = useState<"loading" | "none" | { startedAt: string; engine: string }>("loading");

  // The /api/replay probe runs in the background. We NEVER block an available v1 filmstrip
  // on it: v1 mobile sessions have no v2 segments and the probe 404s, so gating the
  // filmstrip on the probe stalled the detail view (E2E smoke timeout). Render the
  // filmstrip immediately and only upgrade to a v2 player once the probe resolves.
  useEffect(() => {
    let cancelled = false;
    setProbe("loading");
    fetch(`/api/replay?sessionId=${encodeURIComponent(sessionId)}&days=${days}&traceId=${encodeURIComponent(traceId)}`)
      .then(async res => {
        if (cancelled) return;
        if (!res.ok) {
          setProbe("none");
          return;
        }
        const json = await res.json();
        if (!cancelled) setProbe({ startedAt: String(json.startedAt), engine: String(json.engine) });
      })
      .catch(() => {
        if (!cancelled) setProbe("none");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, days, traceId]);

  const timelineDocs = useMemo(
    () => [trace.front, trace.back].filter(Boolean) as TimelineDocument[],
    [trace.front, trace.back]
  );

  // Probe found v2 segments → swap to the matching player.
  if (probe !== "loading" && probe !== "none") {
    if (probe.engine === "wireframe") {
      // Wireframe frames are re-based onto the replay document's own startedAt
      // (mergeWireframeFrames), so that stays the marker origin here.
      const startedMs = Date.parse(probe.startedAt);
      const markers = deriveMarkers(timelineDocs, Number.isFinite(startedMs) ? startedMs : 0);
      return <WireframePlayer sessionId={sessionId} days={days} traceId={traceId} markers={markers} />;
    }
    // rrweb: the player owns the origin (first recorded event), so it derives its own markers.
    return <ReplayPlayer sessionId={sessionId} days={days} traceId={traceId} timelineDocs={timelineDocs} />;
  }

  // Probe still loading or resolved to "none": show the filmstrip whenever we have one.
  if (hasFilmstrip) {
    return <ReplayPanel replays={trace.replays} />;
  }
  // Only-v2 session (no v1 filmstrip docs) with the probe still in flight: light note.
  if (probe === "loading") {
    return (
      <section className="timelinePanel full">
        <header>
          <h3>세션 리플레이</h3>
          <span>불러오는 중…</span>
        </header>
      </section>
    );
  }
  return <ReplayPanel replays={trace.replays} />;
}

function ReplayPanel({ replays }: { replays: ReplayDocument[] }) {
  const [selectedReplay, setSelectedReplay] = useState(0);
  const replay = replays[selectedReplay] ?? replays[0];
  const frames = useMemo(() => replayFrames(replay), [replay]);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [eventFilter, setEventFilter] = useState<ReplayEventFilter>("all");
  const [copiedFrameLink, setCopiedFrameLink] = useState(false);
  const frame = frames[currentFrame];
  const currentSeconds = frameSeconds(frame);
  const totalSeconds = frameSeconds(frames[frames.length - 1]);
  const viewport = frames.find(item => item.width && item.height);
  const width = viewport?.width ?? 1440;
  const height = viewport?.height ?? 900;
  const pointerFrames = frames.slice(0, currentFrame + 1).filter(hasPoint).slice(-6);
  const markers = replayMarkers(frames, totalSeconds);
  const visibleFrames = filteredReplayFrames(frames, eventFilter);
  const counts = replayEventCounts(frames);
  const networkFrames = networkReplayFrames(frames);
  const seekFrame = (index: number) => {
    setIsPlaying(false);
    setCurrentFrame(boundedFrameIndex(index, frames.length));
  };
  const selectReplay = (index: number) => {
    setSelectedReplay(boundedReplayIndex(index, replays.length));
  };
  const copyFrameLink = async () => {
    if (!replay) {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("traceId", replay.traceId);
    url.searchParams.set("platform", replay.platform);
    url.searchParams.set("replay", String(selectedReplay));
    url.searchParams.set("frame", String(currentFrame));
    if (frame?.html || frame?.image) {
      url.searchParams.set("screens", "1");
    }
    await navigator.clipboard?.writeText(url.toString());
    setCopiedFrameLink(true);
    window.setTimeout(() => setCopiedFrameLink(false), 1200);
  };
  const selectEventFilter = (nextFilter: ReplayEventFilter) => {
    setEventFilter(nextFilter);
    seekFrame(filteredReplayFrames(frames, nextFilter)[0]?.index ?? 0);
  };

  useEffect(() => {
    setSelectedReplay(boundedReplayIndex(initialReplayIndex(), replays.length));
    setIsPlaying(false);
  }, [replays]);

  useEffect(() => {
    const linkedFrame = initialReplayFrame();
    setCurrentFrame(linkedFrame === null ? issueFrameIndex(frames) : boundedFrameIndex(linkedFrame, frames.length));
    setIsPlaying(false);
    setEventFilter("all");
  }, [frames, selectedReplay]);

  useEffect(() => {
    if (!replay || typeof window === "undefined") {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("replay", String(selectedReplay));
    url.searchParams.set("frame", String(currentFrame));
    window.history.replaceState(null, "", url);
  }, [currentFrame, replay, selectedReplay]);

  useEffect(() => {
    if (!isPlaying || frames.length < 2) {
      return;
    }
    if (currentFrame >= frames.length - 1) {
      setIsPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setCurrentFrame(value => value + 1), frameDelay(frames[currentFrame], frames[currentFrame + 1], playbackSpeed));
    return () => window.clearTimeout(timer);
  }, [currentFrame, frames, isPlaying, playbackSpeed]);

  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc || !replay?.mutations?.length || !frame) {
      return;
    }
    for (const mutation of replay.mutations.filter(item => seconds(item.at) <= seconds(frame.at))) {
      applyMutation(doc, mutation);
    }
    applyReplayScroll(doc, frame);
  }, [frame, replay]);

  return (
    <section className="timelinePanel full">
      <header>
        <h3>세션 리플레이</h3>
        <span>
          {replay ? `${replayLabel(replay)}${replay.mutations?.length ? ` · 변경 ${replay.mutations.length}건` : ""}` : "없음"}
        </span>
      </header>
      {replay ? (
        <div className="replayPlayer">
          {replays.length > 1 ? (
            <div className="replayTabs" aria-label="리플레이 캡처">
              {replays.map((item, index) => (
                <button
                  className={index === selectedReplay ? "active" : ""}
                  key={`${item.startedAt}-${index}`}
                  onClick={() => selectReplay(index)}
                  type="button"
                >
                  {replayLabel(item)} {new Date(item.endedAt ?? item.startedAt).toLocaleTimeString()}
                </button>
              ))}
            </div>
          ) : null}
          <div className="replaySummary" aria-label="리플레이 요약">
            <span><strong>{formatReplayClock(totalSeconds)}</strong>재생 시간</span>
            <span><strong>{counts.actions}</strong>액션</span>
            <span><strong>{counts.inputs}</strong>입력</span>
            <span><strong>{counts.scroll}</strong>스크롤</span>
            <span><strong>{counts.performance}</strong>성능</span>
            <span><strong>{counts.screens}</strong>화면</span>
            <span><strong>{counts.network}</strong>네트워크</span>
            <span><strong>{counts.errors}</strong>에러</span>
            <span><strong>{frames.length}</strong>프레임</span>
          </div>
          {replayScreenshotMissing(replay) ? <p className="sourceNotice local-fallback">모바일 리플레이에 스크린샷 제공자가 설정되지 않아 이벤트만 표시합니다.</p> : null}
          <div className={`replayStage ${isMobileReplay(replay) ? "mobile" : ""}`} aria-label="세션 리플레이 플레이어">
            <div className="replayChrome">
              <span />
              <span />
              <span />
            </div>
            <div className="replayViewport" />
            {!frame?.html && !frame?.image ? <ReplayScene replay={replay} frame={frame} width={width} height={height} /> : null}
            {frame?.html ? (
              <iframe
                className="replayIframe"
                key={`${replay.traceId}-${frame.at}`}
                onLoad={() => {
                  const doc = iframeRef.current?.contentDocument;
                  if (!doc || !replay?.mutations || !frame) {
                    return;
                  }
                  for (const mutation of replay.mutations.filter(item => seconds(item.at) <= seconds(frame.at))) {
                    applyMutation(doc, mutation);
                  }
                  applyReplayScroll(doc, frame);
                }}
                ref={iframeRef}
                sandbox=""
                srcDoc={baseHtml(replay, frame)}
                style={replayFrameStyle(width, height)}
                title="캡처된 프론트엔드 화면"
              />
            ) : null}
            {frame?.image ? <img alt="캡처된 모바일 화면" className="replayImage" src={frame.image} /> : null}
            {frame?.kind === "error" ? <div className="errorFlash" /> : null}
            {pointerFrames.map((item, index) => (
              <span
                className={`clickDot ${index === pointerFrames.length - 1 ? "active" : ""}`}
                key={`${item.at}-${item.x}-${item.y}-${index}`}
                style={pointStyle(item, width, height, isMobileReplay(replay))}
              >
                {index === pointerFrames.length - 1 ? item.kind : ""}
              </span>
            ))}
            <div className="replayEvent">
              <strong>{frame ? `${frame.at} ${frame.kind}` : "비어 있음"}</strong>
              <span>{frame?.text ?? "리플레이 이벤트 없음"}</span>
            </div>
          </div>
          <div className="replayControls">
            <button className="playButton" onClick={() => setIsPlaying(value => !value)} type="button">
              {isPlaying ? "일시정지" : "재생"}
            </button>
            <button className="playButton" onClick={() => void copyFrameLink()} type="button">
              {copiedFrameLink ? "복사됨" : "프레임 복사"}
            </button>
            <select aria-label="재생 속도" className="speedSelect" onChange={event => setPlaybackSpeed(Number(event.currentTarget.value))} value={playbackSpeed}>
              <option value={1}>1x</option>
              <option value={2}>2x</option>
              <option value={4}>4x</option>
            </select>
            <div className="replayScrubber">
              <input
                aria-label="리플레이 프레임"
                max={Math.max(frames.length - 1, 0)}
                min={0}
                onChange={event => seekFrame(Number(event.currentTarget.value))}
                type="range"
                value={currentFrame}
              />
              <div className="replayMarkers" aria-label="리플레이 이벤트 마커">
                {markers.map(marker => (
                  <button
                    aria-label={`${marker.kind} · ${marker.at}`}
                    className={`replayMarker ${marker.kind}`}
                    key={`${marker.index}-${marker.kind}-${marker.at}`}
                    onClick={() => seekFrame(marker.index)}
                    style={{ left: `${marker.left}%` }}
                    title={`${marker.kind} ${marker.at}`}
                    type="button"
                  />
                ))}
              </div>
            </div>
            <span className="replayTime">
              {formatReplayClock(currentSeconds)} / {formatReplayClock(totalSeconds)} · {currentFrame + 1}/{frames.length}
            </span>
          </div>
          <div className="replayFilmstrip" aria-label="리플레이 필름스트립">
            {frames.map((item, index) => (
              <button
                className={`filmFrame ${item.image ? "" : "noVisual"} ${index === currentFrame ? "active" : ""} ${item.kind}`}
                key={`${item.at}-${item.kind}-${index}`}
                onClick={() => seekFrame(index)}
                title={frameLine(item)}
                type="button"
              >
                {item.image ? <img alt="" src={item.image} /> : <span>{item.kind}</span>}
                <em>{item.at}</em>
              </button>
            ))}
          </div>
          <div className="replayFrameToolbar" aria-label="리플레이 이벤트 필터">
            <button className={eventFilter === "all" ? "active" : ""} onClick={() => selectEventFilter("all")} type="button">전체 {frames.length}</button>
            <button className={eventFilter === "screens" ? "active" : ""} onClick={() => selectEventFilter("screens")} type="button">화면 {counts.screens}</button>
            <button className={eventFilter === "actions" ? "active" : ""} onClick={() => selectEventFilter("actions")} type="button">액션 {counts.actions}</button>
            <button className={eventFilter === "inputs" ? "active" : ""} onClick={() => selectEventFilter("inputs")} type="button">입력 {counts.inputs}</button>
            <button className={eventFilter === "scroll" ? "active" : ""} onClick={() => selectEventFilter("scroll")} type="button">스크롤 {counts.scroll}</button>
            <button className={eventFilter === "performance" ? "active" : ""} onClick={() => selectEventFilter("performance")} type="button">성능 {counts.performance}</button>
            <button className={eventFilter === "network" ? "active" : ""} onClick={() => selectEventFilter("network")} type="button">네트워크 {counts.network}</button>
            <button className={eventFilter === "errors" ? "active" : ""} onClick={() => selectEventFilter("errors")} type="button">에러 {counts.errors}</button>
          </div>
          {networkFrames.length ? (
            <div className="networkList" aria-label="리플레이 네트워크 요청">
              {networkFrames.map(({ frame: item, index, request }) => (
                <button
                  className={`networkRow ${request.failed ? "failed" : ""} ${index === currentFrame ? "active" : ""}`}
                  key={`${frameLine(item)}-${index}`}
                  onClick={() => seekFrame(index)}
                  type="button"
                >
                  <strong>{request.method}</strong>
                  <span>{request.url}</span>
                  <em>{request.status ?? "실패"} · {request.durationMs ?? "?"}ms</em>
                </button>
              ))}
            </div>
          ) : null}
          <div className="replayFrames">
            {visibleFrames.map(({ frame: item, index }) => (
              <button
                className={`eventLine ${index === currentFrame ? "active" : ""}`}
                key={`${frameLine(item)}-${index}`}
                onClick={() => seekFrame(index)}
                type="button"
              >
                {frameLine(item)}
              </button>
            ))}
            {!visibleFrames.length ? <div className="emptyLine">이 필터에 해당하는 리플레이 이벤트가 없습니다.</div> : null}
          </div>
          {replay.mutations?.length ? <EventList events={replay.mutations.map(formatMutation)} readOnly selected="" onSelect={() => {}} /> : null}
        </div>
      ) : (
        <p className="summary">이 트레이스에는 리플레이 문서가 없습니다.</p>
      )}
    </section>
  );
}

function ReplayScene({ replay, frame, width, height }: { replay: ReplayDocument; frame?: ReplayFrame; width: number; height: number }) {
  const route = sceneRoute(replay, frame);
  const action = sceneAction(frame);
  const hasError = frame?.kind === "error" || frame?.text.toLowerCase().includes("error");

  return (
    <div className="replayScene">
      <div className="sceneBar">
        <span>{route}</span>
        <span>{replay.platform}</span>
      </div>
      <div className="sceneBody">
        <div className="sceneCard">
          <strong>{hasError ? "에러 화면" : "캡처된 화면"}</strong>
          <span>{frame?.text ?? "리플레이 이벤트 대기 중"}</span>
        </div>
        {action ? (
          <span className={`sceneAction ${hasError ? "error" : ""}`} style={pointStyle(action, width, height, isMobileReplay(replay))}>
            {action.label}
          </span>
        ) : null}
      </div>
      <div className="sceneFooter">
        <span>{frame?.at ?? "0.000s"}</span>
        <span>{frame?.kind ?? "비어 있음"}</span>
      </div>
    </div>
  );
}

function isMobileReplay(replay: ReplayDocument): boolean {
  return replay.platform === "react-native" || replay.platform === "flutter";
}

function replayScreenshotMissing(replay: ReplayDocument): boolean {
  return isMobileReplay(replay) && replay.metadata?.["replay.screenshot"] === "missing";
}

function formatMutation(mutation: ReplayMutation): string {
  if (mutation.type === "attributes") {
    return `${mutation.at} mutation ${mutation.target} attr=${mutation.attributeName ?? "unknown"} value=${mutation.value ?? ""}`;
  }
  return `${mutation.at} mutation ${mutation.target} added=${mutation.addedHtml?.length ?? 0} removed=${mutation.removedCount ?? 0}`;
}

function applyMutation(doc: Document, mutation: ReplayMutation): void {
  if (!mutation.targetPath) {
    return;
  }
  const target = doc.querySelector(mutation.targetPath);
  if (!target) {
    return;
  }
  if (mutation.type === "attributes") {
    const name = mutation.attributeName;
    if (!name) {
      return;
    }
    if (mutation.value === null || mutation.value === undefined) {
      target.removeAttribute(name);
    } else {
      target.setAttribute(name, mutation.value);
    }
    return;
  }
  for (let index = 0; index < (mutation.removedCount ?? 0); index += 1) {
    target.lastChild?.remove();
  }
  for (const html of mutation.addedHtml ?? []) {
    target.insertAdjacentHTML("beforeend", html);
  }
}

function applyReplayScroll(doc: Document, frame: ReplayFrame): void {
  const match = /scroll x=(\d+) y=(\d+)/.exec(frame.text);
  if (!match) {
    return;
  }
  const target = doc.scrollingElement ?? doc.documentElement;
  target.scrollLeft = Number(match[1]);
  target.scrollTop = Number(match[2]);
}

function baseHtml(replay: ReplayDocument, fallback: ReplayFrame): string {
  return [...(replay.frames ?? [])].reverse().find(frame => frame.html && seconds(frame.at) <= seconds(fallback.at))?.html ?? fallback.html ?? "";
}

function replayFrameStyle(width: number, height: number): CSSProperties {
  const scale = Math.min(1, 820 / Math.max(width, 1));
  return {
    "--replay-width": `${width}px`,
    "--replay-height": `${height}px`,
    "--replay-scale": String(scale)
  } as CSSProperties;
}

function seconds(value: string): number {
  return Number.parseFloat(value.replace("s", "")) || 0;
}

function frameSeconds(frame?: ReplayFrame): number {
  return frame?.seconds ?? (frame ? seconds(frame.at) : 0);
}

function frameDelay(current?: ReplayFrame, next?: ReplayFrame, speed = 1): number {
  const delta = frameSeconds(next) - frameSeconds(current);
  return Math.min(1200, Math.max(180, (delta * 1000) / speed));
}

function formatReplayClock(value: number): string {
  return `${value.toFixed(1)}s`;
}

function replayMarkers(frames: ReplayFrame[], totalSeconds: number): Array<{ at: string; index: number; kind: string; left: number }> {
  return frames
    .map((frame, index) => ({ frame, index }))
    .filter(({ frame }) => frame.kind === "click" || frame.kind === "gesture" || frame.kind === "input" || frame.kind === "scroll" || frame.kind === "network" || frame.kind === "error")
    .map(({ frame, index }) => ({
      at: frame.at,
      index,
      kind: frame.kind,
      left: totalSeconds > 0 ? Math.max(0, Math.min(100, (frameSeconds(frame) / totalSeconds) * 100)) : 0
    }));
}

function filteredReplayFrames(frames: ReplayFrame[], filter: ReplayEventFilter): Array<{ frame: ReplayFrame; index: number }> {
  return frames
    .map((frame, index) => ({ frame, index }))
    .filter(({ frame }) => matchesReplayEventFilter(frame, filter));
}

function replayEventCounts(frames: ReplayFrame[]): Record<Exclude<ReplayEventFilter, "all">, number> {
  return {
    screens: filteredReplayFrames(frames, "screens").length,
    actions: filteredReplayFrames(frames, "actions").length,
    inputs: filteredReplayFrames(frames, "inputs").length,
    scroll: filteredReplayFrames(frames, "scroll").length,
    performance: filteredReplayFrames(frames, "performance").length,
    network: filteredReplayFrames(frames, "network").length,
    errors: filteredReplayFrames(frames, "errors").length
  };
}

function networkReplayFrames(frames: ReplayFrame[]): Array<{ frame: ReplayFrame; index: number; request: NetworkRequest }> {
  return frames
    .map((frame, index) => ({ frame, index, request: parseNetworkRequest(frame) }))
    .filter((item): item is { frame: ReplayFrame; index: number; request: NetworkRequest } => Boolean(item.request));
}

function issueFrameIndex(frames: ReplayFrame[]): number {
  const errorIndex = frames.findIndex(frame => frame.kind === "error" || /\berror\b|status=5\d\d|failed/.test(frame.text));
  return errorIndex >= 0 ? errorIndex : 0;
}

function boundedFrameIndex(index: number, frameCount: number): number {
  return Math.max(0, Math.min(index, Math.max(frameCount - 1, 0)));
}

function boundedReplayIndex(index: number, replayCount: number): number {
  return Math.max(0, Math.min(index, Math.max(replayCount - 1, 0)));
}

type NetworkRequest = {
  method: string;
  url: string;
  status?: string;
  durationMs?: string;
  failed: boolean;
};

function parseNetworkRequest(frame: ReplayFrame): NetworkRequest | null {
  if (frame.kind !== "network") {
    return null;
  }
  const match = /^(?:(?:fetch|xhr)\s+)?(\S+)\s+(\S+)/.exec(frame.text);
  if (!match) {
    return { method: "NET", url: frame.text, failed: frame.text.includes("failed") || frame.text.includes("error") };
  }
  const status = /status=(\d+)/.exec(frame.text)?.[1];
  return {
    method: match[1] ?? "NET",
    url: match[2] ?? frame.text,
    status,
    durationMs: /durationMs=(\d+)/.exec(frame.text)?.[1],
    failed: frame.text.includes("failed") || frame.text.includes("error") || Boolean(status && Number(status) >= 500)
  };
}

function matchesReplayEventFilter(frame: ReplayFrame, filter: ReplayEventFilter): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "actions") {
    return (frame.kind === "click" || frame.kind === "gesture" || frame.kind === "input" || frame.kind === "scroll") && !isPerformanceFrame(frame);
  }
  if (filter === "inputs") {
    return frame.kind === "input";
  }
  if (filter === "scroll") {
    return frame.kind === "scroll";
  }
  if (filter === "performance") {
    return isPerformanceFrame(frame);
  }
  if (filter === "screens") {
    return Boolean(frame.html || frame.image);
  }
  if (filter === "network") {
    return frame.kind === "network";
  }
  return frame.kind === "error";
}

function isPerformanceFrame(frame: ReplayFrame): boolean {
  return /\bperformance\b|long_task|durationMs=\d+/.test(frame.text) && !/\bnetwork\b|status=\d+/.test(frame.text);
}

function parseReplayFrame(line: string): ReplayFrame {
  const match = /^(\d+(?:\.\d+)?)s\s+(\S+)\s+(.*)$/.exec(line);
  const seconds = Number(match?.[1] ?? 0);
  const kind = match?.[2] ?? "event";
  const text = match?.[3] ?? line;
  const click = /x=(\d+)\s+y=(\d+)/.exec(text);
  const viewport = /viewport\s+(\d+)x(\d+)/.exec(text);

  return {
    line,
    at: `${seconds.toFixed(3)}s`,
    seconds,
    kind,
    text,
    x: click ? Number(click[1]) : undefined,
    y: click ? Number(click[2]) : undefined,
    width: viewport ? Number(viewport[1]) : undefined,
    height: viewport ? Number(viewport[2]) : undefined
  };
}

function replayFrames(replay?: ReplayDocument): ReplayFrame[] {
  if (!replay) {
    return [];
  }
  return replay.frames?.length ? replay.frames.map(normalizeReplayFrame) : replayEventLines(replay).map(parseReplayFrame);
}

function normalizeReplayFrame(frame: ReplayFrame): ReplayFrame {
  return {
    ...frame,
    seconds: frame.seconds ?? seconds(frame.at),
    line: frame.line ?? `${frame.at} ${frame.kind} ${frame.text}`
  };
}

function frameLine(frame: ReplayFrame): string {
  return frame.line ?? `${frame.at} ${frame.kind} ${frame.text}`;
}

function sceneRoute(replay: ReplayDocument, frame?: ReplayFrame): string {
  const source = [frame?.text, ...replayEventLines(replay)].filter(Boolean).join(" ");
  return /(?:loaded|viewport)\s+\d*x?\d*\s*(\/[^\s]*)/.exec(source)?.[1] ?? replay.sessionId ?? replay.traceId;
}

function replayEventLines(replay: ReplayDocument): string[] {
  return replay.events?.map(timelineLine).filter(Boolean) ?? [];
}

function sceneAction(frame?: ReplayFrame): (ReplayFrame & { x: number; y: number; label: string }) | undefined {
  if (!frame || !hasPoint(frame)) {
    return undefined;
  }
  return {
    ...frame,
    label: /text=([^\s]+)/.exec(frame.text)?.[1] ?? frame.kind
  };
}

function hasPoint(frame: ReplayFrame): frame is ReplayFrame & { x: number; y: number } {
  return typeof frame.x === "number" && typeof frame.y === "number";
}

function pointStyle(frame: ReplayFrame & { x: number; y: number }, width: number, height: number, mobile = false): CSSProperties {
  const x = Math.max(0, Math.min(1, frame.x / width));
  const y = Math.max(0, Math.min(1, frame.y / height));
  if (mobile) {
    return {
      left: `calc(50% - min(360px, calc(100% - 36px)) / 2 + ${x} * min(360px, calc(100% - 36px)))`,
      top: `calc(48px + ${y} * (100% - 66px))`
    };
  }
  return {
    left: `calc(18px + ${x} * (100% - 36px))`,
    top: `calc(48px + ${y} * (100% - 66px))`
  };
}

type EventKind = "navigation" | "view" | "fetch" | "error" | "info";

const EVENT_KIND_LABEL: Record<EventKind, string> = {
  navigation: "이동",
  view: "화면",
  fetch: "요청",
  error: "에러",
  info: "정보"
};

const REDUNDANT_EVENT_CATEGORIES = new Set(["navigation", "route", "fetch", "network", "request", "xhr", "error"]);

function eventLineKind(category: string, line: string): EventKind {
  if (category === "navigation" || category === "route") {
    return "navigation";
  }
  if (category === "view") {
    return "view";
  }
  if (category === "fetch" || category === "network" || category === "request" || category === "xhr") {
    return "fetch";
  }
  if (category === "error" || /\berror\b|onerror|status=5\d\d|failed|fatal|exception/i.test(line)) {
    return "error";
  }
  return "info";
}

// Timeline lines are "<time>s <category> <level> <message>" (see docs/log-format.md).
// The chip conveys the kind, so we drop a redundant category word and the level token.
function parseEventLine(line: string): { time: string; kind: EventKind; body: string } {
  // 통합 타임라인 줄은 "<iso> <source> <time>s ..." 형태라 ISO/소스 접두를 벗겨 동일 구조로 렌더한다.
  let stripped = line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/, "");
  let source = "";
  const sourceMatch = stripped.match(/^([a-z][\w:-]*)\s+(?=\d+(?:\.\d+)?s\s)/i);
  if (sourceMatch) {
    source = sourceMatch[1] ?? "";
    stripped = stripped.slice(sourceMatch[0].length);
  }
  const timeMatch = stripped.match(/^(\d+(?:\.\d+)?s)\s+([\s\S]*)$/);
  const time = timeMatch?.[1] ?? "";
  const rest = timeMatch?.[2] ?? stripped;
  const tokens = rest.split(/\s+/);
  const category = (tokens[0] ?? "").toLowerCase();
  const hasLevel = /^(info|warn|warning|error|debug|log)$/i.test(tokens[1] ?? "");
  let bodyTokens = tokens.slice(hasLevel ? 2 : 1);
  if (!REDUNDANT_EVENT_CATEGORIES.has(category) && tokens[0]) {
    bodyTokens = [tokens[0], ...bodyTokens];
  }
  const body = [source, bodyTokens.join(" ").trim() || rest].filter(Boolean).join(" · ");
  return { time, kind: eventLineKind(category, line), body };
}

function EventList({
  events,
  eventDetails,
  selected,
  onSelect,
  readOnly,
  structured
}: {
  events: string[];
  eventDetails?: Array<TimelineEvent | undefined>;
  selected: string;
  onSelect: (line: string) => void;
  readOnly?: boolean;
  structured?: boolean;
}) {
  // S3 documents are untrusted at render time — a malformed timeline entry
  // (object instead of line string) must degrade to JSON text, not crash the page.
  const lines = events.map(event => (typeof event === "string" ? event : JSON.stringify(event)));
  const active = selected || lines[0] || "타임라인 항목 없음";

  return (
    <div className="eventList">
      <div className="eventRows">
        {lines.map((event, index) => {
          const parsed = structured ? parseEventLine(event) : null;
          const detail = eventDetails?.[index];
          return (
            <div className="eventItem" key={`${event}-${index}`}>
              <button
                className={`eventLine ${parsed ? "structured" : ""} ${event === active ? "active" : ""}`}
                onClick={() => {
                  if (!readOnly) {
                    onSelect(event);
                  }
                }}
                type="button"
              >
                {parsed ? (
                  <>
                    {parsed.time ? <span className="eventTime">{parsed.time}</span> : null}
                    <span className={`eventKind ${parsed.kind}`}>{EVENT_KIND_LABEL[parsed.kind]}</span>
                    {typeof detail?.durationMs === "number" ? <span className="eventKind info">{detail.durationMs}ms</span> : null}
                    {detail?.slow ? <span className="eventKind slow">SLOW</span> : null}
                    <span className="eventBody">{parsed.body}</span>
                  </>
                ) : (
                  event
                )}
              </button>
              {detail?.data ? (
                <details className="eventData">
                  <summary>데이터 보기</summary>
                  <pre>{JSON.stringify(detail.data, null, 2)}</pre>
                </details>
              ) : null}
            </div>
          );
        })}
        {events.length === 0 ? <span className="eventLine emptyLine">타임라인 항목 없음</span> : null}
      </div>
    </div>
  );
}
