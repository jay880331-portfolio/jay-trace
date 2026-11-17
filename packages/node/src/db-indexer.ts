import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";

/** Everything a jaytrace_documents column can be bound to. */
export type DbIndexerValue = string | number | Date | null;

/** Minimal shape of the mysql2 pool this module uses — keeps mysql2 types out of the .d.ts. */
export interface DbIndexerPool {
  execute(sql: string, params: DbIndexerValue[]): Promise<unknown>;
}

export interface DbIndexerPoolConfig {
  host: string;
  port: number;
  user: string;
  password: string | undefined;
  database: string;
  connectionLimit: number;
  waitForConnections: boolean;
}

/** Seam for the lazy `mysql2/promise` import — replaced in tests. */
export type MysqlLoader = () => Promise<{ createPool(config: DbIndexerPoolConfig): DbIndexerPool }>;

/** One row written per successfully exported document — the "table of contents" for S3. */
export interface NodeDbIndexer {
  indexDocument(info: { key: string; side: string; document: Record<string, unknown> }): void;
  /** Flushes the buffer and awaits in-flight inserts. Never throws. */
  drain(): Promise<void>;
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

// mysql2 is an optional peer: apps that only upload to S3 must not need it installed, so the
// import stays inside the function and only runs when a document is actually indexed.
const defaultLoader: MysqlLoader = async () => {
  const { createPool } = await import("mysql2/promise");
  return { createPool: (config) => createPool(config) };
};

/** JAYTRACE_DB_* -> pool config. null while the connection env is not (yet) configured. */
export function poolConfigFromEnv(env: Record<string, string | undefined>): DbIndexerPoolConfig | null {
  const host = env.JAYTRACE_DB_HOST;
  const user = env.JAYTRACE_DB_USER;
  const database = env.JAYTRACE_DB_DATABASE;
  if (!host || !user || !database) {
    return null;
  }
  return {
    host,
    port: env.JAYTRACE_DB_PORT ? Number(env.JAYTRACE_DB_PORT) : 3306,
    user,
    password: env.JAYTRACE_DB_PASSWORD,
    database,
    connectionLimit: DB_CONNECTION_LIMIT,
    waitForConnections: true
  };
}

/**
 * One pool per process, shared by the document indexer and the route-stats flusher: they read the
 * same JAYTRACE_DB_* env, and a second pool would double the connections every pod holds open.
 * Built on first use — mysql2 is an optional peer, so a missing install costs nothing until a
 * query actually needs it. The first caller's config wins.
 */
let sharedPool: Promise<DbIndexerPool | null> | undefined;

export function getSharedPool(config: DbIndexerPoolConfig, load: MysqlLoader = defaultLoader): Promise<DbIndexerPool | null> {
  sharedPool ??= openPool(load, config);
  return sharedPool;
}

/** Test seam: forgets the memoized pool so the next caller's loader is used. */
export function resetSharedPool(): void {
  sharedPool = undefined;
}

/**
 * The host app instruments mysql2, so an untraced-by-hand query of ours becomes a client span.
 * The flush runs off a timer with no active span, so that span would be a root of its own ->
 * document -> INSERT -> root: a failing query would feed itself error documents without bound.
 */
export async function executeSuppressed(pool: DbIndexerPool, sql: string, params: DbIndexerValue[]): Promise<void> {
  await context.with(suppressTracing(context.active()), () => pool.execute(sql, params));
}

/**
 * Builds a MySQL metadata indexer from JAYTRACE_DB_* env vars. Returns null when the
 * connection env is not configured, so tracing runs unchanged without a database.
 *
 * Nothing here ever throws back into the export path: a missing mysql2, a dead database or a
 * rejected INSERT all degrade to a stderr warning and dropped rows.
 *
 * Unlike the collector this registers no SIGTERM/SIGINT handler: a library that adds the first
 * signal listener to a host process silently cancels Node's default "terminate on SIGTERM", which
 * would leave pods hanging until SIGKILL. Shutdown flushing belongs to the host, via drain().
 */
export function createNodeDbIndexer(
  env: Record<string, string | undefined> = process.env,
  load: MysqlLoader = defaultLoader
): NodeDbIndexer | null {
  const config = poolConfigFromEnv(env);
  if (!config) {
    return null;
  }

  const batchSize = positiveInt(env.JAYTRACE_DB_BATCH_SIZE, DEFAULT_BATCH_SIZE);
  const flushMs = positiveInt(env.JAYTRACE_DB_FLUSH_MS, DEFAULT_FLUSH_MS);
  const debug = Boolean(env.JAYTRACE_DB_DEBUG);

  // Rows accumulate here until the batch fills or the flush timer fires. A single
  // multi-row INSERT then drains the buffer; rows added mid-flush land in the next batch.
  let buffer: Row[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disabled = false;

  const pending = new Set<Promise<void>>();
  const track = (promise: Promise<void>): void => {
    pending.add(promise);
    void promise.finally(() => {
      pending.delete(promise);
    });
  };

  // The pool is opened on the first flush, not here: mysql2 is imported lazily so a missing
  // optional peer costs nothing until a document actually needs indexing.
  const getPool = (): Promise<DbIndexerPool | null> => getSharedPool(config, load);

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
    // Fire-and-forget: an INSERT must never block or break the export path.
    track(
      writeBatch(getPool, batch, debug).then((ok) => {
        // A pool that never opened is not coming back; stop paying for row building.
        disabled ||= !ok;
      })
    );
  };

  return {
    indexDocument({ key, side, document }): void {
      if (disabled) {
        return;
      }
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
    },

    async drain(): Promise<void> {
      flush();
      await Promise.allSettled([...pending]);
    }
  };
}

/** Resolves the mysql2 pool once. Any failure disables indexing with a single warning. */
async function openPool(
  load: MysqlLoader,
  config: DbIndexerPoolConfig
): Promise<DbIndexerPool | null> {
  let mysql: { createPool(config: DbIndexerPoolConfig): DbIndexerPool };
  try {
    mysql = await load();
  } catch {
    process.stderr.write("[jaytrace] db indexer disabled: mysql2 not installed\n");
    return null;
  }
  try {
    return mysql.createPool(config);
  } catch (error: unknown) {
    process.stderr.write(`[jaytrace] db indexer disabled: ${errorSummary(error)}\n`);
    return null;
  }
}

/**
 * Writes one batch as a single parameterized multi-row INSERT. Values are always bound
 * as parameters — never string-interpolated. On failure the batch is retried once, then
 * dropped with a single credential-free warning so the export path stays lossy-but-alive.
 *
 * Returns false only when the pool itself is unavailable (indexing is off for good).
 */
async function writeBatch(
  getPool: () => Promise<DbIndexerPool | null>,
  batch: Row[],
  debug: boolean
): Promise<boolean> {
  const pool = await getPool();
  if (!pool) {
    return false;
  }

  const sql = INSERT_HEAD + batch.map(() => ROW_PLACEHOLDERS).join(",\n  ");
  const params = batch.flat();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await executeSuppressed(pool, sql, params);
      if (debug) {
        process.stderr.write(`[jaytrace] mysql batch insert ok: rows=${batch.length}\n`);
      }
      return true;
    } catch (error: unknown) {
      if (attempt === 1) {
        process.stderr.write(
          `[jaytrace] mysql index batch insert failed (rows=${batch.length}): ${errorSummary(error)}\n`
        );
      }
    }
  }
  return true;
}

export function positiveInt(value: string | undefined, fallback: number): number {
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
    // The console pairs front/back on `side === "back"` exactly, so the document's own side wins
    // over the S3 filename stem (`back-shop-api`), which only exists to keep keys unique.
    asString(document.side) ?? (side || null),
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
export function errorSummary(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
