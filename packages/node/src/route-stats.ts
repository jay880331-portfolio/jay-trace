import {
  errorSummary,
  executeSuppressed,
  getSharedPool,
  poolConfigFromEnv,
  positiveInt,
  type DbIndexerValue,
  type MysqlLoader
} from "./db-indexer.js";

/**
 * Upper bounds in milliseconds, inclusive: a request of exactly 100ms lands in the `<= 100` slot.
 * A 15th slot counts everything past the last bound. v1 — never reorder or insert, stored rows
 * from older pods keep the positions they were written with.
 */
export const LATENCY_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000] as const;

const BUCKET_COUNT = LATENCY_BUCKETS_MS.length + 1;

/** Aggregation window: one UTC hour. */
const WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_FLUSH_MS = 60_000;
/** Windows older than this many windows back are dropped from memory (they were already flushed). */
const KEEP_WINDOWS = 2;
/** Distinct routes tracked per window; everything past it is summed into `__other__`. */
const MAX_ROUTES_PER_WINDOW = 200;

export const UNKNOWN_ROUTE = "__unknown__";
export const OTHER_ROUTE = "__other__";

const DEFAULT_SERVICE = "api";
const SERVICE_MAX_CHARS = 64;
const ROUTE_MAX_CHARS = 255;
const POD_MAX_CHARS = 128;

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS jaytrace_route_stats (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  service VARCHAR(64) NOT NULL,
  route VARCHAR(255) NOT NULL,
  window_start DATETIME NOT NULL,
  pod VARCHAR(128) NOT NULL DEFAULT '',
  count_total INT NOT NULL,
  count_error INT NOT NULL,
  sum_ms DOUBLE NOT NULL,
  histogram JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stat (service, route, window_start, pod),
  KEY idx_window (window_start)
)`;

const UPSERT_HEAD = `INSERT INTO jaytrace_route_stats
  (service, route, window_start, pod, count_total, count_error, sum_ms, histogram)
  VALUES `;
// 8 placeholders, one per column in UPSERT_HEAD. window_start is bound as epoch seconds and
// added to the epoch literal in SQL: a bound Date would be serialised in the connection's local
// timezone, which shifts every hour boundary on a non-UTC pod.
const ROW_PLACEHOLDERS = "(?, ?, DATE_ADD('1970-01-01 00:00:00', INTERVAL ? SECOND), ?, ?, ?, ?, ?)";
// The counters are pod-local and monotonic, so the newest snapshot is always the whole truth:
// replacing the row is both correct and idempotent, unlike `count_total = count_total + ?`.
// VALUES() rather than the row-alias form: the alias syntax needs MySQL 8.0.19+.
const UPSERT_TAIL = `
  ON DUPLICATE KEY UPDATE
    count_total = VALUES(count_total),
    count_error = VALUES(count_error),
    sum_ms = VALUES(sum_ms),
    histogram = VALUES(histogram)`;

/** What the trace buffer needs: one call per finished root span. */
export interface RouteStatsRecorder {
  record(service: string | undefined, route: string | undefined, durationMs: number, failed: boolean): void;
  /** Writes whatever is pending. Never throws. */
  flush?(): Promise<void>;
}

export interface RouteStats extends RouteStatsRecorder {
  flush(): Promise<void>;
  /** Stops the flush timer. */
  stop(): void;
  /** Windows currently held in memory — the seam the self-check reads the pruning rule through. */
  windowCount(): number;
}

export interface RouteStatsOptions {
  env?: Record<string, string | undefined>;
  load?: MysqlLoader;
  /** Clock seam; the self-check moves it to cross a window boundary without waiting an hour. */
  now?: () => number;
}

interface Agg {
  service: string;
  countTotal: number;
  countError: number;
  sumMs: number;
  histogram: number[];
  /** Set on every record, cleared when the row is put into a flush batch. */
  dirty: boolean;
}

type Row = [
  string, // service
  string, // route
  number, // window_start, epoch seconds (UTC)
  string, // pod
  number, // count_total
  number, // count_error
  number, // sum_ms
  string // histogram (JSON)
];

/**
 * In-process latency histogram per (route, hour), flushed to MySQL on a timer.
 *
 * Every root span is counted, exported or not: error documents alone have no denominator, so
 * a p95 needs the healthy requests too. Returns null when the database env is missing or
 * JAYTRACE_STATS=0 — collecting with nowhere to write it is pure overhead.
 *
 * Nothing here throws back into the request path, and every query runs tracing-suppressed:
 * the host app instruments mysql2, so an unsuppressed INSERT would trace itself into a loop.
 */
export function createRouteStats(options: RouteStatsOptions = {}): RouteStats | null {
  const env = options.env ?? process.env;
  if (env.JAYTRACE_STATS === "0") {
    return null;
  }
  const config = poolConfigFromEnv(env);
  if (!config) {
    return null;
  }

  const now = options.now ?? Date.now;
  const pod = (env.HOSTNAME ?? "").slice(0, POD_MAX_CHARS);

  // window start (epoch ms) -> route -> counters
  const windows = new Map<number, Map<string, Agg>>();
  let disabled = false;
  let warned = false;
  let flushing = false;
  let tableReady = false;

  const takeDirty = (): Row[] => {
    const rows: Row[] = [];
    for (const [windowStart, routes] of windows) {
      for (const [route, agg] of routes) {
        if (!agg.dirty) {
          continue;
        }
        agg.dirty = false;
        rows.push([
          agg.service,
          route,
          windowStart / 1000,
          pod,
          agg.countTotal,
          agg.countError,
          agg.sumMs,
          JSON.stringify(agg.histogram)
        ]);
      }
    }
    return rows;
  };

  /** Drops windows that can no longer receive records; without this a long-lived pod grows forever. */
  const prune = (): void => {
    const cutoff = windowStartOf(now()) - KEEP_WINDOWS * WINDOW_MS;
    for (const [windowStart, routes] of windows) {
      if (windowStart < cutoff && ![...routes.values()].some((agg) => agg.dirty)) {
        windows.delete(windowStart);
      }
    }
  };

  const flush = async (): Promise<void> => {
    if (disabled || flushing) {
      return;
    }
    flushing = true;
    try {
      const rows = takeDirty();
      prune();
      if (rows.length === 0) {
        return;
      }
      const pool = await getSharedPool(config, options.load);
      if (!pool) {
        // openPool already warned; a pool that never opened is not coming back.
        disabled = true;
        return;
      }
      if (!tableReady) {
        await executeSuppressed(pool, CREATE_TABLE, []);
        tableReady = true;
      }
      const sql = UPSERT_HEAD + rows.map(() => ROW_PLACEHOLDERS).join(",\n  ") + UPSERT_TAIL;
      await executeSuppressed(pool, sql, rows.flat() as DbIndexerValue[]);
    } catch (error: unknown) {
      // Lossy on purpose: the dropped window is worth less than a retry queue that grows unbounded.
      if (!warned) {
        warned = true;
        process.stderr.write(`[jaytrace] route stats flush failed: ${errorSummary(error)}\n`);
      }
    } finally {
      flushing = false;
    }
  };

  const timer = setInterval(() => {
    void flush();
  }, positiveInt(env.JAYTRACE_STATS_FLUSH_MS, DEFAULT_FLUSH_MS));
  timer.unref?.();

  return {
    record(service, route, durationMs, failed): void {
      if (disabled) {
        return;
      }
      const windowStart = windowStartOf(now());
      let routes = windows.get(windowStart);
      if (!routes) {
        routes = new Map<string, Agg>();
        windows.set(windowStart, routes);
      }

      let key = (route ?? UNKNOWN_ROUTE).slice(0, ROUTE_MAX_CHARS);
      if (!routes.has(key) && routes.size >= MAX_ROUTES_PER_WINDOW) {
        key = OTHER_ROUTE;
      }
      let agg = routes.get(key);
      if (!agg) {
        agg = {
          service: DEFAULT_SERVICE,
          countTotal: 0,
          countError: 0,
          sumMs: 0,
          histogram: new Array<number>(BUCKET_COUNT).fill(0),
          dirty: false
        };
        routes.set(key, agg);
      }

      const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
      const bucket = bucketIndex(ms);
      agg.service = (service ?? DEFAULT_SERVICE).slice(0, SERVICE_MAX_CHARS);
      agg.countTotal += 1;
      agg.countError += failed ? 1 : 0;
      agg.sumMs += ms;
      agg.histogram[bucket] = (agg.histogram[bucket] ?? 0) + 1;
      agg.dirty = true;
    },

    flush,

    stop(): void {
      clearInterval(timer);
    },

    windowCount(): number {
      return windows.size;
    }
  };
}

/**
 * Process-wide collector, built on first use. JAYTRACE_DB_* can be injected after boot (the host app
 * loads secrets late), so a null result stays retryable instead of being memoized for good.
 */
let shared: RouteStats | null | undefined;
export function getRouteStats(): RouteStats | null {
  shared ??= createRouteStats();
  return shared ?? null;
}

/** Test seam: forgets the process-wide collector. */
export function resetRouteStats(): void {
  shared?.stop();
  shared = undefined;
}

/** Index of the first bucket whose upper bound covers this duration; the last slot is the overflow. */
export function bucketIndex(durationMs: number): number {
  for (const [index, bound] of LATENCY_BUCKETS_MS.entries()) {
    if (durationMs <= bound) {
      return index;
    }
  }
  return LATENCY_BUCKETS_MS.length;
}

function windowStartOf(atMs: number): number {
  return Math.floor(atMs / WINDOW_MS) * WINDOW_MS;
}
