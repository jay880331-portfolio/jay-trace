import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestApplication } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { runRetentionCleanup } from "./jaytrace-retention.js";

const app = await NestFactory.create<NestApplication>(AppModule);
app.useBodyParser("json", { limit: process.env.JAYTRACE_BODY_LIMIT ?? "1mb" });
app.useBodyParser("urlencoded", { limit: process.env.JAYTRACE_BODY_LIMIT ?? "1mb", extended: true });
app.enableCors({
  origin: true,
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["content-type", "traceparent", "x-jaytrace-internal", "x-jaytrace-session"]
});
await app.listen(Number(process.env.PORT ?? 3000));

scheduleRetentionCleanup();

/**
 * Daily retention timer. Only armed when JAYTRACE_RETENTION_DAYS is set. Runs
 * once ~5 minutes after boot, then every 24h. Timers are unref'd so they never
 * hold the process open, and every run is exception-isolated so a cleanup
 * failure can never disrupt collection. Set JAYTRACE_RETENTION_TIMER=0 to
 * disable the in-process timer (Lambda: EventBridge POSTs /internal/retention).
 */
function scheduleRetentionCleanup(): void {
  if (process.env.JAYTRACE_RETENTION_TIMER === "0") {
    return;
  }

  if (!process.env.JAYTRACE_RETENTION_DAYS) {
    return;
  }

  const INITIAL_DELAY_MS = 5 * 60 * 1000;
  const INTERVAL_MS = 24 * 60 * 60 * 1000;

  const run = (): void => {
    void runRetentionCleanup().catch((error: unknown) => {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      process.stderr.write(`[jaytrace] scheduled retention cleanup failed: ${detail}\n`);
    });
  };

  setTimeout(run, INITIAL_DELAY_MS).unref();
  setInterval(run, INTERVAL_MS).unref();
}
