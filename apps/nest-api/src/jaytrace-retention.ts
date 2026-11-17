import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client
} from "@aws-sdk/client-s3";
import { createPool } from "mysql2/promise";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

// JayTrace retention cleanup. Deletes JayTrace-owned S3 objects and MySQL index
// rows older than JAYTRACE_RETENTION_DAYS.
//
// SAFETY: example-shared-bucket is a shared bucket. We never touch bucket lifecycle
// config and never do a broad delete. Only keys that match the exact JayTrace
// key shape (strict regex below) are ever deleted; anything else is counted,
// logged, and left untouched. The scan is bounded to a finite window of past
// date partitions so a run can never walk the whole bucket.

const DEFAULT_SCAN_DAYS = 60;
const S3_DELETE_BATCH_SIZE = 1000;
const S3_LIST_MAX_KEYS = 1000;
const DB_DELETE_BATCH_SIZE = 5000;
const DB_CONNECTION_LIMIT = 2;
const MS_PER_DAY = 86_400_000;

export interface RetentionOptions {
  /** Env source, defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** "Now" reference for cutoff math, defaults to new Date(). */
  now?: Date;
  /** Line logger, defaults to stdout. */
  log?: (line: string) => void;
}

/** The slice of mysql2's Pool the cleanup needs. Narrow so the self-check can pass a fake. */
export interface RetentionDbPool {
  query<T extends RowDataPacket[] | ResultSetHeader>(
    sql: string,
    values: unknown[]
  ): Promise<[T, unknown]>;
}

export interface RetentionSummary {
  enabled: boolean;
  dryRun: boolean;
  retentionDays: number | null;
  cutoffIso: string | null;
  /** Objects seen while listing scanned date partitions. */
  s3Listed: number;
  /** Objects matching the strict JayTrace key pattern (delete candidates). */
  s3Matched: number;
  /** Objects actually deleted (0 in dry-run). */
  s3Deleted: number;
  /** Objects that did NOT match the pattern and were preserved. */
  s3Skipped: number;
  /** jaytrace_documents rows deleted (dry-run reports the count without deleting). */
  dbDeleted: number;
  /** jaytrace_route_stats rows deleted (dry-run reports the count without deleting). */
  routeStatsDeleted: number;
  /** Non-fatal errors encountered (S3/DB). */
  errors: number;
}

/**
 * Runs one retention pass. Returns a summary and never throws — each side
 * (S3, MySQL) is isolated so one failure cannot abort the other, and callers
 * (the collector timer, the CLI) can react to summary.errors instead.
 */
export async function runRetentionCleanup(
  opts: RetentionOptions = {}
): Promise<RetentionSummary> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const log = opts.log ?? ((line) => process.stdout.write(line.endsWith("\n") ? line : `${line}\n`));

  const summary: RetentionSummary = {
    enabled: false,
    dryRun: false,
    retentionDays: null,
    cutoffIso: null,
    s3Listed: 0,
    s3Matched: 0,
    s3Deleted: 0,
    s3Skipped: 0,
    dbDeleted: 0,
    routeStatsDeleted: 0,
    errors: 0
  };

  const retentionDays = parseRetentionDays(env.JAYTRACE_RETENTION_DAYS);
  if (retentionDays === null) {
    // Feature fully disabled when unset/invalid.
    return summary;
  }

  const dryRun = env.JAYTRACE_RETENTION_DRY_RUN === "1";
  const cutoff = new Date(now.getTime() - retentionDays * MS_PER_DAY);

  summary.enabled = true;
  summary.dryRun = dryRun;
  summary.retentionDays = retentionDays;
  summary.cutoffIso = cutoff.toISOString();

  await cleanupS3(env, cutoff, dryRun, log, summary);
  await cleanupDb(env, cutoff, dryRun, log, summary);

  log(
    `[jaytrace] retention cleanup ${dryRun ? "(dry-run) " : ""}complete: ` +
      `retentionDays=${retentionDays} cutoff=${summary.cutoffIso} ` +
      `s3Listed=${summary.s3Listed} s3Matched=${summary.s3Matched} ` +
      `s3Deleted=${summary.s3Deleted} s3Skipped(preserved)=${summary.s3Skipped} ` +
      `dbDeleted=${summary.dbDeleted} routeStatsDeleted=${summary.routeStatsDeleted} ` +
      `errors=${summary.errors}`
  );

  return summary;
}

async function cleanupS3(
  env: Record<string, string | undefined>,
  cutoff: Date,
  dryRun: boolean,
  log: (line: string) => void,
  summary: RetentionSummary
): Promise<void> {
  const bucket = env.JAYTRACE_BUCKET;
  const region = env.AWS_REGION;
  if (!bucket || !region) {
    log("[jaytrace] retention: S3 cleanup skipped (JAYTRACE_BUCKET/AWS_REGION not set)");
    return;
  }

  const prefix = env.JAYTRACE_S3_PREFIX ?? "production";
  const scanDays = parsePositiveInt(env.JAYTRACE_RETENTION_SCAN_DAYS) ?? DEFAULT_SCAN_DAYS;
  const keyPattern = buildKeyPattern(prefix);

  // Cutoff aligned to UTC midnight. We only touch date partitions strictly
  // before the cutoff day, so today's live data is never in range.
  const cutoffMidnightMs = Date.UTC(
    cutoff.getUTCFullYear(),
    cutoff.getUTCMonth(),
    cutoff.getUTCDate()
  );

  const client = new S3Client({ region });
  try {
    for (let dayOffset = 1; dayOffset <= scanDays; dayOffset += 1) {
      const day = new Date(cutoffMidnightMs - dayOffset * MS_PER_DAY);
      const yyyy = String(day.getUTCFullYear());
      const mm = String(day.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(day.getUTCDate()).padStart(2, "0");
      const datePrefix = `${prefix}/${yyyy}/${mm}/${dd}/`;

      const toDelete = await listDeletableKeys(
        client,
        bucket,
        datePrefix,
        keyPattern,
        log,
        summary
      );

      if (toDelete.length === 0) {
        continue;
      }

      if (dryRun) {
        for (const key of toDelete) {
          log(`[jaytrace] retention: (dry-run) would delete s3://${bucket}/${key}`);
        }
        continue;
      }

      await deleteKeysInBatches(client, bucket, toDelete, log, summary);
    }
  } catch (error: unknown) {
    summary.errors += 1;
    log(`[jaytrace] retention: S3 cleanup error ${errorText(error)}`);
  } finally {
    client.destroy();
  }
}

async function listDeletableKeys(
  client: S3Client,
  bucket: string,
  datePrefix: string,
  keyPattern: RegExp,
  log: (line: string) => void,
  summary: RetentionSummary
): Promise<string[]> {
  const toDelete: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: datePrefix,
        MaxKeys: S3_LIST_MAX_KEYS,
        ContinuationToken: continuationToken
      })
    );

    for (const object of response.Contents ?? []) {
      const key = object.Key;
      if (!key) {
        continue;
      }
      summary.s3Listed += 1;
      if (keyPattern.test(key)) {
        summary.s3Matched += 1;
        toDelete.push(key);
      } else {
        // Not a JayTrace-shaped key — never delete it, just warn.
        summary.s3Skipped += 1;
        log(`[jaytrace] retention: WARNING preserved non-JayTrace key: s3://${bucket}/${key}`);
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return toDelete;
}

async function deleteKeysInBatches(
  client: S3Client,
  bucket: string,
  keys: string[],
  log: (line: string) => void,
  summary: RetentionSummary
): Promise<void> {
  for (let start = 0; start < keys.length; start += S3_DELETE_BATCH_SIZE) {
    const chunk = keys.slice(start, start + S3_DELETE_BATCH_SIZE);
    const response = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: chunk.map((Key) => ({ Key })),
          Quiet: true
        }
      })
    );

    const failed = response.Errors ?? [];
    summary.s3Deleted += chunk.length - failed.length;
    for (const failure of failed) {
      summary.errors += 1;
      log(
        `[jaytrace] retention: S3 delete failed key=${failure.Key ?? "?"} ` +
          `code=${failure.Code ?? "?"} message=${failure.Message ?? "?"}`
      );
    }
  }
}

async function cleanupDb(
  env: Record<string, string | undefined>,
  cutoff: Date,
  dryRun: boolean,
  log: (line: string) => void,
  summary: RetentionSummary
): Promise<void> {
  const host = env.JAYTRACE_DB_HOST;
  const user = env.JAYTRACE_DB_USER;
  const database = env.JAYTRACE_DB_DATABASE;
  if (!host || !user || !database) {
    log("[jaytrace] retention: MySQL cleanup skipped (JAYTRACE_DB_* not set)");
    return;
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

  try {
    await runDbCleanup(pool, cutoff, dryRun, log, summary);
  } finally {
    await pool.end();
  }
}

/**
 * Cleans every JayTrace-owned table. Exported (and pool-injected) so the
 * self-check can drive it without a MySQL server. Each table is isolated: one
 * table failing never skips the next one, and nothing throws.
 */
export async function runDbCleanup(
  pool: RetentionDbPool,
  cutoff: Date,
  dryRun: boolean,
  log: (line: string) => void,
  summary: RetentionSummary
): Promise<void> {
  summary.dbDeleted = await cleanupTable(
    pool,
    "jaytrace_documents",
    "created_at",
    cutoff,
    dryRun,
    log,
    summary
  );
  summary.routeStatsDeleted = await cleanupTable(
    pool,
    "jaytrace_route_stats",
    "window_start",
    cutoff,
    dryRun,
    log,
    summary
  );
}

/** Table/column names are module constants, never user input — safe to interpolate. */
async function cleanupTable(
  pool: RetentionDbPool,
  table: string,
  column: string,
  cutoff: Date,
  dryRun: boolean,
  log: (line: string) => void,
  summary: RetentionSummary
): Promise<number> {
  try {
    if (dryRun) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} < ?`,
        [cutoff]
      );
      const count = Number(rows[0]?.n ?? 0);
      log(
        `[jaytrace] retention: (dry-run) would delete ${count} MySQL rows ` +
          `from ${table} older than ${cutoff.toISOString()}`
      );
      return count;
    }

    let total = 0;
    // Delete in bounded batches until a batch comes back short (nothing left).
    for (;;) {
      const [result] = await pool.query<ResultSetHeader>(
        `DELETE FROM ${table} WHERE ${column} < ? LIMIT ${DB_DELETE_BATCH_SIZE}`,
        [cutoff]
      );
      const affected = result.affectedRows ?? 0;
      total += affected;
      if (affected < DB_DELETE_BATCH_SIZE) {
        break;
      }
    }
    return total;
  } catch (error: unknown) {
    if (isMissingTable(error)) {
      // Table not created yet (e.g. no service on @jaytrace/node 0.1.4+ has
      // written route stats here): nothing to clean, not an error.
      log(`[jaytrace] retention: ${table} does not exist, nothing to clean`);
      return 0;
    }
    summary.errors += 1;
    log(`[jaytrace] retention: MySQL cleanup error table=${table} ${errorText(error)}`);
    return 0;
  }
}

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ER_NO_SUCH_TABLE";
}

/**
 * Strict JayTrace key matcher. Only keys of the exact shape
 *   <prefix>/<yyyy>/<mm>/<dd>/<traceId 32 hex>/<side>-<iso stamp>.json
 * are considered deletable. Anything else is preserved.
 * replay v2 세그먼트의 -seqN 접미사 포함
 */
function buildKeyPattern(prefix: string): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escaped}/\\d{4}/\\d{2}/\\d{2}/[0-9a-f]{32}/[a-z0-9-]+-[0-9TZ-]+(-seq\\d+)?\\.json$`
  );
}

function parseRetentionDays(raw: string | undefined): number | null {
  return parsePositiveInt(raw);
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
