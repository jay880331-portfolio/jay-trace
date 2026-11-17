import type { ReplayDocument } from "@jaytrace/replay-core";
import { loadTraceRows } from "../lib/traces";
import { groupSessions, groupUsers, sourceNotice, traceSessionIds } from "../lib/traces";
import { isDbMode, loadTraceListFromDb } from "../lib/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 80);
  const days = Number(url.searchParams.get("days") ?? 2);
  const traceId = nonEmpty(url.searchParams.get("traceId"));
  const sessionId = nonEmpty(url.searchParams.get("sessionId"));
  const platform = replayPlatform(url.searchParams.get("platform"));
  const screensOnly = url.searchParams.get("screens") === "1";
  const clampedDays = Math.max(1, Math.min(days, 14));

  // List requests (no traceId) read the MySQL index when JAYTRACE_DB_HOST is set;
  // a null result means the DB was unreachable, so fall through to the S3 scan.
  // Detail requests (traceId) always load full documents from S3. platform/screens
  // filters need replay documents the index doesn't carry, so they also take the
  // S3 path — correctness over speed for those (rare) filtered views.
  const dbList = isDbMode() && !traceId && !platform && !screensOnly ? await loadTraceListFromDb(clampedDays) : null;
  const { sourceMode, source, localDirs, traces: loadedTraces } = dbList ?? await loadTraceRows(
    clampedDays,
    s3ReadLimit(limit, Boolean(traceId || sessionId || platform || screensOnly)),
    traceId
  );
  const traces = loadedTraces
    .filter(trace => !traceId || trace.traceId === traceId)
    // sessionId가 traceId와 같으면 매칭 인정: 세션 문서가 도착하기 전에 발급된
    // 딥링크는 sessionId 자리에 traceId 폴백이 기록되는데, 이후 진짜 sessionId가
    // 생겨도 그 링크가 계속 열리도록 한다.
    .filter(trace => !sessionId || sessionId === trace.traceId || traceSessionIds(trace).includes(sessionId))
    .filter(trace => !platform || trace.replays.some(replay => replay.platform === platform))
    .filter(trace => !screensOnly || trace.replays.some(replay => visualFrameCount(replay) > 0))
    .slice(0, Math.max(1, Math.min(limit, 200)));
  // 세션 그룹핑은 경량화 전 전체 traces로 수행한다 (sessionId/replay 본문 의존).
  const sessions = groupSessions(traces);

  // 목록 모드(traceId 없음)는 Amplify/Lambda ~6MB 응답 상한에 걸리지 않도록 replay 본문을
  // 요약 스텁으로 대체하고 light 플래그를 단다. 상세 모드(traceId)는 전체 문서 그대로 반환.
  const responseTraces = traceId ? traces : traces.map(trace => ({
    ...trace,
    light: true,
    replays: trace.replays.map(replay => ({
      platform: replay.platform,
      sessionId: replay.sessionId,
      metadata: replay.metadata,
      visualFrames: visualFrameCount(replay),
      fatal: replay.events.some(line => line.includes("fatal=true"))
    }))
  }));

  return Response.json({
    generatedAt: new Date().toISOString(),
    sourceMode,
    sourceNotice: sourceNotice(sourceMode),
    sourceDirs: sourceMode === "s3" && source ? [`s3://${source.bucket}/${source.prefix}`] : localDirs,
    traces: responseTraces,
    sessions,
    users: groupUsers(sessions)
  });
}

function nonEmpty(value: string | null): string | null {
  return value?.trim() || null;
}

function replayPlatform(value: string | null): ReplayDocument["platform"] | null {
  return value === "web" || value === "react-native" || value === "flutter" ? value : null;
}

function s3ReadLimit(limit: number, filtered: boolean): number {
  const bounded = Math.max(1, Math.min(limit, 200));
  return filtered ? Math.min(bounded * 10, 1000) : bounded;
}

function visualFrameCount(document: ReplayDocument): number {
  return document.frames?.filter(frame => frame.html || frame.image).length ?? 0;
}
