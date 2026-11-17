import { createPool } from "mysql2/promise";
import type { Pool } from "mysql2/promise";

/** One row written per successfully exported document — the "table of contents" for S3. */
export interface JayTraceDbIndexer {
  indexDocument(info: { key: string; side: string; document: Record<string, unknown> }): void;
}

const DB_CONNECTION_LIMIT = 4;
const MAX_SUMMARY_LENGTH = 512;

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_MS = 2000;

const INSERT_HEAD = `INSERT INTO jaytrace_documents
  (trace_id, session_id, user_id, user_name, service, side, schema_name, status, summary, error_name, error_message, started_at, ended_at, s3_key)
  VALUES `;
// 14 placeholders, one per column in INSERT_HEAD.
const ROW_PLACEHOLDERS = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/**
 * Builds a MySQL metadata indexer from JAYTRACE_DB_* env vars. Returns null when the
 * connection env is not configured, so collection runs unchanged without a database.
 */
export function createJayTraceDbIndexer(
  env: Record<string, string | undefined> = process.env
): JayTraceDbIndexer | null {
  const host = env.JAYTRACE_DB_HOST;
  const user = env.JAYTRACE_DB_USER;
  const database = env.JAYTRACE_DB_DATABASE;
  if (!host || !user || !database) {
    return null;
  }

  const pool: Pool = createPool({
    host,
    port: env.JAYTRACE_DB_PORT ? Number(env.JAYTRACE_DB_PORT) : 3306,
    user,
    password: env.JAYTRACE_DB_PASSWORD,
    database,
    connectionLimit: DB_CONNECTION_LIMIT,
    waitForConnections: true
  });

  const batchSize = positiveInt(env.JAYTRACE_DB_BATCH_SIZE, DEFAULT_BATCH_SIZE);
  const flushMs = positiveInt(env.JAYTRACE_DB_FLUSH_MS, DEFAULT_FLUSH_MS);
  const debug = Boolean(env.JAYTRACE_DB_DEBUG);

  // Rows accumulate here until the batch fills or the flush timer fires. A single
  // multi-row INSERT then drains the buffer; rows added mid-flush land in the next batch.
  let buffer: Row[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) {
      return;
    }
    const batch = buffer;
    buffer = [];
    // Fire-and-forget: an INSERT must never block or break the collection path.
    void writeBatch(pool, batch, debug);
  };

  registerFlushOnExit(flush);

  return {
    indexDocument({ key, side, document }): void {
      buffer.push(buildRow(key, side, document));
      if (buffer.length >= batchSize) {
        flush();
        return;
      }
      // Debounce: (re)arm the timer so a quiet buffer drains flushMs after the last add.
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(flush, flushMs);
      timer.unref?.();
    }
  };
}

/**
 * Writes one batch as a single parameterized multi-row INSERT. Values are always bound
 * as parameters — never string-interpolated. On failure the batch is retried once, then
 * dropped with a single credential-free warning so the collection path stays lossy-but-alive.
 */
async function writeBatch(pool: Pool, batch: Row[], debug: boolean): Promise<void> {
  const sql = INSERT_HEAD + batch.map(() => ROW_PLACEHOLDERS).join(",\n  ");
  const params = batch.flat();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await pool.execute(sql, params);
      if (debug) {
        process.stderr.write(`[jaytrace] mysql batch insert ok: rows=${batch.length}\n`);
      }
      return;
    } catch (error: unknown) {
      if (attempt === 1) {
        process.stderr.write(
          `[jaytrace] mysql index batch insert failed (rows=${batch.length}): ${errorSummary(error)}\n`
        );
      }
    }
  }
}

/** Best-effort final flush on shutdown. Registered once; every step is exception-isolated. */
function registerFlushOnExit(flush: () => void): void {
  const onSignal = (): void => {
    try {
      flush();
    } catch {
      // Best-effort only: never let a shutdown flush throw.
    }
  };
  try {
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  } catch {
    // Signal registration is optional; ignore environments that disallow it.
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

type Row = [
  string | null, // trace_id
  string | null, // session_id
  string | null, // user_id
  string | null, // user_name
  string | null, // service
  string | null, // side
  string | null, // schema_name
  string, // status
  string | null, // summary
  string | null, // error_name
  string | null, // error_message
  Date | null, // started_at
  Date | null, // ended_at
  string | null // s3_key
];

function buildRow(key: string, side: string, document: Record<string, unknown>): Row {
  const schema = asString(document.schema);
  const isTimeline = schema?.startsWith("jaytrace.timeline") ?? false;
  const error = isRecord(document.error) ? document.error : undefined;
  const user = resolveUser(document);

  return [
    asString(document.traceId) ?? null,
    asString(document.sessionId) ?? null,
    user.id,
    user.name,
    asString(document.service) ?? null,
    side || null,
    schema ?? null,
    resolveStatus(isTimeline, error, document),
    truncate(asString(document.summary), MAX_SUMMARY_LENGTH),
    error ? asString(error.name) ?? null : null,
    error ? asString(error.message) ?? null : null,
    toDate(document.startedAt),
    toDate(document.endedAt),
    key || null
  ];
}

function resolveUser(document: Record<string, unknown>): { id: string | null; name: string | null } {
  // Timeline documents carry a nested user object.
  if (isRecord(document.user)) {
    return {
      id: asString(document.user.id) ?? null,
      name: asString(document.user.name) ?? null
    };
  }
  // Replay documents carry flat "user.id" / "user.name" keys inside metadata.
  if (isRecord(document.metadata)) {
    return {
      id: asString(document.metadata["user.id"]) ?? null,
      name: asString(document.metadata["user.name"]) ?? null
    };
  }
  return { id: null, name: null };
}

function resolveStatus(
  isTimeline: boolean,
  error: Record<string, unknown> | undefined,
  document: Record<string, unknown>
): string {
  if (!isTimeline) {
    return "ok";
  }
  if (error) {
    return "error";
  }
  const events = Array.isArray(document.events) ? document.events : [];
  const hasWarning = events.some(
    (event) => isRecord(event) && event.severity === "warn"
  );
  return hasWarning ? "warning" : "ok";
}

function toDate(value: unknown): Date | null {
  const text = asString(value);
  if (!text) {
    return null;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function truncate(value: string | undefined, max: number): string | null {
  if (value === undefined) {
    return null;
  }
  return value.length > max ? value.slice(0, max) : value;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Error text stripped to name + message so DB credentials never leak into logs. */
function errorSummary(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
