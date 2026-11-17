import assert from "node:assert/strict";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { runDbCleanup } from "./jaytrace-retention.js";
import type { RetentionDbPool, RetentionSummary } from "./jaytrace-retention.js";

// Retention MySQL cleanup, driven through the injected pool so no server is needed.

const CUTOFF = new Date("2026-08-01T00:00:00.000Z");

interface FakeCall {
  sql: string;
  values: unknown[];
}

/** `respond` returns the rows/header for a statement, or an Error to throw. */
function fakePool(respond: (sql: string) => unknown): { pool: RetentionDbPool; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const pool: RetentionDbPool = {
    async query<T extends RowDataPacket[] | ResultSetHeader>(
      sql: string,
      values: unknown[]
    ): Promise<[T, unknown]> {
      calls.push({ sql, values });
      const result = respond(sql);
      if (result instanceof Error) {
        throw result;
      }
      return [result as T, []];
    }
  };
  return { pool, calls };
}

function newSummary(dryRun: boolean): RetentionSummary {
  return {
    enabled: true,
    dryRun,
    retentionDays: 14,
    cutoffIso: CUTOFF.toISOString(),
    s3Listed: 0,
    s3Matched: 0,
    s3Deleted: 0,
    s3Skipped: 0,
    dbDeleted: 0,
    routeStatsDeleted: 0,
    errors: 0
  };
}

function missingTableError(): Error {
  return Object.assign(new Error("Table 'jaytrace.jaytrace_route_stats' doesn't exist"), {
    code: "ER_NO_SUCH_TABLE"
  });
}

// Both tables are deleted in bounded batches; a short batch ends the loop.
{
  const documentBatches = [5000, 12];
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes("jaytrace_route_stats")) {
      return { affectedRows: 3 };
    }
    return { affectedRows: documentBatches.shift() ?? 0 };
  });
  const summary = newSummary(false);
  await runDbCleanup(pool, CUTOFF, false, () => {}, summary);

  assert.equal(summary.dbDeleted, 5012, "documents deleted across two batches");
  assert.equal(summary.routeStatsDeleted, 3, "route stats deleted");
  assert.equal(summary.errors, 0, "no errors");
  assert.equal(calls.length, 3, "two document batches + one route stats batch");

  const routeStatsCall = calls[2];
  assert.ok(routeStatsCall, "route stats statement issued");
  assert.match(
    routeStatsCall.sql,
    /DELETE FROM jaytrace_route_stats WHERE window_start < \? LIMIT 5000/,
    "route stats delete is cutoff-bounded and batched"
  );
  assert.deepEqual(routeStatsCall.values, [CUTOFF], "cutoff is bound, never interpolated");
}

// Dry-run counts without deleting.
{
  const { pool, calls } = fakePool((sql) =>
    sql.includes("jaytrace_route_stats") ? [{ n: 4 }] : [{ n: 7 }]
  );
  const summary = newSummary(true);
  await runDbCleanup(pool, CUTOFF, true, () => {}, summary);

  assert.equal(summary.dbDeleted, 7, "dry-run reports document count");
  assert.equal(summary.routeStatsDeleted, 4, "dry-run reports route stats count");
  assert.equal(summary.errors, 0, "dry-run has no errors");
  assert.ok(
    calls.every((call) => call.sql.startsWith("SELECT COUNT(*)")),
    "dry-run never issues a DELETE"
  );
}

// A table that does not exist yet is 0 rows, not an error.
{
  const lines: string[] = [];
  const { pool } = fakePool((sql) =>
    sql.includes("jaytrace_route_stats") ? missingTableError() : { affectedRows: 2 }
  );
  const summary = newSummary(false);
  await runDbCleanup(pool, CUTOFF, false, (line) => lines.push(line), summary);

  assert.equal(summary.routeStatsDeleted, 0, "missing route stats table deletes nothing");
  assert.equal(summary.errors, 0, "missing table is not counted as an error");
  assert.equal(summary.dbDeleted, 2, "the other table is still cleaned");
  assert.ok(
    lines.some((line) => line.includes("jaytrace_route_stats does not exist")),
    "missing table is logged"
  );
}

// A real failure is counted, logged, and never blocks the other table.
{
  const lines: string[] = [];
  const { pool } = fakePool((sql) =>
    sql.includes("jaytrace_documents") ? new Error("ETIMEDOUT") : { affectedRows: 3 }
  );
  const summary = newSummary(false);
  await runDbCleanup(pool, CUTOFF, false, (line) => lines.push(line), summary);

  assert.equal(summary.errors, 1, "the failure is counted once");
  assert.equal(summary.dbDeleted, 0, "failed table reports nothing deleted");
  assert.equal(summary.routeStatsDeleted, 3, "route stats cleanup still ran");
  assert.ok(
    lines.some((line) => line.includes("table=jaytrace_documents")),
    "the failing table is named in the log"
  );
}

process.stdout.write("nest-api self-check ok\n");
