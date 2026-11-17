import type { JayTraceUser, TraceRow } from "./traces.ts";

// MySQL-backed list source for /api/traces. The collector writes one row per
// document into `example-org.jaytrace_documents` (an index/table of contents),
// so the console can render the list without LIST+GET scanning all of S3.
// Detail views (a single traceId) still read the full documents from S3.
//
// This module never throws to its caller: any connection or query failure
// returns null so the route falls back to the existing S3/local scan path.

export type DbTraceResult = {
  sourceMode: "db+s3";
  source: null;
  localDirs: string[];
  documents: unknown[];
  rawDocumentsRead: number;
  rawDocumentsTruncated: boolean;
  traces: TraceRow[];
};

// Bounded list read — group in Node after fetching the newest rows in-window.
const LIST_ROW_LIMIT = 5000;

const LIST_QUERY = `SELECT trace_id, session_id, user_id, user_name, service, side, schema_name, status, summary, error_name, error_message, started_at, ended_at, created_at
FROM jaytrace_documents
WHERE created_at >= ?
ORDER BY created_at DESC
LIMIT ${LIST_ROW_LIMIT}`;

const STATUS_RANK: Record<string, number> = { ok: 0, warning: 1, error: 2 };

export function isDbMode(): boolean {
  return Boolean(process.env.JAYTRACE_DB_HOST);
}

type QueryablePool = {
  query: (sql: string, values?: unknown[]) => Promise<[unknown[], unknown]>;
};

type DocumentRow = {
  trace_id: string | null;
  session_id: string | null;
  user_id: string | null;
  user_name: string | null;
  service: string | null;
  side: string | null;
  schema_name: string | null;
  status: string | null;
  summary: string | null;
  error_name: string | null;
  error_message: string | null;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  created_at: Date | string | null;
};

// mysql2 is a CommonJS package and only needed when JAYTRACE_DB_HOST is set, so
// import it lazily. createPool does not connect eagerly — bad credentials or an
// unreachable host surface as a rejected query, which the caller treats as a
// fallback signal.
let poolPromise: Promise<QueryablePool> | null = null;

async function getPool(): Promise<QueryablePool> {
  if (!poolPromise) {
    poolPromise = import("mysql2/promise").then(mysql =>
      mysql.createPool({
        host: process.env.JAYTRACE_DB_HOST,
        port: Number(process.env.JAYTRACE_DB_PORT ?? 3306),
        user: process.env.JAYTRACE_DB_USER,
        password: process.env.JAYTRACE_DB_PASSWORD,
        database: process.env.JAYTRACE_DB_DATABASE,
        waitForConnections: true,
        connectionLimit: 4,
        connectTimeout: 5000
      }) as unknown as QueryablePool
    );
  }
  return poolPromise;
}

export async function loadTraceListFromDb(days: number): Promise<DbTraceResult | null> {
  try {
    const pool = await getPool();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [rows] = await pool.query(LIST_QUERY, [since]);
    const documentRows = rows as DocumentRow[];
    return {
      sourceMode: "db+s3",
      source: null,
      localDirs: [],
      documents: [],
      rawDocumentsRead: documentRows.length,
      rawDocumentsTruncated: documentRows.length >= LIST_ROW_LIMIT,
      traces: groupDbRows(documentRows)
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[jaytrace] trace list DB query failed, falling back to S3 scan: ${reason}`);
    return null;
  }
}

// Route latency percentiles read `jaytrace_route_stats`, written by the SDK as one
// row per (service, route, hour window, pod). The histograms are merged in Node —
// the column is JSON, so SUM() can't do it. Same contract as the list loader: never
// throws, and a null result means "no stats available" (DB off, table not created
// yet, or the query failed) rather than an error the caller has to render.
// window_start is stored in UTC, so the window is cut with UTC_TIMESTAMP() on the
// server instead of a client clock.
const STATS_ROW_LIMIT = 5000;

const STATS_QUERY = `SELECT count_total, histogram
FROM jaytrace_route_stats
WHERE service = ? AND route = ? AND window_start >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)
LIMIT ${STATS_ROW_LIMIT}`;

export type RouteStatsRow = { count_total: number | null; histogram: unknown };

export async function loadRouteStatsFromDb(service: string, route: string, hours: number): Promise<RouteStatsRow[] | null> {
  if (!isDbMode()) {
    return null;
  }
  try {
    const pool = await getPool();
    const [rows] = await pool.query(STATS_QUERY, [service, route, hours]);
    return rows as RouteStatsRow[];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[jaytrace] route stats query failed, percentiles hidden: ${reason}`);
    return null;
  }
}

type Accumulator = {
  row: TraceRow;
  statusRank: number;
  hasFront: boolean;
  hasBack: boolean;
  errorSummary?: string;
};

// Fold index rows (one per document) into list-shaped TraceRow summaries. Only
// index columns are available here — front/back/replay bodies are never loaded,
// so those fields stay undefined/empty and are hydrated later on detail reads.
function groupDbRows(rows: DocumentRow[]): TraceRow[] {
  const accumulators = new Map<string, Accumulator>();

  for (const row of rows) {
    const traceId = row.trace_id?.trim();
    if (!traceId) {
      continue;
    }
    const lastSeen = toIso(row.ended_at) ?? toIso(row.created_at) ?? toIso(row.started_at) ?? "";
    const accumulator = accumulators.get(traceId) ?? {
      row: {
        traceId,
        sessionId: row.session_id ?? undefined,
        lastSeen,
        status: "ok",
        services: [],
        summary: "",
        replays: []
      },
      statusRank: 0,
      hasFront: false,
      hasBack: false
    };

    accumulator.row.lastSeen = latest(accumulator.row.lastSeen, lastSeen);
    accumulator.row.sessionId ??= row.session_id ?? undefined;

    const rank = STATUS_RANK[row.status ?? "ok"] ?? 0;
    if (rank > accumulator.statusRank) {
      accumulator.statusRank = rank;
    }

    if (row.service && !accumulator.row.services.includes(row.service)) {
      accumulator.row.services.push(row.service);
    }

    // Console pairing semantics derive from timeline documents only; replay
    // documents never contribute to the front/back pair.
    const isReplay = row.schema_name === "jaytrace.replay.v1";
    if (!isReplay && row.side === "front") {
      accumulator.hasFront = true;
    }
    if (!isReplay && row.side === "back") {
      accumulator.hasBack = true;
    }

    // Representative summary: prefer an error document's message.
    const errorMessage = row.error_message?.trim();
    if (row.status === "error" && errorMessage && !accumulator.errorSummary) {
      accumulator.errorSummary = errorMessage;
    }
    const summary = row.summary?.trim();
    if (summary && !accumulator.row.summary) {
      accumulator.row.summary = summary;
    }

    if (!accumulator.row.user) {
      const user = dbUser(row.user_id, row.user_name);
      if (user) {
        accumulator.row.user = user;
      }
    }

    accumulators.set(traceId, accumulator);
  }

  return [...accumulators.values()]
    .map(({ row, statusRank, hasFront, hasBack, errorSummary }) => {
      let status: TraceRow["status"] = statusRank >= 2 ? "error" : statusRank === 1 ? "warning" : "ok";
      // An unpaired trace is at least a warning, matching the S3 grouping path.
      if (status !== "error" && !(hasFront && hasBack)) {
        status = "warning";
      }
      return { ...row, status, summary: errorSummary ?? row.summary };
    })
    .sort((left, right) => right.lastSeen.localeCompare(left.lastSeen));
}

function dbUser(id: string | null, name: string | null): JayTraceUser | null {
  const trimmedId = id?.trim();
  if (!trimmedId) {
    return null;
  }
  const trimmedName = name?.trim();
  return trimmedName ? { id: trimmedId, name: trimmedName } : { id: trimmedId };
}

function toIso(value: Date | string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function latest(left: string, right: string): string {
  return left.localeCompare(right) >= 0 ? left : right;
}
