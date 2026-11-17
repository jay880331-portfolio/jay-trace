// Pure, framework-free so scripts/self-check.mjs (and the API route) can import and exercise it directly.
// A wireframe segment carries frames whose atMs is relative to that segment's own startedAt.
// Merging re-bases every frame's atMs onto the SESSION start (the first segment's startedAt) so
// frames across segments share one monotonic timeline.

/**
 * @param {{ seq: number, startedAt: string, wireframeFrames?: { atMs: number }[] }[]} segments
 * @returns {any[]} frames with session-relative atMs, in timeline order
 */
export function mergeWireframeFrames(segments) {
  const sorted = [...segments].sort(
    (a, b) => a.seq - b.seq || String(a.startedAt).localeCompare(String(b.startedAt))
  );
  const sessionStart = Date.parse(sorted[0]?.startedAt);
  const base = Number.isFinite(sessionStart) ? sessionStart : 0;
  const frames = [];
  for (const seg of sorted) {
    const segStart = Date.parse(seg.startedAt);
    const offset = Number.isFinite(segStart) ? segStart - base : 0;
    for (const frame of seg.wireframeFrames ?? []) {
      frames.push({ ...frame, atMs: offset + frame.atMs });
    }
  }
  return frames;
}

/**
 * The frame that should be on screen at time T: the latest frame with atMs <= T.
 * @param {{ atMs: number }[]} frames session-relative frames (assumed atMs-ascending)
 * @param {number} t
 * @returns {any | null}
 */
export function frameAtTime(frames, t) {
  let current = null;
  for (const frame of frames) {
    if (frame.atMs <= t) current = frame;
  }
  return current;
}
