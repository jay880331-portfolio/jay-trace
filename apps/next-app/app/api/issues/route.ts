import { readIssueStates } from "../lib/issue-state.ts";
import { loadTraceRows, sourceNotice } from "../lib/traces.ts";
import { groupIssues } from "../../lib/issues.mjs";
import { cachedIssueResponse, invalidateIssueCache, issueDays } from "../lib/issue-cache.ts";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const clampedDays = issueDays(url.searchParams.get("days"));
  const requestedTraceId = url.searchParams.get("traceId");

  try {
    const key = [clampedDays, process.env.JAYTRACE_LOGS_DIR, process.env.JAYTRACE_BUCKET, process.env.JAYTRACE_S3_BUCKET, process.env.JAYTRACE_S3_PREFIX].join("|");
    const load = async () => {
      const { sourceMode, traces, rawDocumentsRead, rawDocumentsTruncated } = await loadTraceRows(clampedDays, 10000);
      const ungrouped = groupIssues(traces);
      const fingerprints = ungrouped.map(issue => issue.fingerprint);
      const states = await readIssueStates(fingerprints);
      return {
        generatedAt: new Date().toISOString(),
        sourceMode,
        sourceNotice: sourceNotice(sourceMode),
        aggregateIncomplete: rawDocumentsTruncated,
        rawDocumentsRead,
        issues: groupIssues(traces, states)
      };
    };
    const cached = await cachedIssueResponse(key, load);
    // 딥링크 traceId가 캐시된 집계에 없으면 방금 들어와 30초 캐시 창에 걸린 트레이스일 수
    // 있다. /api/traces의 딥링크 백필(위 refresh())과 같은 이유로 캐시를 한 번 무시한다.
    if (requestedTraceId && !cached.issues.some(issue => issue.traceIds.includes(requestedTraceId))) {
      invalidateIssueCache();
      return Response.json(await cachedIssueResponse(key, load));
    }
    return Response.json(cached);
  } catch (error) {
    console.error("Failed to query issues", error);
    return Response.json({ error: "issue query failed" }, { status: 500 });
  }
}
