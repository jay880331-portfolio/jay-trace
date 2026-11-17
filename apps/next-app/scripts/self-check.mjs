import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveMarkers } from "../app/lib/replayMarkers.mjs";
import {
  eventAttrs,
  eventOffsetSeconds,
  hostContext,
  spanDepth,
  stackFrames,
  waterfallBarStyle,
  waterfallBars,
  waterfallTicks,
  waterfallTotalSeconds
} from "../app/lib/waterfall.mjs";
import {
  HISTOGRAM_SIZE,
  clampStatsHours,
  formatLatency,
  formatRank,
  histogramPercentile,
  histogramRank,
  histogramTotal,
  mergeHistograms,
  toHistogram
} from "../app/lib/percentile.mjs";
import { mergeWireframeFrames, frameAtTime } from "../app/lib/wireframeFrames.mjs";
import { replayUrl } from "../app/lib/replayUrl.mjs";
import { isReplaySegmentKey } from "../app/lib/replaySegments.mjs";
import { pathHasSegment } from "../app/lib/pathSegment.mjs";
import {
  deriveIssueStatus,
  groupIssues,
  isIssueFingerprint,
  issueFingerprint,
  normalizeIssueMessage
} from "../app/lib/issues.mjs";

const { issueDays } = await import(new URL("../app/api/lib/issue-days.mjs", import.meta.url));

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const consoleCss = readFileSync(new URL("../app/console.css", import.meta.url), "utf8");
const replayPlayer = readFileSync(new URL("../app/components/ReplayPlayer.tsx", import.meta.url), "utf8");
const tracesRoute = readFileSync(new URL("../app/api/traces/route.ts", import.meta.url), "utf8");
const issuesRoute = readFileSync(new URL("../app/api/issues/route.ts", import.meta.url), "utf8");
const issuePatchRoute = readFileSync(new URL("../app/api/issues/[fingerprint]/route.ts", import.meta.url), "utf8");
const traceLib = readFileSync(new URL("../app/api/lib/traces.ts", import.meta.url), "utf8");
const documentsLib = readFileSync(new URL("../app/api/lib/documents.ts", import.meta.url), "utf8");
const issueStateLib = readFileSync(new URL("../app/api/lib/issue-state.ts", import.meta.url), "utf8");
const replayRoute = readFileSync(new URL("../app/api/replay/route.ts", import.meta.url), "utf8");
const statsRoute = readFileSync(new URL("../app/api/stats/route.ts", import.meta.url), "utf8");
const wireframePlayer = readFileSync(new URL("../app/components/WireframePlayer.tsx", import.meta.url), "utf8");
const nextConfig = readFileSync(new URL("../next.config.mjs", import.meta.url), "utf8");
const tsConfig = readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8");
const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
const rootPackageJson = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
const devConsole = readFileSync(new URL("./dev-console.mjs", import.meta.url), "utf8");
const sampleWebSmoke = readFileSync(new URL("./sample-web-web-smoke.mjs", import.meta.url), "utf8");
const mobileS3Smoke = readFileSync(new URL("./mobile-s3-smoke.mjs", import.meta.url), "utf8");
const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
const logFormat = readFileSync(new URL("../../../docs/log-format.md", import.meta.url), "utf8");
const mobileQa = readFileSync(new URL("../../../docs/mobile-replay-qa.md", import.meta.url), "utf8");

function issueTrace({
  traceId = "trace-1",
  lastSeen = "2026-07-16T01:00:00.000Z",
  status = "error",
  release = "1.0.0",
  environment = "production",
  message = "order 123456 failed",
  stack = "Error: order failed\n    at dependency (/app/node_modules/pkg/index.js:1:2)\n    at pay (/app/pay.ts:8:2)",
  route = "/checkout",
  sessionId = "session-1",
  userId = "user-1"
} = {}) {
  return {
    traceId,
    sessionId,
    lastSeen,
    status,
    services: ["checkout"],
    route,
    summary: message,
    back: {
      schema: "jaytrace.timeline.v1",
      service: "checkout",
      side: "back",
      traceId,
      sessionId,
      startedAt: lastSeen,
      summary: message,
      timeline: [],
      context: { environment, release, "user.id": userId },
      error: { name: "PaymentError", message, stack }
    },
    replays: [{ platform: "web", sessionId, metadata: { environment, release } }]
  };
}

const releaseA = issueTrace({ release: "1.0.0", message: "order 123456 failed" });
const releaseB = issueTrace({ release: "1.1.0", message: "order 987654 failed" });
assert(issueFingerprint(releaseA) === issueFingerprint(releaseB), "release and long ids do not split issues");
assert(issueFingerprint(issueTrace({ message: "request 123e4567-e89b-12d3-a456-426614174000 failed at 2026-07-16T01:02:03.000Z" })) === issueFingerprint(issueTrace({ message: "request 987e6543-e21b-12d3-a456-426614174999 failed at 2026-07-17T04:05:06Z" })), "uuid and timestamp do not split issues");
assert(issueFingerprint(releaseA) !== issueFingerprint(issueTrace({ stack: "at pay (/app/refund.ts:9:2)" })), "in-app frame splits issues");
assert(issueFingerprint(releaseA) !== issueFingerprint(issueTrace({ environment: "staging" })), "environment partitions issues");
assert(issueFingerprint(releaseA) === issueFingerprint(issueTrace({ stack: "at pay (/app/pay.ts:99:42)" })), "stack line and column do not split issues");
assert(issueFingerprint(issueTrace({ stack: "pay@/app/pay.ts:8:2" })) === issueFingerprint(issueTrace({ stack: "pay@/app/pay.ts:99:42" })), "non-V8 stack frame line and column do not split issues");
assert(issueFingerprint(issueTrace({ stack: "#0      pay (package:app/pay.dart:8:2)" })) === issueFingerprint(issueTrace({ stack: "#0      pay (package:app/pay.dart:99:42)" })), "Flutter stack line and column do not split issues");
assert(issueFingerprint(issueTrace({ stack: 'File "/app/pay.py", line 8, in pay' })) === issueFingerprint(issueTrace({ stack: 'File "/app/pay.py", line 99, in pay' })), "Python stack line numbers do not split issues");
assert(issueFingerprint(issueTrace({ stack: "/app/models/order.rb:8:in `pay'" })) === issueFingerprint(issueTrace({ stack: "/app/models/order.rb:99:in `pay'" })), "single-line Ruby frames normalize line numbers");
assert(issueFingerprint(issueTrace({ stack: "/app/models/order.rb:8:in `pay'" })) !== issueFingerprint(issueTrace({ stack: "/app/models/refund.rb:8:in `pay'" })), "single-line Ruby frames retain file identity");
assert(issueFingerprint(issueTrace({ stack: "native!pay (/app/native.cc:8:2)" })) === issueFingerprint(issueTrace({ stack: "native!pay (/app/native.cc:99:42)" })), "single-line native path frames normalize line and column");
const routeFallback = issueFingerprint(issueTrace({ stack: null }));
assert(issueFingerprint(issueTrace({ stack: "PaymentError\npay (/app/pay.dart:8:2)" })) !== routeFallback, "credible raw non-header frames beat route fallback");
assert(routeFallback === issueFingerprint(issueTrace({ stack: "PaymentError: order failed" })), "header-only stack uses route fallback");
assert(routeFallback === issueFingerprint(issueTrace({ stack: "PaymentError: order failed\n    at dependency (/app/node_modules/pkg/index.js:1:2)" })), "dependency-only stack uses route fallback");
assert(routeFallback !== issueFingerprint(issueTrace({ stack: null, route: "/refund" })), "route fallback partitions frameless issues");
assert(isIssueFingerprint(issueFingerprint(releaseA)), "fingerprint is lowercase sha-256");
assert(normalizeIssueMessage("request 018f8d8c-5d5a-7cc0-9b23-7f2c8b551122 failed") === "request <uuid> failed", "UUID v7 is normalized");
assert(!isIssueFingerprint("A".repeat(64)), "fingerprint validation rejects uppercase hex");
assert(normalizeIssueMessage("  status 500   order 123456  ") === "status 500 order <id>", "message normalization preserves short meaningful numbers");

assert(issueStateLib.includes('".state", "issues"'), "local issue state is isolated");
assert(issueStateLib.includes('"_state/issues/"'), "S3 issue state is isolated");
assert(issueStateLib.includes("randomUUID()") && issueStateLib.includes("rename(tempPath"), "local state write uses request-unique atomic temp files");
assert(issueStateLib.includes("PutObjectCommand"), "S3 issue state is writable");
assert(issueStateLib.includes("isIssueFingerprint"), "state storage validates fingerprints");
assert(issueStateLib.includes("Date.parse(state.updatedAt) > Date.parse(existing.updatedAt)"), "state merge compares timestamp values");
assert(existsSync(new URL("../app/lib/issues.d.mts", import.meta.url)) && !issueStateLib.includes("@ts-expect-error"), "issues.mjs uses its ESM declaration without a type suppression");
await checkIssueStatePersistence();
await checkIssuePatchBaseline();
await checkIssueCache();
await checkRawDocumentCap();
await checkRouteLatencyPercentiles();

const resolved = { status: "resolved", resolvedAt: "2026-07-16T02:00:00.000Z", lastOccurrenceAtResolution: "2026-07-16T01:00:00.000Z" };
assert(deriveIssueStatus(undefined, "2026-07-16T01:00:00.000Z") === "new", "missing state is new");
assert(deriveIssueStatus(resolved, "2026-07-16T01:00:00.000Z") === "resolved", "resolved remains resolved");
assert(deriveIssueStatus(resolved, "2026-07-16T03:00:00.000Z") === "regressed", "new occurrence regresses");
assert(deriveIssueStatus({ ...resolved, lastOccurrenceAtResolution: "2026-07-16T01:00:00+02:00" }, "2026-07-16T00:30:00Z") === "regressed", "regression compares timestamp epochs across offsets");

const fingerprint = issueFingerprint(releaseA);
const groupedIssues = groupIssues([
  releaseA,
  issueTrace({ traceId: "trace-2", sessionId: "session-2", userId: "user-2", release: "1.1.0", message: "order 987654 failed", lastSeen: "2026-07-16T03:00:00.000Z" }),
  issueTrace({ traceId: "trace-ok", status: "ok" })
], {
  [fingerprint]: { ...resolved, fingerprint }
});
assert(groupedIssues.length === 1, "issue grouping keeps errors only");
assert(groupedIssues[0].status === "regressed" && groupedIssues[0].count === 2, "issue grouping derives regression and count");
assert(groupedIssues[0].traceId === "trace-2" && groupedIssues[0].lastSeen === "2026-07-16T03:00:00.000Z", "issue grouping selects newest representative");
assert(groupedIssues[0].releases.join(",") === "1.0.0,1.1.0" && groupedIssues[0].userCount === 2, "issue grouping accumulates release and user dimensions");
const fatalReplayIssue = groupIssues([{
  traceId: "fatal-replay",
  lastSeen: "2026-07-16T04:00:00.000Z",
  status: "error",
  services: ["replay:web"],
  summary: "checkout crashed",
  replays: [{ platform: "web", events: ["0.100s error checkout crashed fatal=true"] }]
}])[0];
assert(fatalReplayIssue.cause === "web 치명적 리플레이", "fatal replay issue keeps its platform cause");

assert(traceLib.includes("export async function loadTraceRows"), "shared trace loader exported");
assert(traceLib.includes("export function traceSessionIds"), "shared session ids exported");
assert(traceLib.includes("export function traceUserKey"), "shared user key exported");
assert(traceLib.includes("export function groupUsers"), "shared user grouping exported");
assert(tracesRoute.includes('import { loadTraceRows } from "../lib/traces"'), "trace route uses shared loader");
assert(!tracesRoute.includes("function groupTraces("), "trace route no longer owns grouping");
assert(traceLib.includes("loadTraceRows(days: number, limit: number, traceId?: string | null)"), "shared trace loader accepts an optional trace id");
assert(traceLib.includes("collectRawDocuments({ days: clampedDays, limit, traceId })"), "shared trace loader forwards the trace id");
assert(tracesRoute.includes("s3ReadLimit(limit, Boolean(traceId || sessionId || platform || screensOnly)),\n    traceId"), "trace route forwards the trace id to the shared loader");
assert(tracesRoute.includes("users: groupUsers(sessions)"), "trace route exposes user-grouped sessions");
assert(issuesRoute.includes("loadTraceRows(clampedDays, 10000)"), "issue API supports 10,000 one-document traces within the raw document cap");
assert(issuesRoute.includes("readIssueStates(fingerprints)"), "issue API reads only current issue state keys");
assert(issuesRoute.includes("aggregateIncomplete"), "issue API exposes raw-reader truncation");
assert(issueDays("2.9") === 2, "issue API integer-clamps days before cache keying");
assert(issueDays("0") === 1 && issueDays("99") === 14 && issueDays("invalid") === 2, "issue API bounds and defaults days before cache keying");
assert(issuesRoute.includes('status: 500'), "issue query reports source failures");
assert(issuePatchRoute.includes("isIssueFingerprint(fingerprint)"), "issue mutation validates fingerprint");
assert(issuePatchRoute.includes('statuses.has(status)'), "issue mutation validates status");
assert(issuePatchRoute.includes("origin !== new URL(request.url).origin"), "issue mutation rejects cross-origin writes");
assert(issuePatchRoute.includes('status: 400'), "invalid issue mutation is rejected");
assert(issuePatchRoute.includes('status: 403'), "cross-origin issue mutation is forbidden");
assert(issuePatchRoute.includes("SharedStateWriteError ? 503"), "issue mutation reports shared storage failures as unavailable");
assert(issuePatchRoute.includes("serverIssue.lastSeen"), "issue resolution uses the server occurrence baseline");
assert(issuePatchRoute.includes("resolutionBlocked(status, rawDocumentsTruncated)"), "resolved transitions reject incomplete aggregates");
assert(issuePatchRoute.includes("invalidateIssueCache();\n      return Response.json({ error: \"issue occurrence changed\""), "stale expected versions invalidate issue cache before 409");

await checkUserGrouping();

assert(page.includes('alt="캡처된 모바일 화면"'), "mobile replay image renders");
assert(consoleCss.includes("object-fit: contain;"), "mobile replay screenshots are not cropped");
assert(page.includes('eventFilter === "screens"'), "screen replay frames are filterable");
assert(page.includes("matchesVisualReplay(trace, visualOnly)"), "trace list can filter visual replays");
assert(page.includes("replayScreenCount(trace) > 0"), "dashboard counts visual replays for the screens filter");
assert(page.includes("initialTraceId()"), "dashboard restores trace id from url");
assert(page.includes("initialSessionId()"), "dashboard restores session id from url");
assert(page.includes("function sessionDuration(session: SessionRow)"), "dashboard shows session duration");
assert(page.includes("session.firstSeen"), "session duration uses first seen timestamp");
assert(page.includes("최근 {timeLabel(session.lastSeen)}"), "session list shows latest timestamp");
assert(page.includes("에러 {session.errorCount}건"), "session list shows error count");
assert(page.includes("function traceSessionIds(trace: TraceRow)"), "dashboard matches all replay session ids");
assert(page.includes("initialReplayPlatform()"), "dashboard restores replay platform from url");
assert(page.includes("initialVisualOnly()"), "dashboard restores screens filter from url");
assert(page.includes("function initialReplayFrame(): number | null"), "dashboard restores replay frame from url");
assert(page.includes("function initialReplayIndex(): number"), "dashboard restores replay capture from url");
assert(page.includes("initialQuery()"), "dashboard restores search query from url");
assert(page.includes("initialViewMode()"), "dashboard restores view mode from url");
assert(page.includes("initialFilter()"), "dashboard restores metric filter from url");
assert(page.includes("initialDays()"), "dashboard restores time range from url");
assert(page.includes('const [filter, setFilter] = useState<TraceFilter>("all")'), "dashboard initial render avoids url hydration mismatch");
assert(page.includes("setFilter(initialFilter())"), "dashboard restores url filters after mount");
assert(page.includes('new URLSearchParams({ limit: "100", days: String(days) })'), "dashboard queries selected time range");
assert(page.includes('limit=1&traceId=${encodeURIComponent(linkedTraceId)}'), "dashboard backfills a trace deep link outside the list window");
assert(page.includes("current || linkedSessionId || nextData.sessions[0]?.sessionId"), "dashboard restores the session deep link without narrowing the list");
assert(page.includes("sourceBadge"), "dashboard shows source mode near actions");
assert(page.includes("sourceNotice"), "dashboard explains local and fallback source modes");
assert(page.includes('setViewMode("sessions")'), "session deep link opens sessions view");
assert(page.includes('type ViewMode = "traces" | "sessions" | "users" | "issues"'), "dashboard exposes the user view");
assert(page.includes("세션 {user.sessionCount}건"), "user rows show session counts");
assert(page.includes('className="eventKind info">{detail.durationMs}ms'), "timeline events show duration badges");
assert(page.includes('className="eventKind slow">SLOW'), "slow timeline events show warning badges");
assert(page.includes('<details className="eventData">'), "timeline event data is collapsed by default");
assert(consoleCss.includes(".eventKind.view"), "view timeline events have a dedicated badge style");
assert(page.includes('url.searchParams.set("traceId", selectedTraceId)'), "dashboard writes selected trace id to url");
assert(page.includes('url.searchParams.set("sessionId", selectedSessionId)'), "dashboard writes selected session id to url");
assert(page.includes('url.searchParams.set("platform", replayPlatform)'), "dashboard writes replay platform to url");
assert(page.includes('url.searchParams.set("screens", visualOnly ? "1" : "0")'), "dashboard writes screens filter to url");
assert(page.includes('url.searchParams.set("replay", String(selectedReplay))'), "dashboard writes selected replay capture to url");
assert(page.includes('url.searchParams.set("frame", String(currentFrame))'), "dashboard writes replay frame to url");
assert(page.includes('url.searchParams.set("q", next)'), "dashboard writes search query to url");
assert(page.includes('url.searchParams.set("view", viewMode)'), "dashboard writes view mode to url");
assert(page.includes('url.searchParams.set("filter", filter)'), "dashboard writes metric filter to url");
assert(page.includes('url.searchParams.set("days", String(days))'), "dashboard writes time range to url");
assert(page.includes("copySessionLink()"), "dashboard can copy session deep link");
assert(page.includes("세션 복사"), "session view exposes copy session action");
assert(page.includes('url.searchParams.set("view", "sessions")'), "copied session link opens sessions view");
assert(page.includes("copyTraceLink()"), "dashboard can copy trace deep link");
assert(page.includes('url.searchParams.set("traceId", trace.traceId)'), "copied trace link includes trace id");
assert(page.includes('url.searchParams.set("view", "issues")'), "copied issue trace link opens issues view");
assert(page.includes("copyIncidentSummary()"), "dashboard can copy incident summary");
assert(page.includes("function incidentShareSummary(trace: TraceRow"), "dashboard builds shareable incident summary");
assert(page.includes("요약 복사"), "trace detail exposes copy summary action");
assert(page.includes("copyFrameLink()"), "dashboard can copy replay frame deep link");
assert(page.includes('url.searchParams.set("replay", String(selectedReplay))'), "copied replay frame link includes replay capture index");
assert(page.includes('url.searchParams.set("frame", String(currentFrame))'), "copied replay frame link includes frame index");
assert(page.includes("trace.front?.context ? JSON.stringify(trace.front.context)"), "dashboard search includes frontend context");
assert(page.includes("trace.back?.context ? JSON.stringify(trace.back.context)"), "dashboard search includes backend context");
assert(page.includes("replayEventLines(replay).join(\" \")"), "dashboard search includes replay event text");
assert(page.includes("replay.frames?.map(frameLine).join(\" \")"), "dashboard search includes replay frame text");
assert(page.includes("function traceTags(trace: TraceRow)"), "dashboard shows trace env and release tags");
assert(page.includes('fetch(`/api/issues?days=${days}${traceParam}`, { signal: controller.signal })'), "dashboard fetches server issue groups with cancellation and optional trace backfill");
assert(page.includes('method: "PATCH"'), "dashboard persists issue state");
assert(page.includes("선택한 이슈 확인"), "dashboard acknowledges issues");
assert(page.includes("선택한 이슈 해결"), "dashboard resolves issues");
assert(page.includes("선택한 이슈 다시 열기"), "dashboard reopens issues");
assert(page.includes("relatedTraces"), "issue detail still reuses related traces");
assert(page.includes("집계 일부만 표시"), "issue UI visibly marks incomplete aggregates");
assert(page.includes("전체 발생을 확인할 수 없어 해결할 수 없습니다"), "issue UI explains why resolve is unavailable for incomplete aggregates");
assert(page.includes('!issueAggregateIncomplete && issue.status !== "resolved"'), "issue UI hides resolve while aggregation is incomplete");
assert(page.includes("response.status === 409"), "issue UI distinguishes stale expected-version conflicts");
assert(page.includes("새 발생이 확인되어 목록을 갱신했습니다"), "issue UI announces stale conflict refreshes");
assert(page.includes("최근 로드"), "issue detail distinguishes loaded recent traces from total occurrences");
assert(page.includes("OCCURRENCES SAMPLE"), "AI prompt explicitly labels issue occurrences as a sample");
assert(page.includes("issueRequestController.current?.abort()"), "issue refresh cancels stale requests");
assert(page.includes("issueRequestController.current === controller"), "only the latest issue refresh commits state");
assert(page.includes("return () => issueRequestController.current?.abort()"), "issue refresh aborts on cleanup");
assert(page.includes('fetch(`/api/traces?days=${days}&limit=1&traceId=${encodeURIComponent(issue.traceId)}`'), "missing representative trace is fetched directly");
assert(page.includes("trace.traceId === selectedIssue.traceId"), "issue detail selects only its representative trace");
assert(page.includes("issueTraceRequestController.current === controller"), "rapid issue switches cannot commit stale detail");
assert(page.includes("issueRowRefs.current.get"), "issue actions restore focus to a visible issue row");
assert(page.includes("issueTabRef.current?.focus()"), "issue actions fall back to the issue tab");
assert(page.includes('aria-live="polite"'), "issue status changes use a live region");
assert(page.includes('aria-live="assertive"'), "issue errors use an assertive live region");
assert(page.includes('viewMode === "issues" ? "이슈 목록"'), "issue view labels its list context");
assert(page.includes('viewMode === "issues" ? "이슈 검색"'), "issue view labels its search context");
assert(page.includes("function fatalReplayPlatform(trace: TraceRow)"), "issue cause identifies fatal replay-only errors");
assert(page.includes('line.includes("fatal=true")'), "issue cause reads fatal replay marker");
assert(page.includes('tagValue("릴리스", traceDimension(trace, "release"))'), "trace release tag falls back to replay metadata");
assert(page.includes("function userLine(trace: TraceRow)"), "dashboard displays user context");
assert(page.includes('key.startsWith("user.")'), "dashboard derives user from replay metadata");
assert(page.includes("function replayLabel(replay: ReplayDocument)"), "dashboard labels replay metadata");
assert(page.includes("metadata.os, metadata.device, metadata.appVersion"), "mobile replay label includes device context");
assert(page.includes("function replayScreenshotMissing(replay: ReplayDocument): boolean"), "dashboard detects missing mobile screenshot providers");
assert(page.includes("모바일 리플레이에 스크린샷 제공자가 설정되지 않아 이벤트만 표시합니다."), "dashboard explains event-only mobile replays");
assert(page.includes("Boolean(frame.html || frame.image)"), "screen filter targets visual frames");
assert(page.includes('eventFilter === "inputs"'), "input replay frames are filterable");
assert(page.includes('eventFilter === "scroll"'), "scroll replay frames are filterable");
assert(page.includes('eventFilter === "performance"'), "performance replay frames are filterable");
assert(page.includes("입력 {counts.inputs}"), "replay player shows input count");
assert(page.includes("스크롤 {counts.scroll}"), "replay player shows scroll count");
assert(page.includes("성능 {counts.performance}"), "replay player shows performance count");
assert(page.includes("const selectEventFilter = (nextFilter: ReplayEventFilter)"), "replay filters jump to first matching frame");
assert(page.includes("seekFrame(filteredReplayFrames(frames, nextFilter)[0]?.index ?? 0)"), "replay filters seek the visible event");
assert(page.includes("function issueFrameIndex(frames: ReplayFrame[]): number"), "replay opens on the error frame");
assert(page.includes("linkedFrame === null ? issueFrameIndex(frames) : boundedFrameIndex(linkedFrame, frames.length)"), "replay restores linked frame or falls back to issue frame");
assert(page.includes("boundedFrameIndex(linkedFrame, frames.length)"), "replay clamps linked frame index");
assert(page.includes("boundedReplayIndex(initialReplayIndex(), replays.length)"), "replay clamps linked replay capture index");
assert(page.includes('aria-label="재생 속도"'), "replay player exposes playback speed control");
assert(page.includes("frameDelay(frames[currentFrame], frames[currentFrame + 1], playbackSpeed)"), "replay playback speed affects frame delay");
assert(page.includes("seconds(frame.at) <= seconds(fallback.at)"), "replay uses the latest snapshot before the selected frame");
assert(page.includes("function replayFrameStyle(width: number, height: number): CSSProperties"), "web replay snapshots are scaled into the player viewport");
assert(page.includes('aria-label="리플레이 필름스트립"'), "replay player exposes a filmstrip");
assert(page.includes("className={`filmFrame ${item.image ? \"\" : \"noVisual\"} ${index === currentFrame ? \"active\" : \"\"} ${item.kind}`"), "filmstrip frames are selectable");
assert(consoleCss.includes(".filmFrame img"), "filmstrip shows captured screenshot thumbnails");
assert(page.includes("screens: ${visualFrameCount(replay)} captured"), "ai prompt includes visual frame count");
assert(page.includes("screens: missing screenshot provider"), "ai prompt explains mobile replay without screenshots");
assert(page.includes("Session IDs: ${traceSessionIds(trace).join(\", \")}"), "ai prompt includes all trace session ids");
assert(page.includes("function actionLinesBeforeIssue(lines: string[]): string[]"), "ai prompt includes actions before the replay issue");
assert(page.includes("actions before issue:"), "ai prompt labels pre-issue actions");
assert(page.includes("performance:"), "ai prompt labels replay performance signals");
assert(page.includes("function replaySummaryFrames(frames: ReplayFrame[])"), "ai prompt keeps late important replay frames");
assert(page.includes("function replayFrameSummaryLine(frame: ReplayFrame)"), "dashboard ai prompt keeps replay frame points");
assert(page.includes("point=${frame.x},${frame.y}"), "dashboard ai prompt includes mobile tap coordinates");
assert(page.includes("AI 트러블슈팅 분석"), "dashboard exposes local AI troubleshooting action");
assert(page.includes("function aiSessionJson(trace: TraceRow, relatedTraces?: TraceRow[], occurrenceTotal?: number): string"), "dashboard builds local AI session json");
assert(page.includes('schema: "jaytrace.ai-session.v1"'), "dashboard local AI json has a schema");
assert(page.includes("function localAiCommand(filename: string): string"), "dashboard builds local AI CLI command");
assert(page.includes("cat ${shellQuote(filename)} | claude code"), "dashboard command pipes downloaded session json into claude code");
assert(page.includes("JSON 다운로드"), "dashboard can download local AI session json");
assert(page.includes("navigator.clipboard?.writeText(command)"), "dashboard copies local AI command to clipboard");
assert(page.includes("new Blob([summaryJson], { type: \"application/json\" })"), "dashboard downloads AI summary as json");
assert(page.includes("incidentSequenceSection(trace)"), "ai prompt includes merged incident sequence");
assert(page.includes("<IncidentSequencePanel trace={trace} />"), "dashboard renders merged incident sequence");
assert(page.includes("function IncidentSequencePanel"), "dashboard has incident sequence panel");
assert(page.includes("function timelineEventLines(document: TimelineDocument): string[]"), "dashboard tolerates legacy structured timeline entries");
assert(page.includes("function timelineLine(value: unknown): string"), "dashboard normalizes timeline entries before prompt sorting");
assert(page.includes("return replay.events?.map(timelineLine).filter(Boolean) ?? [];"), "dashboard tolerates missing and legacy structured replay events");
assert(page.includes("promptTimelineEvents(`replay:${replay.platform}`, replay)"), "incident sequence includes replay platforms");
assert(page.includes("promptOffsetSeconds(line)"), "incident sequence sorts by event offset");
assert(page.includes("function replayEventLines(replay: ReplayDocument)"), "dashboard reads replay event lines");
assert(page.includes("function normalizeReplayFrame(frame: ReplayFrame)"), "dashboard normalizes stored replay frames");
assert(page.includes('params.set("platform", replayPlatform)'), "dashboard sends replay platform filter to api");
assert(page.includes('params.set("screens", "1")'), "dashboard sends visual replay filter to api");
assert(page.includes('frame.kind === "network"'), "network frames are filterable");
assert(page.includes("function isPerformanceFrame(frame: ReplayFrame): boolean"), "dashboard detects performance replay frames");
assert(page.includes("replay.platform === \"react-native\" || replay.platform === \"flutter\""), "mobile replay platforms use phone frame");
assert(page.includes("pointStyle(item, width, height, isMobileReplay(replay))"), "mobile replay pointer uses phone frame");
assert(page.includes("50% - min(360px, calc(100% - 36px)) / 2"), "mobile pointer is centered on phone frame");
assert(traceLib.includes("isReplayDocument as isCoreReplayDocument"), "dashboard uses core replay validator");
assert(packageJson.includes('"@jaytrace/replay-core": "workspace:*"'), "dashboard declares replay-core dependency");
assert(traceLib.includes("filterDocumentsByDays("), "dashboard applies time range to every source");
assert(tracesRoute.includes("sourceNotice(sourceMode)"), "api explains active source mode");
assert(traceLib.includes("Set JAYTRACE_BUCKET or JAYTRACE_S3_BUCKET"), "local source notice names S3 env");
assert(traceLib.includes("Date.parse(document.endedAt ?? document.startedAt)"), "dashboard filters documents by event timestamp");
assert(tracesRoute.includes('const traceId = nonEmpty(url.searchParams.get("traceId"))'), "api reads trace deep link filter");
assert(tracesRoute.includes('const sessionId = nonEmpty(url.searchParams.get("sessionId"))'), "api reads session deep link filter");
assert(traceLib.includes("collectRawDocuments({ days: clampedDays, limit, traceId })") && tracesRoute.includes("s3ReadLimit(limit, Boolean(traceId || sessionId || platform || screensOnly))"), "api uses the shared trace loader with the widened limit");
assert(documentsLib.includes("readS3Documents(source, opts.days, rawDocumentLimit, opts.traceId ?? null, includeSegments)"), "shared reader forwards trace deep link to S3");
assert(documentsLib.includes("recentDatePrefixes(source.prefix, days).map(prefix => traceId ? `${prefix}${traceId}/` : prefix)"), "shared reader narrows S3 prefixes for trace deep links");
assert(documentsLib.includes("readDocuments(localDirs, includeSegments, opts.traceId ?? null, rawDocumentLimit)"), "shared reader forwards trace deep link to local reads");
assert(documentsLib.includes('entry.name === ".state" || entry.name === "_state"'), "raw local traversal excludes issue state directories");
assert(documentsLib.includes("listJsonFiles(dir, rawDocumentLimit + 1, traceId)") && documentsLib.includes("(!traceId || pathHasSegment(path, traceId))"), "shared reader narrows local traversal before applying the cap");

// path-segment filter: local reads narrow to the traceId's directory by exact segment match (pure, executable).
assert(pathHasSegment("/logs/prod/2026/07/10/abc123/back-1.json", "abc123") === true, "pathHasSegment matches a traceId directory anywhere in the path");
assert(pathHasSegment("/logs/prod/2026/07/10/abc123/back-1.json", "abc1") === false, "pathHasSegment does not substring-match a shorter traceId prefix");
assert(pathHasSegment("/logs/abc123/back-1.json", "abc123") === true, "pathHasSegment matches a flat traceId directory");
assert(replayRoute.includes("isReplayV2SegmentDocument") && replayRoute.includes("collectRawDocuments"), "replay route reuses the shared reader and v2 guard");
assert(replayRoute.includes('{ error: "no replay v2 segments" }, { status: 404 }'), "replay route 404s when a session has no v2 segments");
assert(replayRoute.includes('{ error: "sessionId required" }, { status: 400 }'), "replay route 400s without a sessionId");
assert(replayRoute.includes("a.seq - b.seq || a.startedAt.localeCompare(b.startedAt)"), "replay route merges segments in seq order");
assert(replayRoute.includes("segments.flatMap(seg => seg.rrwebEvents ?? [])"), "replay route concatenates rrweb events across segments");
assert(replayRoute.includes('url.searchParams.get("traceId")') && replayRoute.includes("collectRawDocuments({ days, limit: 200, traceId, includeSegments: true })"), "replay route scopes the S3 read to the requested traceId and still reads v2 segments");

// v2 segment key filter: /api/traces skips segment files before reading bodies; /api/replay keeps them (pure, executable).
assert(isReplaySegmentKey("replay-web-1730000000000-seq3.json") === true, "isReplaySegmentKey matches web segment files");
assert(isReplaySegmentKey("replay-flutter-1730000000000-seq0.json") === true, "isReplaySegmentKey matches flutter segment files");
assert(isReplaySegmentKey("replay-react-native-1730000000000-seq1.json") === true, "isReplaySegmentKey matches react-native segment files");
assert(isReplaySegmentKey("production/2026/07/10/t1/replay-web-1730000000000-seq2.json") === true, "isReplaySegmentKey matches full S3 keys");
assert(isReplaySegmentKey("front-1730000000000.json") === false, "isReplaySegmentKey ignores timeline rows");
assert(isReplaySegmentKey("replay-web-1730000000000.json") === false, "isReplaySegmentKey ignores v1 replay rows without seq");
assert(documentsLib.includes("includeSegments || !isReplaySegmentKey"), "shared reader skips v2 segments unless includeSegments");
assert(documentsLib.includes("const includeSegments = opts.includeSegments ?? false"), "shared reader excludes v2 segments by default (the /api/traces path)");

// replayUrl helper: traceId narrows the read only when present (pure, executable).
assert(replayUrl("s1", 2) === "/api/replay?sessionId=s1&days=2", "replayUrl omits traceId when absent");
assert(replayUrl("s 1", 1, "t/1") === "/api/replay?sessionId=s%201&days=1&traceId=t%2F1", "replayUrl appends and encodes the traceId scope");

// rrweb replay player: marker derivation is a pure, executable function.
// Lines are `{offset}s {kind}{severity} {text}`, so severity has to outrank kind — a failed
// fetch reads "fetch error …" and must paint as an error marker, not a plain network one.
const derivedMarkers = deriveMarkers(
  [
    {
      startedAt: "2026-01-01T00:00:01.000Z",
      timeline: [
        "0.400s fetch GET /cart status=200",
        "0.600s fetch error GET /pay status=500",
        "1.200s error error checkout blew up",
        "2.000s click Buy"
      ]
    }
  ],
  Date.parse("2026-01-01T00:00:00.000Z")
);
assert(derivedMarkers.length === 3, "deriveMarkers keeps only fetch and error timeline lines");
assert(derivedMarkers[0].kind === "network" && derivedMarkers[0].atMs === 1400, "deriveMarkers maps a plain fetch line to a network marker at doc.startedAt + offset - replay.startedAt");
assert(derivedMarkers[1].kind === "error" && derivedMarkers[1].atMs === 1600, "deriveMarkers classifies a failed fetch by its error severity, not by the fetch kind token");
assert(derivedMarkers[2].kind === "error" && derivedMarkers[2].atMs === 2200, "deriveMarkers maps an error line to an error marker at the right absolute offset");
assert(deriveMarkers([{ startedAt: "2026-01-01T00:00:00.000Z", timeline: ["0.100s fetch warn GET /slow status=200"] }], Date.parse("2026-01-01T00:00:00.000Z"))[0].kind === "network", "deriveMarkers keeps non-error fetch severities on the network marker");

// 백엔드 워터폴: 기하 계산은 순수 함수라 그대로 실행해 검증한다. SDK 확장 필드
// (depth/spanId/parentSpanId/attrs, context.host, error.stack)는 전부 optional이므로
// 없는 문서(현재 stg 데이터)도 평면 워터폴로 그려져야 한다.
const flatDoc = { startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:00.023Z" };
const flatBars = waterfallBars(
  [
    { at: "0.000s", kind: "request", severity: "info", text: "request GET /api/v2/user/me", durationMs: 23.4 },
    { at: "0.007s", kind: "log", severity: "error", text: "토큰 재생성 중 오류 (무시): jwt malformed" }
  ],
  flatDoc
);
assert(flatBars.every(bar => bar.depth === 0), "waterfall falls back to a flat render when depth/spanId are absent");
assert(flatBars[0].tone === "request" && flatBars[0].duration > 0, "waterfall sizes a request bar from durationMs");
assert(flatBars[1].tone === "error", "waterfall lets severity=error outrank the log kind");
assert(flatBars[1].duration === 0, "waterfall leaves a durationMs-less event as a point marker");
const flatTotal = waterfallTotalSeconds(flatBars, flatDoc);
assert(Math.abs(flatTotal - 0.0234) < 1e-9, "waterfall axis stretches past endedAt when a bar runs longer");
assert(waterfallBarStyle(flatBars[1], flatTotal).width === undefined, "point markers get no width so CSS can draw the dot");
assert(waterfallBarStyle({ start: flatTotal, duration: flatTotal }, flatTotal).width === "0.8%", "a bar starting at the axis end still stays inside the track");
assert(waterfallTicks(flatTotal).map(tick => tick.label).join(",") === "0ms,6ms,12ms,18ms,23ms", "waterfall axis labels sub-second traces in ms");
assert(waterfallTicks(4).map(tick => tick.label).join(",") === "0.00s,1.00s,2.00s,3.00s,4.00s", "waterfall axis labels multi-second traces in seconds");
assert(waterfallTicks(0.001).map(tick => tick.label).join(",") === "0.00ms,0.25ms,0.50ms,0.75ms,1.00ms", "a sub-millisecond axis keeps distinct tick labels instead of repeating 0ms/1ms");
// 확장 필드가 붙은 문서: depth는 그대로 쓰고, 없으면 parentSpanId 체인으로 유도한다.
const nestedBars = waterfallBars(
  [
    { at: "0.000s", kind: "request", text: "GET /pay", durationMs: 120, spanId: "a" },
    { at: "0.010s", kind: "db", text: "SELECT 1", durationMs: 40, spanId: "b", parentSpanId: "a" },
    { at: "0.030s", kind: "fetch", text: "POST /pg", durationMs: 5, spanId: "c", parentSpanId: "b" },
    { at: "0.040s", kind: "log", text: "explicit depth wins", depth: 9 }
  ],
  flatDoc
);
assert(nestedBars.map(bar => bar.depth).join(",") === "0,1,2,8", "waterfall derives depth from the span chain and clamps an explicit depth");
assert(nestedBars.map(bar => bar.tone).join(",") === "request,db,fetch,log", "waterfall colors db and fetch spans distinctly");
assert(spanDepth("x", new Map([["x", "y"], ["y", "x"]])) === 1, "a cyclic span chain terminates instead of hanging the render");
assert(eventOffsetSeconds({ at: "2026-01-01T00:00:00.500Z" }, Date.parse(flatDoc.startedAt)) === 0.5, "waterfall accepts ISO event timestamps as well as second offsets");
assert(eventOffsetSeconds({ at: "not-a-time" }, Date.parse(flatDoc.startedAt)) === 0, "an unparseable event offset falls back to the axis origin");
assert(JSON.stringify(eventAttrs({ attrs: { "db.rows": 3, "db.table": "orders", bad: {} } })) === '[["db.rows","3"],["db.table","orders"]]', "attrs panel keeps scalar values only");
assert(eventAttrs({}).length === 0, "attrs panel stays empty when the SDK sends no attrs");
assert(stackFrames("at a (x.ts:1)\n\n  at b (y.ts:2)\n").join("|") === "at a (x.ts:1)|at b (y.ts:2)", "stack frames split per line and drop blanks");
assert(stackFrames("").length === 0 && stackFrames(undefined).length === 0, "an empty stack renders no frame list");
assert(hostContext({ host: { pod: "api-7f", rssMb: 812, heapUsedMb: 402 } }).rssMb === "812", "host panel reads pod and memory from context.host");
assert(hostContext({}) === null && hostContext(undefined) === null && hostContext({ host: {} }) === null, "host panel stays hidden without context.host");

// The rrweb player owns the marker origin: /api/replay's startedAt is the segment upload time
// and trails the first recorded event, which clamped every marker to atMs 0 (all at left:0%).
assert(replayPlayer.includes("replayer.getMetaData()") && replayPlayer.includes("setOriginMs(meta.startTime)"), "replay player bases markers on the first rrweb event, the same origin as totalTime");
assert(replayPlayer.includes("deriveMarkers(timelineDocs, originMs)"), "replay player derives its own markers against the Replayer origin");
assert(page.includes("timelineDocs={timelineDocs}"), "dashboard hands the rrweb player raw timeline docs instead of pre-based markers");
assert(replayPlayer.includes("new Replayer(") && replayPlayer.includes("skipInactive: true"), "replay player instantiates rrweb Replayer with skipInactive");
assert(replayPlayer.includes(".destroy()"), "replay player destroys the rrweb Replayer on unmount");
assert(consoleCss.includes(".replayer-mouse") && consoleCss.includes(".replayer-wrapper"), "console.css ships the rrweb replay stylesheet so it loads in SSR");
assert(replayPlayer.includes('className="replayPlayer"'), "replay player exposes the replayPlayer container class for the E2E smoke");
assert(replayPlayer.includes("replayScrubber"), "replay player exposes the replayScrubber class for the E2E smoke");
assert(replayPlayer.includes("replayPlayToggle"), "replay player exposes the replayPlayToggle class for the E2E smoke");
assert(page.includes('dynamic(() => import("./components/ReplayPlayer"), { ssr: false })'), "dashboard mounts the rrweb player client-only via next/dynamic");
assert(page.includes("function SessionReplay(") && page.includes("<ReplayPanel replays={trace.replays} />"), "dashboard branches to the v2 player while keeping the v1 filmstrip");
assert(page.includes("const hasFilmstrip = trace.replays.length > 0") && page.includes("if (hasFilmstrip) {"), "SessionReplay renders the v1 filmstrip immediately instead of blocking on the /api/replay probe");

// Wireframe replay: engine reflection + cross-segment atMs re-basing (pure, executable).
assert(replayRoute.includes('engine: "wireframe"') && replayRoute.includes("mergeWireframeFrames(segments)"), "replay route reflects the wireframe engine and merges wireframe frames");
assert(replayRoute.includes('const hasRrweb = segments.some(seg => seg.engine === "rrweb")'), "replay route prefers rrweb for mixed sessions");
assert(page.includes('dynamic(() => import("./components/WireframePlayer"), { ssr: false })'), "dashboard mounts the wireframe player client-only via next/dynamic");
assert(page.includes('probe.engine === "wireframe"') && page.includes("<WireframePlayer sessionId={sessionId} days={days} traceId={traceId} markers={markers} />"), "dashboard branches to the wireframe player on engine wireframe");
assert(wireframePlayer.includes("replayUrl(sessionId, days, traceId)") && replayPlayer.includes("replayUrl(sessionId, days, traceId)"), "both v2 players scope their /api/replay fetch by traceId");

// Feed two segments (given out of seq order) with per-segment atMs; merged atMs must be session-relative and monotonic.
const mergedFrames = mergeWireframeFrames([
  { seq: 1, startedAt: "2026-01-01T00:00:02.000Z", wireframeFrames: [{ atMs: 0, tag: "b0" }, { atMs: 300, tag: "b1" }] },
  { seq: 0, startedAt: "2026-01-01T00:00:00.000Z", wireframeFrames: [{ atMs: 0, tag: "a0" }, { atMs: 500, tag: "a1" }] }
]);
assert(mergedFrames.map(f => f.atMs).join(",") === "0,500,2000,2300", "mergeWireframeFrames re-bases each segment's frames onto the session start");
assert(mergedFrames.every((f, i) => i === 0 || f.atMs >= mergedFrames[i - 1].atMs), "merged wireframe frames are monotonic in atMs");
assert(mergedFrames[2].tag === "b0", "mergeWireframeFrames sorts segments by seq before merging");

// frameAtTime returns the latest frame whose atMs <= T.
assert(frameAtTime(mergedFrames, 1000)?.tag === "a1", "frameAtTime picks the latest frame at or before T");
assert(frameAtTime(mergedFrames, 2100)?.tag === "b0", "frameAtTime crosses into the next segment's frames");
assert(frameAtTime(mergedFrames, -1) === null, "frameAtTime returns null before the first frame");

assert(wireframePlayer.includes('className="replayPlayer"'), "wireframe player exposes the replayPlayer container class for the E2E smoke");
assert(wireframePlayer.includes("replayScrubber"), "wireframe player exposes the replayScrubber class for the E2E smoke");
assert(wireframePlayer.includes("replayPlayToggle"), "wireframe player exposes the replayPlayToggle class for the E2E smoke");
assert(wireframePlayer.includes("data-wireframe"), "wireframe player marks the SVG root with data-wireframe for the smoke");
assert(tracesRoute.includes("trace.traceId === traceId"), "api applies trace deep link filter");
assert(tracesRoute.includes("traceSessionIds(trace).includes(sessionId)"), "api applies session deep link filter");
assert(tracesRoute.includes("function replayPlatform(value: string | null)"), "api validates replay platform filter");
assert(tracesRoute.includes("s3ReadLimit(limit, Boolean(traceId || sessionId || platform || screensOnly))"), "api widens S3 reads for filtered queries");
assert(tracesRoute.includes("return filtered ? Math.min(bounded * 10, 1000) : bounded"), "api caps widened S3 replay reads");
assert(tracesRoute.includes("trace.replays.some(replay => replay.platform === platform)"), "api applies replay platform filter");
assert(tracesRoute.includes("visualFrameCount(replay) > 0"), "api applies visual replay filter");
assert(traceLib.includes("firstSeen: trace.lastSeen"), "api sessions keep first seen");
assert(traceLib.includes("function earliest(left: string, right: string)"), "api sessions compute first seen");
assert(traceLib.includes("export function traceSessionIds(trace: TraceRow)"), "api sessions include replay session ids");
assert(traceLib.includes("function replayEventLines(document: ReplayDocument)"), "api reads replay event lines");
assert(traceLib.includes("return document.events.map(eventLine).filter(Boolean);"), "api tolerates legacy structured replay events");
assert(traceLib.includes("function normalizeReplayDocument(value: unknown): unknown | null"), "api accepts legacy replay events before validation");
assert(nextConfig.includes("outputFileTracingRoot"), "next start uses the intended workspace root");
assert(logFormat.includes('release: appVersion'), "mobile log-format examples include release metadata");
assert(logFormat.includes('environment: "production"'), "react native log-format example includes environment metadata");
assert(logFormat.includes("environment: 'production'"), "flutter log-format example includes environment metadata");
assert(logFormat.includes("jaytrace.setUser({ id: userId })"), "react native log-format example uses one-line setUser");
assert(logFormat.includes("withReplayTextInput(jaytrace.replay, \"EmailInput\", setEmail)"), "react native log-format example records text input without values");
assert(logFormat.includes("jaytrace.addScroll(\"CheckoutList\", 320)"), "react native log-format example records scroll");
assert(logFormat.includes("jaytrace.addPerformance(\"SlowCheckoutScreen\", 420"), "react native log-format example records performance");
assert(logFormat.includes("jaytrace.addAction('CheckoutStarted'"), "flutter log-format example uses one-line addAction");
assert(logFormat.includes("jayTraceReplayOnChanged(jaytrace.replay, 'EmailInput')"), "flutter log-format example records text input without values");
assert(logFormat.includes("jaytrace.addInput('EmailInput')"), "flutter log-format example uses one-line addInput");
assert(logFormat.includes("jaytrace.addScroll('CheckoutList', offset: 320)"), "flutter log-format example records scroll");
assert(logFormat.includes("jaytrace.addPerformance('SlowCheckoutScreen', const Duration(milliseconds: 420)"), "flutter log-format example records performance");
assert(logFormat.includes("jaytrace.traceNetwork({"), "react native log-format example shows custom client network tracing");
assert(logFormat.includes("frame `type` is `dom` or `image`"), "log-format documents replay frame type constraints");
assert(logFormat.includes('numeric `x` and `y` tap coordinates'), "log-format documents mobile replay point coordinates");
assert(logFormat.includes("fatal=true"), "log-format documents react native fatal marker");
assert(logFormat.includes('"replay.screenshot": "enabled"'), "log-format documents mobile screenshot provider metadata");
assert(logFormat.includes('"view.name": "Checkout"'), "log-format documents mobile view metadata");
assert(readme.includes("screenshots=missing"), "README documents CLI missing screenshot status");
assert(readme.includes("`actions`, `network`, `errors`, `screens`"), "README documents CLI replay signal counts");
assert(readme.includes("does not install a global exception filter"), "README documents non-invasive NestJS error handling");
assert(readme.includes("setContext({ tenantId, \"user.id\": userId })"), "README documents backend custom context");
assert(logFormat.includes('"x": 210'), "log-format shows mobile replay x coordinate");
assert(logFormat.includes("Mobile screenshot replay can contain visible PII"), "log-format documents mobile screenshot privacy");
assert(logFormat.includes("enabled: () => !isSensitiveRoute()"), "log-format shows mobile screenshot capture gate");
assert(readme.includes("## S3 Console"), "README documents S3-backed console");
assert(readme.includes("JAYTRACE_BUCKET=jaytrace-prod JAYTRACE_S3_PREFIX=production"), "README shows S3 console env");
assert(readme.includes("Only the server-side `/api/traces` route reads S3"), "README keeps AWS credentials server-side");
assert(readme.includes("use `.next-console`"), "README documents isolated console dev output");
assert(readme.includes("maxInFlightExports"), "README documents S3 export backpressure");
assert(readme.includes("Browser long tasks are recorded as `performance`"), "README documents browser long task capture");
assert(readme.includes("Browser navigation timing is recorded as `performance`"), "README documents browser navigation timing capture");
assert(readme.includes("Web replay also records those browser performance signals as `Perf` frames."), "README documents web replay performance frames");
assert(logFormat.includes("Web long tasks are stored as `performance warn long_task"), "log-format documents browser long task lines");
assert(logFormat.includes("Web page-load timings are stored as `performance info navigation_timing"), "log-format documents browser navigation timing lines");
assert(rootPackageJson.includes('"dev:api"'), "root package exposes api dev script");
assert(rootPackageJson.includes('"dev:console"'), "root package exposes console dev script");
assert(rootPackageJson.includes("apps/next-app/scripts/dev-console.mjs"), "root package uses clean console dev script");
assert(nextConfig.includes("process.env.JAYTRACE_NEXT_DIST_DIR"), "console can isolate Next build output");
assert(devConsole.includes(".next-console") && devConsole.includes("JAYTRACE_NEXT_DIST_DIR"), "console dev script uses isolated Next build output");
assert(tsConfig.includes(".next-console/types/**/*.ts"), "tsconfig includes isolated console dev types");
assert(rootPackageJson.includes('"smoke:sample-web-web"'), "root package exposes sample-web web smoke script");
assert(rootPackageJson.includes('"smoke:mobile-s3"'), "root package exposes mobile S3 smoke script");
assert(sampleWebSmoke.includes("window.__jayTraceClient?.traceparent"), "sample-web smoke verifies the browser trace id");
assert(sampleWebSmoke.includes("/api/jaytrace-qa/error"), "sample-web smoke checks failed API evidence");
assert(sampleWebSmoke.includes("/jaytrace/rum"), "sample-web smoke checks RUM ingest evidence");
assert(sampleWebSmoke.includes("visualFrames"), "sample-web smoke requires visual replay frames");
assert(sampleWebSmoke.includes("waitForConsoleReplay"), "sample-web smoke verifies console replay rendering");
assert(sampleWebSmoke.includes(".replayIframe,.replayImage"), "sample-web smoke checks rendered replay media");
assert(sampleWebSmoke.includes("visualLoaded"), "sample-web smoke checks replay media content is loaded");
assert(sampleWebSmoke.includes("consoleFilmFrames"), "sample-web smoke reports console filmstrip rendering");
assert(sampleWebSmoke.includes("failureVisible"), "sample-web smoke checks visible failure signal");
assert(sampleWebSmoke.includes("consoleFailureVisible"), "sample-web smoke reports console-visible failure signal");
assert(sampleWebSmoke.includes("consolePerformanceFilterVisible"), "sample-web smoke reports performance filter");
assert(sampleWebSmoke.includes("consoleSummaryCopyVisible"), "sample-web smoke reports copy summary action");
assert(sampleWebSmoke.includes("feColorMatrix") && sampleWebSmoke.includes("redacted"), "sample-web smoke catches broken SVG replay masking");
assert(mobileS3Smoke.includes("pointFrame") && mobileS3Smoke.includes("networkFrame"), "mobile S3 smoke validates tap point and failed network frames");
assert(mobileS3Smoke.includes("performanceFrame"), "mobile S3 smoke validates performance frames");
assert(mobileS3Smoke.includes("inputFrame") && mobileS3Smoke.includes("scrollFrame"), "mobile S3 smoke validates input and scroll frames");
assert(mobileS3Smoke.includes("waitForConsoleReplayImage"), "mobile S3 smoke verifies console replay image rendering");
assert(mobileS3Smoke.includes(".replayImage"), "mobile S3 smoke checks rendered mobile replay image");
assert(mobileS3Smoke.includes("consoleFilmFrames"), "mobile S3 smoke reports console filmstrip rendering");
assert(mobileS3Smoke.includes("failureVisible"), "mobile S3 smoke checks visible failure signal");
assert(mobileS3Smoke.includes("consoleFailureVisible"), "mobile S3 smoke reports console-visible failure signal");
assert(mobileS3Smoke.includes("consolePerformanceFilterVisible"), "mobile S3 smoke reports performance filter");
assert(mobileS3Smoke.includes("consoleSummaryCopyVisible"), "mobile S3 smoke reports copy summary action");
assert(mobileS3Smoke.includes("session?.platforms?.includes(document.platform)"), "mobile S3 smoke validates session grouping");
assert(mobileS3Smoke.includes('metadata.release !== document.metadata.release'), "mobile S3 smoke validates release metadata");
assert(mobileS3Smoke.includes('metadata["user.id"] !== document.metadata["user.id"]'), "mobile S3 smoke validates user metadata");
assert(mobileS3Smoke.includes('metadata["view.name"] !== document.metadata["view.name"]'), "mobile S3 smoke validates view metadata");
assert(readme.includes("pnpm dev:api") && readme.includes("pnpm dev:console"), "README shows local smoke dev scripts");
assert(readme.includes("pnpm smoke:mobile-s3"), "README shows mobile S3 smoke command");
assert(readme.includes("mobile replay storage and console image rendering"), "README describes mobile smoke console rendering");
assert(readme.includes("Set `CHROME_PATH`"), "README documents smoke Chrome path override");
assert(readme.includes("docs/mobile-replay-qa.md"), "README links mobile device QA");
assert(mobileQa.includes("replay:react-native"), "mobile QA covers react native replay");
assert(mobileQa.includes("replay:flutter"), "mobile QA covers flutter replay");
assert(mobileQa.includes("replay.screenshot=enabled"), "mobile QA checks screenshot provider status");
assert(mobileQa.includes("The replay player shows the phone frame, tap point, and failed network row."), "mobile QA checks visual replay evidence");
assert(mobileQa.includes("view=issues") && mobileQa.includes("screens=1"), "mobile QA captures filtered console trace links");
assert(mobileQa.includes("numeric `x` and `y`") && mobileQa.includes("status=5xx"), "mobile QA requires point and failed network evidence");
assert(mobileQa.includes("release`, `environment`, `user.id`, `view.name`, `os`, and `device`"), "mobile QA requires operational replay metadata");
assert(mobileQa.includes("React Native and Flutter each return `screens: 6`"), "mobile QA smoke requires visual frames for both mobile platforms");
assert(mobileQa.includes("React Native and Flutter each return `consoleReplayImages: 1`"), "mobile QA smoke requires console-rendered mobile images");
assert(mobileQa.includes("React Native and Flutter each return `consoleFailureVisible: true`"), "mobile QA smoke requires console-visible failure signal");
assert(mobileQa.includes("redacted `input`, `scroll`, `performance`"), "mobile QA smoke requires input, scroll, and performance evidence");
assert(readme.includes('import { AppState, TextInput } from "react-native";'), "README imports RN AppState and TextInput from react-native");
assert(!readme.includes("AppState,\n  createReplayRootProps"), "README does not import AppState from JayTrace RN package");
assert(readme.includes("withReplayTextInput(jaytrace.replay, \"EmailInput\", setEmail)"), "README React Native example records text input without values");
assert(readme.includes("jaytrace.addScroll(\"CheckoutList\", 320)"), "README React Native example records scroll");
assert(readme.includes("jaytrace.addPerformance(\"SlowCheckoutScreen\", 420"), "README React Native example records performance");
assert(readme.includes("React Native screen tracking also keeps the latest screen in replay metadata as `view.name`."), "README documents rn view metadata");
assert(readme.includes("onReady={tracker.onReady}") && readme.includes("onStateChange={tracker.onStateChange}"), "README React Native example wires navigation replay tracker");
assert(readme.includes("import 'package:jaytrace_flutter/jaytrace_flutter.dart';"), "README Flutter example imports core package");
assert(readme.includes("import 'package:jaytrace_flutter/jaytrace_flutter_widgets.dart';"), "README Flutter example imports widgets package");
assert(readme.includes("jayTraceReplayOnChanged(jaytrace.replay, 'EmailInput')"), "README Flutter example records text input without values");
assert(readme.includes("jaytrace.addInput('EmailInput')"), "README Flutter example uses one-line addInput");
assert(readme.includes("jaytrace.addScroll('CheckoutList', offset: 320)"), "README Flutter example records scroll");
assert(readme.includes("jaytrace.addPerformance('SlowCheckoutScreen', const Duration(milliseconds: 420)"), "README Flutter example records performance");
assert(readme.includes("Flutter route tracking also keeps the latest route in replay metadata as `view.name`."), "README documents flutter view metadata");
assert(readme.includes("Call `jaytrace.dispose()` from your app root dispose hook or test teardown"), "README explains Flutter dispose timing");

async function checkUserGrouping() {
  const { groupSessions, groupUsers, traceUserKey } = await import("../app/api/lib/traces.ts");
  assert(traceUserKey({ front: { user: { id: " user-1 ", email: "user@example.com" }, context: { user: { id: "context-1" } } }, replays: [{ metadata: { userId: "metadata-1" } }] }) === "user-1", "document user wins over context and metadata fallbacks");
  assert(traceUserKey({ front: { context: { user: { id: " context-1 " } } }, replays: [{ metadata: { userId: "metadata-1" } }] }) === "context-1", "context user is the first fallback");
  assert(traceUserKey({ replays: [{ metadata: { userId: " metadata-1 " } }] }) === "metadata-1", "replay metadata userId is the second fallback");
  assert(traceUserKey({ back: { context: { "user.id": " legacy-1 " } }, replays: [{ metadata: { userId: "metadata-1" } }] }) === "legacy-1", "legacy context user ids remain ahead of metadata fallbacks");
  assert(traceUserKey({ replays: [] }) === "anonymous", "missing user identity groups as anonymous");

  const trace = (traceId, sessionId, lastSeen, user) => ({
    traceId,
    sessionId,
    lastSeen,
    status: "ok",
    services: ["checkout"],
    summary: traceId,
    front: user ? { user } : undefined,
    replays: []
  });
  const users = groupUsers(groupSessions([
    trace("trace-1", "session-1", "2026-07-16T03:00:00.000Z", { id: "user-1", email: "user@example.com", name: "Jay" }),
    trace("trace-2", "session-2", "2026-07-16T02:00:00.000Z", { id: "user-1" }),
    trace("trace-3", "session-3", "2026-07-16T01:00:00.000Z")
  ]));
  assert(users[0].id === "user-1" && users[0].sessionCount === 2 && users[0].sessions.length === 2, "user grouping nests all matching sessions");
  assert(users[0].email === "user@example.com" && users[0].name === "Jay", "user grouping retains optional profile fields");
  assert(users[1].id === "anonymous" && users[1].sessionCount === 1, "anonymous sessions remain visible");
}

async function checkIssueStatePersistence() {
  const { readIssueStates, writeIssueState } = await import("../app/api/lib/issue-state.ts");
  const root = await mkdtemp(join(tmpdir(), "jaytrace-issue-state-"));
  const stateDir = join(root, ".state", "issues");
  const envKeys = ["JAYTRACE_LOGS_DIR", "JAYTRACE_BUCKET", "JAYTRACE_S3_BUCKET", "JAYTRACE_S3_PREFIX"];
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const originalConsoleError = console.error;
  let reportedErrors = 0;
  console.error = () => { reportedErrors += 1; };

  const state = (fingerprint, status, updatedAt, resolvedAt = null, lastOccurrenceAtResolution = null) => ({
    schema: "jaytrace.issue-state.v1",
    fingerprint,
    status,
    updatedAt,
    resolvedAt,
    lastOccurrenceAtResolution
  });

  try {
    process.env.JAYTRACE_LOGS_DIR = root;
    delete process.env.JAYTRACE_BUCKET;
    delete process.env.JAYTRACE_S3_BUCKET;
    const localFingerprint = "a".repeat(64);
    const written = await writeIssueState(localFingerprint, "acknowledged", "2026-07-16T01:00:00.000Z");
    const localFiles = await readdir(stateDir);
    assert(localFiles.includes(`${localFingerprint}.json`) && !localFiles.some(file => file.endsWith(".tmp")), "local state write atomically leaves only the final file");
    assert((await readIssueStates([localFingerprint]))[localFingerprint]?.updatedAt === written.updatedAt, "local state round-trips through production functions");
    const resolvedFingerprint = "6".repeat(64);
    const resolvedWritten = await writeIssueState(resolvedFingerprint, "resolved", "2026-07-16T01:00:00+02:00");
    assert(resolvedWritten.lastOccurrenceAtResolution === "2026-07-15T23:00:00.000Z", "resolved writes canonicalize lastSeen to UTC Z");

    const corruptFingerprint = "b".repeat(64);
    const invalidResolvedFingerprint = "c".repeat(64);
    const invalidAcknowledgedFingerprint = "d".repeat(64);
    const mismatchedFingerprint = "3".repeat(64);
    const invalidTimestampFingerprint = "5".repeat(64);
    await writeFile(join(stateDir, `${corruptFingerprint}.json`), "{", "utf8");
    await writeFile(join(stateDir, `${invalidResolvedFingerprint}.json`), JSON.stringify(state(invalidResolvedFingerprint, "resolved", "2026-07-16T02:00:00.000Z")), "utf8");
    await writeFile(join(stateDir, `${invalidAcknowledgedFingerprint}.json`), JSON.stringify(state(invalidAcknowledgedFingerprint, "acknowledged", "2026-07-16T02:00:00.000Z", "2026-07-16T02:00:00.000Z", "2026-07-16T01:00:00.000Z")), "utf8");
    await writeFile(join(stateDir, `${mismatchedFingerprint}.json`), JSON.stringify(state("4".repeat(64), "new", "2026-07-16T02:00:00.000Z")), "utf8");
    await writeFile(join(stateDir, `${invalidTimestampFingerprint}.json`), JSON.stringify(state(invalidTimestampFingerprint, "new", "2026-02-31T00:00:00Z")), "utf8");
    const isolated = await readIssueStates([corruptFingerprint, invalidResolvedFingerprint, invalidAcknowledgedFingerprint, mismatchedFingerprint, invalidTimestampFingerprint]);
    assert(!isolated[corruptFingerprint] && !isolated[invalidResolvedFingerprint] && !isolated[invalidAcknowledgedFingerprint] && !isolated["4".repeat(64)] && !isolated[invalidTimestampFingerprint], "corrupt, mismatched, and invariant-invalid states are isolated");

    const mergedFingerprint = "e".repeat(64);
    await writeFile(join(stateDir, `${mergedFingerprint}.json`), JSON.stringify(state(mergedFingerprint, "new", "2026-07-16T01:00:00-04:00")), "utf8");
    assert((await readIssueStates([mergedFingerprint]))[mergedFingerprint]?.updatedAt === "2026-07-16T05:00:00.000Z", "parsed state timestamps are canonical UTC Z");

    process.env.JAYTRACE_BUCKET = "test-bucket";
    process.env.JAYTRACE_S3_PREFIX = "test-prefix";
    const secondS3Fingerprint = "1".repeat(64);
    const s3States = {
      [`test-prefix/_state/issues/${mergedFingerprint}.json`]: state(mergedFingerprint, "acknowledged", "2026-07-16T06:00:00.000Z"),
      [`test-prefix/_state/issues/${secondS3Fingerprint}.json`]: state(secondS3Fingerprint, "acknowledged", "2026-07-16T08:00:00.000Z")
    };
    const exactS3 = async command => {
      assert(command.constructor.name === "GetObjectCommand", "state reads use exact GetObject keys without listing history");
      const body = s3States[command.input.Key];
      if (!body) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return { Body: { transformToString: async () => JSON.stringify(body) } };
    };
    const exact = await readIssueStates([mergedFingerprint, secondS3Fingerprint], exactS3);
    assert(exact[mergedFingerprint]?.status === "acknowledged" && exact[secondS3Fingerprint], "only requested S3 states are read and merged with newer local fallback");

    const fallbackFingerprint = "2".repeat(64);
    let sharedFailure = false;
    try {
      await writeIssueState(fallbackFingerprint, "acknowledged", "2026-07-16T09:00:00.000Z", async command => {
        if (command.constructor.name === "GetObjectCommand") throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
        throw new Error("expected S3 write failure");
      });
    } catch (error) {
      sharedFailure = error?.constructor?.name === "SharedStateWriteError";
    }
    assert(sharedFailure, "S3 write failure is propagated after local spooling so PATCH cannot return 200");
    const staleS3 = async command => ({ Body: { transformToString: async () => JSON.stringify(state(fallbackFingerprint, "new", "2020-01-01T00:00:00Z")) } });
    const mergedFallback = (await readIssueStates([fallbackFingerprint], staleS3))[fallbackFingerprint];
    assert(mergedFallback?.status === "acknowledged", "newer local fallback survives a later stale S3 read");
    delete process.env.JAYTRACE_BUCKET;
    const fallback = JSON.parse(await readFile(join(stateDir, `${fallbackFingerprint}.json`), "utf8"));
    assert(fallback.fingerprint === fallbackFingerprint && fallback.status === "acknowledged", "failed S3 writes atomically fall back to local state");

    process.env.JAYTRACE_BUCKET = "test-bucket";
    const concurrentFingerprint = "7".repeat(64);
    let stored = null;
    let etag = 0;
    const fakeS3 = async command => {
      if (command.constructor.name === "GetObjectCommand") {
        if (!stored) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
        return { ETag: `\"${etag}\"`, Body: { transformToString: async () => JSON.stringify(stored) } };
      }
      const expected = stored ? `\"${etag}\"` : undefined;
      if ((expected && command.input.IfMatch !== expected) || (!expected && command.input.IfNoneMatch !== "*")) {
        throw Object.assign(new Error("conflict"), { name: "PreconditionFailed" });
      }
      stored = JSON.parse(command.input.Body);
      etag += 1;
      return { ETag: `\"${etag}\"` };
    };
    await Promise.all([
      writeIssueState(concurrentFingerprint, "acknowledged", "2026-07-16T09:00:00.000Z", fakeS3),
      writeIssueState(concurrentFingerprint, "resolved", "2026-07-16T10:00:00.000Z", fakeS3)
    ]);
    assert(stored.status === "resolved" && stored.lastOccurrenceAtResolution === "2026-07-16T10:00:00.000Z", "same-fingerprint concurrent writes serialize and preserve the newer action");

    const conflictFingerprint = "8".repeat(64);
    const newer = state(conflictFingerprint, "resolved", "2099-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", "2026-07-16T10:00:00.000Z");
    let conflictStep = 0;
    const conflictingS3 = async command => {
      if (command.constructor.name === "GetObjectCommand") {
        if (conflictStep === 0) {
          conflictStep = 1;
          throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
        }
        return { ETag: '"newer"', Body: { transformToString: async () => JSON.stringify(newer) } };
      }
      assert(command.input.IfNoneMatch === "*", "new S3 state uses an If-None-Match precondition");
      conflictStep = 2;
      throw Object.assign(new Error("raced"), { name: "PreconditionFailed" });
    };
    const conflictResult = await writeIssueState(conflictFingerprint, "acknowledged", "2026-07-16T10:00:00.000Z", conflictingS3);
    assert(conflictStep === 2 && conflictResult.status === "resolved", "conditional conflict retry cannot overwrite a newer cross-instance state");
    assert(reportedErrors >= 4, "state parse and S3 failures are reported");
  } finally {
    console.error = originalConsoleError;
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function checkIssuePatchBaseline() {
  const { PATCH } = await import("../app/api/issues/[fingerprint]/route.ts");
  const { resolutionBlocked } = await import("../app/lib/issues.mjs");
  const { cachedIssueResponse, invalidateIssueCache } = await import("../app/api/lib/issue-cache.ts");
  const root = await mkdtemp(join(tmpdir(), "jaytrace-issue-patch-"));
  const saved = { logs: process.env.JAYTRACE_LOGS_DIR, bucket: process.env.JAYTRACE_BUCKET, legacyBucket: process.env.JAYTRACE_S3_BUCKET };
  try {
    process.env.JAYTRACE_LOGS_DIR = root;
    delete process.env.JAYTRACE_BUCKET;
    delete process.env.JAYTRACE_S3_BUCKET;
    const lastSeen = new Date().toISOString();
    const trace = issueTrace({ lastSeen });
    const fingerprint = issueFingerprint(trace);
    const traceDir = join(root, "production", lastSeen.slice(0, 4), lastSeen.slice(5, 7), lastSeen.slice(8, 10), trace.traceId);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(traceDir, { recursive: true }));
    await writeFile(join(traceDir, "back.json"), JSON.stringify(trace.back), "utf8");
    const request = expected => new Request(`http://localhost/api/issues/${fingerprint}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved", lastSeen: expected })
    });
    invalidateIssueCache();
    let cacheLoads = 0;
    await cachedIssueResponse("stale-patch-check", async () => ++cacheLoads);
    assert((await PATCH(request("2099-01-01T00:00:00.000Z"), { params: Promise.resolve({ fingerprint }) })).status === 409, "future client lastSeen is rejected as a version conflict");
    await cachedIssueResponse("stale-patch-check", async () => ++cacheLoads);
    assert(cacheLoads === 2, "stale expected-version 409 invalidates cached issue views");
    assert((await PATCH(request("2020-01-01T00:00:00.000Z"), { params: Promise.resolve({ fingerprint }) })).status === 409, "stale client lastSeen is rejected as a version conflict");
    assert((await PATCH(request(lastSeen), { params: Promise.resolve({ fingerprint }) })).status === 200, "matching expected version resolves using the server occurrence baseline");
    assert((await PATCH(request(lastSeen), { params: Promise.resolve({ fingerprint: "f".repeat(64) }) })).status === 404, "missing fingerprint occurrence is rejected");
    assert(resolutionBlocked("resolved", true) && !resolutionBlocked("acknowledged", true) && !resolutionBlocked("resolved", false), "only resolved transitions are blocked by incomplete aggregates");
  } finally {
    if (saved.logs === undefined) delete process.env.JAYTRACE_LOGS_DIR; else process.env.JAYTRACE_LOGS_DIR = saved.logs;
    if (saved.bucket === undefined) delete process.env.JAYTRACE_BUCKET; else process.env.JAYTRACE_BUCKET = saved.bucket;
    if (saved.legacyBucket === undefined) delete process.env.JAYTRACE_S3_BUCKET; else process.env.JAYTRACE_S3_BUCKET = saved.legacyBucket;
    await rm(root, { recursive: true, force: true });
  }
}

async function checkIssueCache() {
  const { cachedIssueResponse, invalidateIssueCache, issueDays } = await import("../app/api/lib/issue-cache.ts");
  assert(issueDays("2.9") === 2 && issueDays("99") === 14 && issueDays("0") === 1 && issueDays("nope") === 2, "issue days are integer-clamped to 1..14 before cache keying");
  let loads = 0;
  const load = async () => ({ loads: ++loads });
  assert((await cachedIssueResponse("one", load)).loads === 1, "issue cache loads its first value");
  assert((await cachedIssueResponse("one", load)).loads === 1, "issue cache reuses a warm value");
  invalidateIssueCache();
  assert((await cachedIssueResponse("one", load)).loads === 2, "PATCH invalidation expires cached issue views");
  invalidateIssueCache();
  for (let index = 0; index < 15; index += 1) await cachedIssueResponse(`bounded-${index}`, load);
  const beforeReload = loads;
  await cachedIssueResponse("bounded-0", load);
  assert(loads === beforeReload + 1, "issue cache evicts old entries beyond the 14-day key bound");
}

async function checkRawDocumentCap() {
  const { collectRawDocuments } = await import("../app/api/lib/documents.ts");
  const root = await mkdtemp(join(tmpdir(), "jaytrace-document-cap-"));
  const saved = { logs: process.env.JAYTRACE_LOGS_DIR, bucket: process.env.JAYTRACE_BUCKET, legacyBucket: process.env.JAYTRACE_S3_BUCKET };
  try {
    process.env.JAYTRACE_LOGS_DIR = root;
    delete process.env.JAYTRACE_BUCKET;
    delete process.env.JAYTRACE_S3_BUCKET;
    const traceId = "cap-test-trace";
    const traceDir = join(root, traceId);
    const stateDir = join(root, ".state", traceId);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(traceDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await Promise.all(Array.from({ length: 81 }, (_, index) => writeFile(join(traceDir, `${index}.json`), JSON.stringify({ index }), "utf8")));
    await writeFile(join(stateDir, "hidden.json"), JSON.stringify({ hidden: true }), "utf8");
    const result = await collectRawDocuments({ days: 1, limit: 20, traceId });
    assert(result.rawDocumentsRead === 80 && result.rawDocumentsTruncated, "raw reader exposes a truthful bounded truncation result");
    assert(!result.documents.some(document => document?.hidden), "raw local traversal excludes .state documents");

    const deepRoot = join(root, "deep-link-order");
    const unrelatedDir = join(deepRoot, "000-unrelated");
    const targetId = "zzz-target-trace";
    const targetDir = join(deepRoot, targetId);
    await mkdir(unrelatedDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await Promise.all(Array.from({ length: 81 }, (_, index) => writeFile(join(unrelatedDir, `${index}.json`), JSON.stringify({ unrelated: index }), "utf8")));
    await writeFile(join(targetDir, "target.json"), JSON.stringify({ target: true }), "utf8");
    const narrowed = await collectRawDocuments({ days: 1, limit: 20, traceId: targetId });
    assert(narrowed.documents.length === 1 && narrowed.documents[0]?.target === true && !narrowed.rawDocumentsTruncated, "traceId narrowing happens before the raw cap and returns a late target");
  } finally {
    if (saved.logs === undefined) delete process.env.JAYTRACE_LOGS_DIR; else process.env.JAYTRACE_LOGS_DIR = saved.logs;
    if (saved.bucket === undefined) delete process.env.JAYTRACE_BUCKET; else process.env.JAYTRACE_BUCKET = saved.bucket;
    if (saved.legacyBucket === undefined) delete process.env.JAYTRACE_S3_BUCKET; else process.env.JAYTRACE_S3_BUCKET = saved.legacyBucket;
    await rm(root, { recursive: true, force: true });
  }
}

// 라우트 레이턴시 백분위. 버킷 상한은 [1,2,5,10,25,50,100,250,500,1000,2500,5000,10000,30000]
// (+오버플로 1칸)이라 인덱스 6 버킷은 (50, 100] ms 구간이다.
async function checkRouteLatencyPercentiles() {
  const bucket = (index, count) => Array.from({ length: HISTOGRAM_SIZE }, (_, slot) => (slot === index ? count : 0));

  const empty = mergeHistograms([]);
  assert(empty.length === HISTOGRAM_SIZE && histogramTotal(empty) === 0, "merging no rows yields an empty 15-bucket histogram");
  assert(histogramPercentile(empty, 0.5) === null && histogramRank(empty, 100) === null, "an empty histogram reports no percentile and no rank");
  assert(formatRank(null) === null, "a missing rank has no badge text");

  assert(toHistogram(null).every(count => count === 0), "a null histogram column degrades to zeros");
  assert(toHistogram([1, 2, 3]).length === HISTOGRAM_SIZE, "a short histogram column is padded to 15 buckets");
  assert(toHistogram("[0,0,0,0,0,0,7]")[6] === 7, "a JSON-string histogram column is parsed");
  assert(toHistogram("not json").every(count => count === 0), "an unparseable histogram column degrades to zeros");
  assert(toHistogram([-3, "x"]).every(count => count === 0), "negative and non-numeric bucket counts degrade to zero");

  const single = bucket(6, 10);
  assert(histogramPercentile(single, 0.5) === 75, "a single bucket interpolates p50 between its bounds");
  assert(histogramPercentile(single, 0.95) === 97.5, "a single bucket interpolates p95 between its bounds");

  // 같은 (service, route, window)의 pod별 행 — 하나는 배열, 하나는 JSON 문자열로 온다.
  const merged = mergeHistograms([bucket(6, 4), JSON.stringify(bucket(6, 6))]);
  assert(histogramTotal(merged) === 10 && histogramPercentile(merged, 0.5) === 75, "per-pod rows merge bucket-wise before the percentile");

  const overflow = mergeHistograms([bucket(0, 95), bucket(HISTOGRAM_SIZE - 1, 5)]);
  assert(histogramPercentile(overflow, 0.5) === 50 / 95, "the overflow bucket does not distort a fast p50");
  assert(histogramPercentile(overflow, 0.99) === Number.POSITIVE_INFINITY, "a p99 landing in the overflow bucket has no upper bound");
  assert(formatLatency(histogramPercentile(overflow, 0.99)) === ">30s", "an unbounded percentile renders as >30s");
  assert(formatLatency(412) === "412ms" && formatLatency(1500) === "1.5s", "latency formatting switches to seconds above 1s");

  const spread = mergeHistograms([bucket(0, 90), bucket(6, 10)]);
  assert(histogramRank(spread, 75) === 5, "a request mid-bucket ranks by the slower share of that bucket");
  assert(Math.abs(histogramRank(spread, 0.5) - 55) < 1e-9, "a fast request counts the slower half of its own bucket");
  assert(histogramRank(spread, 200) === 0, "a request slower than every sample tops the rank");
  assert(formatRank(histogramRank(spread, 75)) === "상위 5%", "rank renders as a top-percent badge");
  assert(formatRank(0.4) === "상위 1%", "a sub-1% rank rounds up instead of reading as 상위 0%");
  assert(histogramRank(mergeHistograms([bucket(0, 90), bucket(HISTOGRAM_SIZE - 1, 10)]), 40000) === 10, "an overflow-bucket request counts the whole unbounded bucket as slower");

  // available:true 경로 — 실제 MySQL 없이, DB가 돌려줄 (service, route, window, pod) 행을
  // 라우트와 같은 순서(rows → mergeHistograms → histogramPercentile)로 흘려 응답 숫자를 고정한다.
  const podRows = [
    { count_total: 40, histogram: bucket(6, 40) },
    { count_total: 55, histogram: JSON.stringify(bucket(9, 55)) },
    { count_total: 5, histogram: bucket(HISTOGRAM_SIZE - 1, 5) }
  ];
  const podHistogram = mergeHistograms(podRows.map(row => row.histogram));
  assert(histogramTotal(podHistogram) === 100, "pod rows merge into one 100-sample distribution");
  assert(Math.round(histogramPercentile(podHistogram, 0.5)) === 591, "p50 crosses bucket boundaries across merged pod rows");
  assert(histogramPercentile(podHistogram, 0.95) === 1000, "p95 lands on the exact bucket bound when the quantile fills it");
  assert(histogramPercentile(podHistogram, 0.99) === Number.POSITIVE_INFINITY, "p99 falls into the overflow bucket the slowest pod contributed");

  // 통계는 부가 데이터라 이 라우트는 어떤 경우에도 500을 내면 안 된다.
  assert(clampStatsHours(null) === 24 && clampStatsHours("999") === 168 && clampStatsHours("0") === 1 && clampStatsHours("nope") === 24, "stats hours are integer-clamped to 1..168");
  // Next.js 라우트 파일은 GET/POST/runtime 외의 export를 금지해서 창 클램프는 lib에 둔다.
  assert(statsRoute.includes("clampStatsHours(url.searchParams.get(\"hours\"))"), "stats route clamps the hours window before querying");
  const { GET } = await import("../app/api/stats/route.ts");
  const stats = url => GET(new Request(`http://console.local/api/stats${url}`));
  const missingParams = await stats("");
  assert(missingParams.status === 200 && (await missingParams.json()).available === false, "stats without service/route report unavailable instead of failing");
  const noDb = await stats("?service=checkout&route=/pay");
  assert(noDb.status === 200 && (await noDb.json()).available === false, "stats without a configured DB report unavailable instead of 500");

  const savedHost = process.env.JAYTRACE_DB_HOST;
  const savedPort = process.env.JAYTRACE_DB_PORT;
  try {
    process.env.JAYTRACE_DB_HOST = "127.0.0.1";
    process.env.JAYTRACE_DB_PORT = "1";
    const unreachable = await stats("?service=checkout&route=/pay&hours=168");
    assert(unreachable.status === 200 && (await unreachable.json()).available === false, "a failing stats query (missing table, unreachable DB) reports unavailable instead of 500");
  } finally {
    if (savedHost === undefined) delete process.env.JAYTRACE_DB_HOST; else process.env.JAYTRACE_DB_HOST = savedHost;
    if (savedPort === undefined) delete process.env.JAYTRACE_DB_PORT; else process.env.JAYTRACE_DB_PORT = savedPort;
  }

  assert(!statsRoute.includes("status: 500"), "stats route never returns a 500");
  assert(statsRoute.includes("ER_NO_SUCH_TABLE"), "stats route documents the missing-table case it swallows");
  assert(page.includes("routeStatsCache"), "route stats are fetched once per detail view, not per event click");
  assert(page.includes('bar.tone === "request" && stats'), "the latency badge only renders on a request event with available stats");
  assert(page.includes('event.attrs?.["http.route"]'), "route lookup falls back to the request event http.route attribute");
  assert(existsSync(new URL("../app/lib/percentile.d.mts", import.meta.url)), "percentile.mjs ships its ESM declaration");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`self-check failed: ${message}`);
  }
}
