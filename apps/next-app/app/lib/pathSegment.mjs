// Local logs mirror the S3 layout (<root>/.../<yyyy>/<mm>/<dd>/<traceId>/<file>.json),
// so narrowing a local read to a traceId is a path-segment match, not a substring
// match (a traceId that's a prefix of another must not cross-match).
import { sep } from "node:path";

export function pathHasSegment(path, segment) {
  return path.split(sep).includes(segment);
}
