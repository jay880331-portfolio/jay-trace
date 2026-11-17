import type { PersistedIssueStatus } from "../../../lib/issues.mjs";
import { isIssueFingerprint } from "../../../lib/issues.mjs";
import { SharedStateWriteError, writeIssueState } from "../../lib/issue-state.ts";
import { loadTraceRows } from "../../lib/traces.ts";
import { groupIssues, resolutionBlocked } from "../../../lib/issues.mjs";
import { invalidateIssueCache } from "../../lib/issue-cache.ts";

export const runtime = "nodejs";

const statuses = new Set<PersistedIssueStatus>(["new", "acknowledged", "resolved"]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ fingerprint: string }> }
) {
  const { fingerprint } = await params;
  if (!isIssueFingerprint(fingerprint)) {
    return Response.json({ error: "invalid issue fingerprint" }, { status: 400 });
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: "cross-origin issue mutation forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid issue state" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid issue state" }, { status: 400 });
  }
  const { status, lastSeen } = body as { status?: PersistedIssueStatus; lastSeen?: unknown };
  if (status === undefined || !statuses.has(status) || (lastSeen !== undefined && !isIsoTimestamp(lastSeen))) {
    return Response.json({ error: "invalid issue state" }, { status: 400 });
  }

  try {
    const { traces, rawDocumentsTruncated } = await loadTraceRows(14, 10000);
    if (resolutionBlocked(status, rawDocumentsTruncated)) {
      return Response.json({ error: "issue aggregate incomplete; resolve requires a complete occurrence baseline" }, { status: 409 });
    }
    const serverIssue = groupIssues(traces).find(issue => issue.fingerprint === fingerprint);
    if (!serverIssue) return Response.json({ error: "issue occurrence not found" }, { status: 404 });
    if (lastSeen !== undefined && Date.parse(lastSeen) !== Date.parse(serverIssue.lastSeen)) {
      invalidateIssueCache();
      return Response.json({ error: "issue occurrence changed", lastSeen: serverIssue.lastSeen }, { status: 409 });
    }
    const state = await writeIssueState(
      fingerprint,
      status,
      serverIssue.lastSeen
    );
    invalidateIssueCache();
    return Response.json(state);
  } catch (error) {
    invalidateIssueCache();
    console.error(`Failed to write issue state ${fingerprint}`, error);
    return Response.json({ error: "issue state write failed" }, { status: error instanceof SharedStateWriteError ? 503 : 500 });
  }
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = Number(match[7] ?? 0);
  const offsetMinute = Number(match[8] ?? 0);
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month! >= 1 && month! <= 12 && day! >= 1 && day! <= days[month! - 1]!
    && hour! <= 23 && minute! <= 59 && second! <= 59 && offsetHour <= 23 && offsetMinute <= 59
    && Number.isFinite(Date.parse(value));
}
