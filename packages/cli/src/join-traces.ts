import type { JoinedTrace, TraceFile } from "./types.js";

export function joinTraces(files: TraceFile[], traceId?: string): JoinedTrace[] {
  const groups = new Map<string, TraceFile[]>();

  for (const file of files) {
    if (traceId && file.document.traceId !== traceId) {
      continue;
    }

    groups.set(file.document.traceId, [...(groups.get(file.document.traceId) ?? []), file]);
  }

  return Array.from(groups.entries())
    .map(([id, items]) => joinOne(id, items))
    .filter((trace) => trace.front || trace.back || trace.replays.length > 0)
    .sort((a, b) => b.score - a.score);
}

function joinOne(traceId: string, files: TraceFile[]): JoinedTrace {
  const front = latest(files.filter((file) => file.document.schema === "jaytrace.timeline.v1" && file.document.side === "front"));
  const back = latest(files.filter((file) => file.document.schema === "jaytrace.timeline.v1" && file.document.side === "back"));
  // replays holds both v1 (full event log) and v2 (rrweb segment) docs, grouped by traceId; distinguish by document.schema.
  const replays = files
    .filter((file) => file.document.schema === "jaytrace.replay.v1" || file.document.schema === "jaytrace.replay.v2")
    .sort(newestFirst);
  const replay = replays.find((file) => file.document.schema === "jaytrace.replay.v1");
  const latestTime = Math.max(
    front?.modifiedAt.getTime() ?? 0,
    back?.modifiedAt.getTime() ?? 0,
    ...replays.map((file) => file.modifiedAt.getTime())
  );
  const pairBonus = front && back ? 1_000_000_000_000_000 : 0;

  return {
    traceId,
    front,
    back,
    replay,
    replays,
    score: pairBonus + latestTime
  };
}

/** Sum of (endedAt - startedAt) across v2 segments, in whole seconds. Non-v2 items are ignored. */
export function replayV2DurationSeconds(segments: TraceFile[]): number {
  const totalMs = segments.reduce((total, file) => {
    if (file.document.schema !== "jaytrace.replay.v2") {
      return total;
    }
    const diff = Date.parse(file.document.endedAt) - Date.parse(file.document.startedAt);
    // ponytail: malformed timestamps contribute 0 instead of poisoning the total with NaN.
    return total + (Number.isFinite(diff) ? Math.max(0, diff) : 0);
  }, 0);
  return Math.round(totalMs / 1000);
}

/** Sum of wireframeFrames.length across wireframe-engine v2 segments. Non-wireframe items are ignored. */
export function wireframeFrameCount(segments: TraceFile[]): number {
  return segments.reduce((total, file) => {
    if (file.document.schema !== "jaytrace.replay.v2" || file.document.engine !== "wireframe") {
      return total;
    }
    return total + (file.document.wireframeFrames?.length ?? 0);
  }, 0);
}

function latest(files: TraceFile[]): TraceFile | undefined {
  return files.sort(newestFirst)[0];
}

function newestFirst(a: TraceFile, b: TraceFile): number {
  return b.modifiedAt.getTime() - a.modifiedAt.getTime();
}
