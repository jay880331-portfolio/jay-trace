// jaytrace.replay.v2 SEGMENT files (`replay-{platform}-{ts}-seq{n}.json`) are only
// consumed by /api/replay. /api/traces discards them but pays to read their (large)
// bodies, so it skips them at the LISTING stage via this predicate. Matches the `-seq<n>`
// suffix; plain `replay-web-...json` (no seq) and `front-...json` are trace-list rows and pass.
export function isReplaySegmentKey(key) {
  return /-seq\d+\.json$/.test(key);
}
