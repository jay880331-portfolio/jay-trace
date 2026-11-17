import { runRetentionCleanup } from "./jaytrace-retention.js";

// Manual retention runner: `pnpm --filter @jaytrace/example-nest-api retention`.
// Reads config from env (JAYTRACE_RETENTION_DAYS, JAYTRACE_RETENTION_DRY_RUN,
// JAYTRACE_BUCKET/AWS_REGION/AWS_* creds, JAYTRACE_DB_*). Runs one pass and exits.

runRetentionCleanup()
  .then((summary) => {
    if (!summary.enabled) {
      process.stdout.write(
        "[jaytrace] retention disabled: set JAYTRACE_RETENTION_DAYS to enable cleanup\n"
      );
    }
    process.exit(summary.errors > 0 ? 1 : 0);
  })
  .catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`[jaytrace] retention CLI failed: ${detail}\n`);
    process.exit(1);
  });
