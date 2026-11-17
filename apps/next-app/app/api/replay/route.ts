import { isReplayV2SegmentDocument } from "@jaytrace/replay-core";
import type { ReplayV2SegmentDocument } from "@jaytrace/replay-core";
import { collectRawDocuments } from "../lib/documents";
import { mergeWireframeFrames } from "../../lib/wireframeFrames.mjs";

export const runtime = "nodejs";

// GET /api/replay?sessionId=...&days=N&traceId=...
// Merges all jaytrace.replay.v2 segments for a session (seq asc) into one event stream.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId")?.trim();
  if (!sessionId) {
    return Response.json({ error: "sessionId required" }, { status: 400 });
  }

  const daysParam = Number(url.searchParams.get("days") ?? 1);
  const days = Math.max(1, Math.min(Number.isFinite(daysParam) ? daysParam : 1, 14));

  // traceId narrows the S3 read to `{prefix}/{yyyy}/{mm}/{dd}/{traceId}/...` so we read
  // only this trace's handful of segment files instead of scanning every document in the
  // day range. sessionId stays the correctness boundary below. Tradeoff: a session that
  // legitimately spans multiple traces would only surface the current trace's segments —
  // acceptable for the console's per-trace detail view. Omit traceId to merge across all.
  const traceId = url.searchParams.get("traceId")?.trim() || null;

  const { documents } = await collectRawDocuments({ days, limit: 200, traceId, includeSegments: true });
  const earliest = Date.now() - days * 24 * 60 * 60 * 1000;

  const segments = documents
    .map(v2SegmentFromJson)
    .filter((seg): seg is ReplayV2SegmentDocument => seg !== null && seg.sessionId === sessionId)
    .filter(seg => {
      const timestamp = Date.parse(seg.endedAt ?? seg.startedAt);
      return Number.isFinite(timestamp) && timestamp >= earliest;
    })
    .sort((a, b) => a.seq - b.seq || a.startedAt.localeCompare(b.startedAt));

  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first || !last) {
    return Response.json({ error: "no replay v2 segments" }, { status: 404 });
  }

  // Reflect the actual engine of the matched segments. Mixed sessions prefer rrweb.
  const hasRrweb = segments.some(seg => seg.engine === "rrweb");
  if (hasRrweb) {
    const rrwebEvents = segments.flatMap(seg => seg.rrwebEvents ?? []);
    // A stream with no FullSnapshot (rrweb EventType 2) can never render — the player
    // would show an empty canvas. Report "no segments" so the console falls back to the
    // v1 filmstrip instead. Happens when only post-drain error tails survived in storage.
    const playable = rrwebEvents.some(event => (event as { type?: number } | null)?.type === 2);
    if (!playable) {
      return Response.json({ error: "no playable replay v2 segments" }, { status: 404 });
    }
    return Response.json({
      sessionId,
      engine: "rrweb",
      segments: segments.length,
      startedAt: first.startedAt,
      endedAt: last.endedAt,
      rrwebEvents
    });
  }

  return Response.json({
    sessionId,
    engine: "wireframe",
    segments: segments.length,
    startedAt: first.startedAt,
    endedAt: last.endedAt,
    wireframeFrames: mergeWireframeFrames(segments)
  });
}

function v2SegmentFromJson(value: unknown): ReplayV2SegmentDocument | null {
  if (isReplayV2SegmentDocument(value)) {
    return value;
  }
  const inner = value && typeof value === "object" ? (value as { document?: unknown }).document : null;
  return isReplayV2SegmentDocument(inner) ? inner : null;
}
