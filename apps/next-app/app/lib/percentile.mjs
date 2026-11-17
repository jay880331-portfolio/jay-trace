// Pure, framework-free so scripts/self-check.mjs can import and exercise it directly.
// 라우트 레이턴시 백분위 추정. 원본은 `jaytrace_route_stats.histogram` — (service, route,
// window, pod)별로 한 행씩 쌓이는 길이 15 배열이라, 조회 범위의 행들을 칸별로 더한 뒤
// 계산한다. 버킷 경계는 SDK v1과 같은 값으로 고정 — 여기서 바꾸면 과거 행이 어긋난다.

/** ms 단위 버킷 상한. 인덱스 i 버킷은 (BOUNDS[i-1], BOUNDS[i]] 구간, 마지막 칸(14)은 오버플로. */
export const HISTOGRAM_BOUNDS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

export const HISTOGRAM_SIZE = HISTOGRAM_BOUNDS.length + 1;

/**
 * JSON 컬럼은 드라이버 설정에 따라 배열로도 문자열로도 온다 — 둘 다 받고, 모양이 어긋난
 * 행은 통계를 망치기보다 0으로 떨군다.
 * @param {unknown} value
 * @returns {number[]} 길이 HISTOGRAM_SIZE
 */
export function toHistogram(value) {
  let source = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      source = null;
    }
  }
  const list = Array.isArray(source) ? source : [];
  return Array.from({ length: HISTOGRAM_SIZE }, (_, index) => {
    const count = Number(list[index]);
    return Number.isFinite(count) && count > 0 ? count : 0;
  });
}

/**
 * @param {unknown[]} values 행별 histogram 컬럼 값
 * @returns {number[]} 칸별 합
 */
export function mergeHistograms(values) {
  const merged = new Array(HISTOGRAM_SIZE).fill(0);
  for (const value of values) {
    const histogram = toHistogram(value);
    for (let index = 0; index < HISTOGRAM_SIZE; index += 1) {
      merged[index] += histogram[index];
    }
  }
  return merged;
}

/**
 * @param {number[]} histogram
 * @returns {number}
 */
export function histogramTotal(histogram) {
  return histogram.reduce((sum, count) => sum + count, 0);
}

/**
 * 버킷 안에서는 하한→상한 선형 보간. 표본이 오버플로 칸에 떨어지면 상한이 없으므로
 * Infinity를 돌려주고(= 30s 초과) 표기는 formatLatency가 맡는다.
 * @param {number[]} histogram
 * @param {number} quantile 0..1
 * @returns {number | null} ms, 표본이 없으면 null
 */
export function histogramPercentile(histogram, quantile) {
  const total = histogramTotal(histogram);
  if (total <= 0) {
    return null;
  }
  const target = Math.min(Math.max(quantile, 0), 1) * total;
  let cumulative = 0;
  for (let index = 0; index < HISTOGRAM_SIZE; index += 1) {
    const count = histogram[index];
    if (count <= 0) {
      continue;
    }
    if (cumulative + count >= target) {
      if (index === HISTOGRAM_SIZE - 1) {
        return Number.POSITIVE_INFINITY;
      }
      const lower = index === 0 ? 0 : HISTOGRAM_BOUNDS[index - 1];
      const upper = HISTOGRAM_BOUNDS[index];
      return lower + (upper - lower) * ((target - cumulative) / count);
    }
    cumulative += count;
  }
  return HISTOGRAM_BOUNDS[HISTOGRAM_BOUNDS.length - 1];
}

/**
 * 주어진 요청이 분포에서 어디쯤인지 — "상위 n%"의 n. 느릴수록 작은 값.
 * 오버플로 칸에 걸리면 상한이 없어 칸 전체를 자기보다 느린 쪽으로 세는(= 보수적인) 값이 된다.
 * @param {number[]} histogram
 * @param {number} durationMs
 * @returns {number | null} 0..100, 표본이 없으면 null
 */
export function histogramRank(histogram, durationMs) {
  const total = histogramTotal(histogram);
  if (total <= 0 || !Number.isFinite(durationMs)) {
    return null;
  }
  let slower = 0;
  for (let index = HISTOGRAM_SIZE - 1; index >= 0; index -= 1) {
    const count = histogram[index];
    if (count <= 0) {
      continue;
    }
    const lower = index === 0 ? 0 : HISTOGRAM_BOUNDS[index - 1];
    if (index === HISTOGRAM_SIZE - 1) {
      // 오버플로 칸은 상한이 없어 보간할 수 없다 — 칸 전체를 느린 쪽으로 센다.
      slower += count;
      if (durationMs > lower) {
        break;
      }
      continue;
    }
    if (durationMs <= lower) {
      slower += count;
      continue;
    }
    const upper = HISTOGRAM_BOUNDS[index];
    if (durationMs < upper) {
      slower += count * ((upper - durationMs) / (upper - lower));
    }
    break;
  }
  return Math.min(100, Math.max(0, (slower / total) * 100));
}

/**
 * 조회 창(시간). 기본 24h, 최대 168h(7일) — 그 위로는 (service, route, window, pod) 행이
 * 너무 불어나서 병합 비용이 배지 하나 값을 못 한다.
 * @param {string | null} value
 * @returns {number}
 */
export function clampStatsHours(value) {
  const parsed = Number(value ?? 24);
  const hours = Number.isFinite(parsed) ? Math.trunc(parsed) : 24;
  return Math.max(1, Math.min(hours, 168));
}

/**
 * @param {number | null | undefined} ms Infinity/null이면 마지막 버킷 초과
 * @returns {string}
 */
export function formatLatency(ms) {
  if (ms == null || !Number.isFinite(ms)) {
    return `>${HISTOGRAM_BOUNDS[HISTOGRAM_BOUNDS.length - 1] / 1000}s`;
  }
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 0.4%를 "상위 0%"로 반올림하지 않도록 1% 아래는 1%로 올린다 — 자릿수보다 "제일 느린 축"이
 * 읽혀야 하는 배지 문구용.
 * @param {number | null | undefined} rank
 * @returns {string | null}
 */
export function formatRank(rank) {
  if (rank == null || !Number.isFinite(rank)) {
    return null;
  }
  return `상위 ${rank < 1 ? 1 : Math.round(rank)}%`;
}
