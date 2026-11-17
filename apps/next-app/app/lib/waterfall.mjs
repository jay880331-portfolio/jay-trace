// Pure, framework-free so scripts/self-check.mjs can import and exercise it directly.
// 백엔드 타임라인 워터폴의 기하 계산. SDK 확장 필드(depth/spanId/parentSpanId/attrs,
// context.host, error.stack)는 전부 optional이라 없으면 평면(depth 0) 워터폴로 떨어진다.

const OFFSET = /^(\d+(?:\.\d+)?)s$/;
const DEPTH_CAP = 8;

/**
 * kind + severity로 막대 색을 고른다. severity가 error/fatal이면 kind보다 우선한다
 * (`kind: "log", severity: "error"`인 스팬 로그가 실제 stg 데이터의 다수라서).
 * @param {{ kind?: string, severity?: string }} event
 * @returns {"request" | "db" | "fetch" | "log" | "error" | "other"}
 */
export function waterfallTone(event) {
  const kind = String(event?.kind ?? "").toLowerCase();
  const severity = String(event?.severity ?? "").toLowerCase();
  if (kind === "error" || severity === "error" || severity === "fatal") return "error";
  if (kind === "db" || kind === "query" || kind === "sql" || kind === "redis" || kind === "mongo") return "db";
  if (kind === "fetch" || kind === "http" || kind === "xhr" || kind === "rpc" || kind === "network") return "fetch";
  if (kind === "request" || kind === "route" || kind === "handler") return "request";
  if (kind === "log" || kind === "console" || kind === "info") return "log";
  return "other";
}

/**
 * front는 "0.191s" 오프셋, back(SSR)은 ISO 시각으로도 들어온다 — 둘 다 초 오프셋으로 맞춘다.
 * @param {{ at?: string }} event
 * @param {number} baseMs Date.parse(document.startedAt)
 * @returns {number}
 */
export function eventOffsetSeconds(event, baseMs) {
  const at = String(event?.at ?? "").trim();
  const offset = OFFSET.exec(at);
  if (offset) return Number(offset[1]);
  const absolute = Date.parse(at);
  return Number.isFinite(absolute) && Number.isFinite(baseMs) ? Math.max(0, (absolute - baseMs) / 1000) : 0;
}

/**
 * depth가 없을 때만 부모 체인 길이로 유도한다. 순환 스팬은 seen으로 끊는다.
 * @param {string | undefined} spanId
 * @param {Map<string, string | undefined>} parents
 * @returns {number}
 */
export function spanDepth(spanId, parents) {
  const seen = new Set(spanId ? [spanId] : []);
  let current = spanId ? parents.get(spanId) : undefined;
  let depth = 0;
  while (current && parents.has(current) && !seen.has(current)) {
    seen.add(current);
    depth += 1;
    current = parents.get(current);
  }
  return depth;
}

/**
 * @param {Array<Record<string, any>>} events
 * @param {{ startedAt?: string }} doc
 * @returns {Array<{ index: number, event: any, start: number, duration: number, depth: number, tone: string }>}
 */
export function waterfallBars(events, doc) {
  const base = Date.parse(doc?.startedAt ?? "");
  const parents = new Map();
  for (const event of events) {
    if (event?.spanId) parents.set(event.spanId, event.parentSpanId);
  }
  return events.map((event, index) => ({
    index,
    event,
    start: eventOffsetSeconds(event, base),
    duration: typeof event?.durationMs === "number" && event.durationMs > 0 ? event.durationMs / 1000 : 0,
    depth: Math.min(
      typeof event?.depth === "number" ? Math.max(0, Math.trunc(event.depth)) : spanDepth(event?.spanId, parents),
      DEPTH_CAP
    ),
    tone: waterfallTone(event)
  }));
}

/**
 * 축 길이는 문서 duration과 실제 막대 끝 중 큰 값 — durationMs가 endedAt을 넘겨도 잘리지 않게.
 * @param {Array<{ start: number, duration: number }>} bars
 * @param {{ startedAt?: string, endedAt?: string }} doc
 * @returns {number}
 */
export function waterfallTotalSeconds(bars, doc) {
  const started = Date.parse(doc?.startedAt ?? "");
  const ended = Date.parse(doc?.endedAt ?? "");
  const documentSeconds = Number.isFinite(started) && Number.isFinite(ended) ? (ended - started) / 1000 : 0;
  return Math.max(documentSeconds, ...bars.map(bar => bar.start + bar.duration), 0.001);
}

/**
 * durationMs가 없는 이벤트는 width 없이 점 마커(.waterfallBar.point)로 그린다.
 * @param {{ start: number, duration: number }} bar
 * @param {number} total
 * @returns {{ left: string, width?: string }}
 */
export function waterfallBarStyle(bar, total) {
  const left = Math.max(0, Math.min(100, (bar.start / total) * 100));
  if (bar.duration <= 0) return { left: `${left}%` };
  return { left: `${left}%`, width: `${Math.max(0.8, Math.min(100 - left, (bar.duration / total) * 100))}%` };
}

/**
 * @param {number} total
 * @returns {{ ratio: number, label: string }[]}
 */
export function waterfallTicks(total) {
  return [0, 0.25, 0.5, 0.75, 1].map(ratio => ({ ratio, label: formatWaterfallSeconds(total * ratio, total) }));
}

/**
 * 단위와 자릿수는 눈금 하나가 아니라 축 전체(total)로 정한다 — 1ms짜리 트레이스에서
 * 눈금별로 반올림하면 "0ms 0ms 1ms 1ms 1ms"처럼 같은 라벨이 반복된다.
 * @param {number} value seconds
 * @param {number} [total] 축 길이(초). 생략하면 값 자체 기준.
 * @returns {string}
 */
export function formatWaterfallSeconds(value, total = value) {
  if (total >= 1) return `${value.toFixed(2)}s`;
  return `${(value * 1000).toFixed(total >= 0.01 ? 0 : 2)}ms`;
}

/**
 * @param {{ attrs?: Record<string, unknown> }} event
 * @returns {Array<[string, string]>}
 */
export function eventAttrs(event) {
  return Object.entries(event?.attrs ?? {})
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]) => [key, String(value)]);
}

/**
 * @param {string | undefined} stack
 * @returns {string[]}
 */
export function stackFrames(stack) {
  return String(stack ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

/**
 * @param {Record<string, unknown> | undefined} context
 * @returns {{ pod?: string, rssMb?: string, heapUsedMb?: string } | null}
 */
export function hostContext(context) {
  const host = context?.host;
  if (!host || typeof host !== "object") return null;
  const read = key => (typeof host[key] === "string" || typeof host[key] === "number" ? String(host[key]) : undefined);
  const result = { pod: read("pod"), rssMb: read("rssMb"), heapUsedMb: read("heapUsedMb") };
  return result.pod || result.rssMb || result.heapUsedMb ? result : null;
}
