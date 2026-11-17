// Pure, framework-free so scripts/self-check.mjs can import and exercise it directly.
// Timeline lines are formatted as `{offset}s {kind}{severity} {text}` (see packages/core/src/timeline.ts),
// where the severity token is optional and drawn from JayTraceSeverity.
// Only fetch/error lines become markers, and severity outranks kind: a failed fetch is
// written as `0.504s fetch error GET /pay status=500`, so classifying on the kind token
// alone painted it as a plain network marker and the error marker went missing.
const LINE = /^(\d+(?:\.\d+)?)s\s+(fetch|error)\b(?:\s+(debug|info|warn|error|fatal)(?=\s|$))?/;

/**
 * @param {{ startedAt: string, timeline?: string[] }[]} docs
 * @param {number} replayStartedMs origin of the player clock — for rrweb this is the first
 *   recorded event (Replayer.getMetaData().startTime), not the segment upload time.
 * @returns {{ atMs: number, kind: "network" | "error", label: string }[]}
 */
export function deriveMarkers(docs, replayStartedMs) {
  const markers = [];
  for (const doc of docs) {
    if (!doc || !Array.isArray(doc.timeline)) continue;
    const docStartMs = Date.parse(doc.startedAt);
    if (!Number.isFinite(docStartMs)) continue;
    for (const line of doc.timeline) {
      const match = LINE.exec(line);
      if (!match) continue;
      const offsetMs = Math.round(Number.parseFloat(match[1]) * 1000);
      const failed = match[2] === "error" || match[3] === "error" || match[3] === "fatal";
      const kind = failed ? "error" : "network";
      const atMs = Math.max(0, docStartMs + offsetMs - replayStartedMs);
      markers.push({ atMs, kind, label: line.trim() });
    }
  }
  return markers.sort((a, b) => a.atMs - b.atMs);
}
