// Build the /api/replay query. traceId (when present) narrows the S3 read to the
// current trace's segment folder so the probe/player reads a handful of files, not
// every document in the day range. sessionId stays the correctness filter server-side.
export function replayUrl(sessionId, days, traceId) {
  let url = `/api/replay?sessionId=${encodeURIComponent(sessionId)}&days=${days}`;
  if (traceId) {
    url += `&traceId=${encodeURIComponent(traceId)}`;
  }
  return url;
}
