import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import { JayTraceMetrics } from "./metrics.js";
import { buildS3Key } from "./s3-key.js";
import type { ExportInput, JayTraceExporter, JayTraceExportOptions } from "./exporter-types.js";

const DEFAULT_MAX_IN_FLIGHT_EXPORTS = 100;
const DEFAULT_EXPORT_BATCH_SIZE = 25;
const DEFAULT_EXPORT_FLUSH_MS = 50;

export class S3JayTraceExporter implements JayTraceExporter {
  private readonly client: S3Client;
  private readonly queue: ExportInput[] = [];
  private readonly pending = new Set<Promise<void>>();
  private inFlight = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly options: JayTraceExportOptions,
    private readonly metrics: JayTraceMetrics = new JayTraceMetrics()
  ) {
    this.client = new S3Client({
      region: options.s3.region,
      ...options.s3.clientConfig
    });
  }

  export(input: ExportInput): void {
    this.queue.push(input);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.queue.length >= (this.options.exportBatchSize ?? DEFAULT_EXPORT_BATCH_SIZE)) {
      this.flushQueue();
      return;
    }

    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      this.flushQueue();
    }, this.options.exportFlushMs ?? DEFAULT_EXPORT_FLUSH_MS);
  }

  private flushQueue(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    const batch = this.queue.splice(0, this.options.exportBatchSize ?? DEFAULT_EXPORT_BATCH_SIZE);
    for (const input of batch) {
      this.startExport(input);
    }

    if (this.queue.length > 0) {
      this.scheduleFlush();
    }
  }

  private startExport(input: ExportInput): void {
    if (this.inFlight >= (this.options.maxInFlightExports ?? DEFAULT_MAX_IN_FLIGHT_EXPORTS)) {
      this.metrics.inc("exportBackpressure");
      this.track(this.spool(input, new Error("JayTrace in-flight export limit exceeded")).catch((spoolError: unknown) => {
        process.stderr.write(`[jaytrace] export backpressure spool failed ${errorText(spoolError)}\n`);
      }));
      return;
    }

    this.inFlight += 1;
    this.track(this.upload(input).then(() => {
      this.metrics.inc("exportSent");
    }).catch((error: unknown) => {
      this.metrics.inc("exportFailed");
      this.track(this.spool(input, error).then(() => {
        this.metrics.inc("exportSpooled");
      }).catch((spoolError: unknown) => {
        process.stderr.write(`[jaytrace] export failed ${errorText(error)} spool failed ${errorText(spoolError)}\n`);
      }));
    }).finally(() => {
      this.inFlight -= 1;
    }));
  }

  /** Tracks a settled-terminated promise so drain() can await in-flight work. */
  private track(promise: Promise<void>): void {
    this.pending.add(promise);
    void promise.finally(() => {
      this.pending.delete(promise);
    });
  }

  /**
   * Awaits all in-flight exports (and any spool fallbacks they trigger). For
   * serverless hosts that must guarantee export completion before the response
   * returns. Never throws — failures still route through the spool path.
   */
  async drain(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    do {
      while (this.queue.length > 0) {
        this.flushQueue();
      }
      await Promise.allSettled([...this.pending]);
    } while (this.queue.length > 0 || this.pending.size > 0);
  }

  private async upload(input: ExportInput): Promise<void> {
    const key = buildS3Key({
      prefix: this.options.s3.prefix,
      environment: this.options.environment,
      traceId: input.document.traceId,
      side: input.side,
      timestamp: new Date(input.document.endedAt ?? input.document.startedAt),
      seq: input.seq
    });

    const json = JSON.stringify(input.document, null, 2);
    // gzip compression is on by default; env JAYTRACE_S3_GZIP=0 disables it (no module option).
    // The object key stays *.json and ContentType is unchanged — consumers detect gzip via ContentEncoding.
    const gzipEnabled = process.env.JAYTRACE_S3_GZIP !== "0";

    // Without this the http instrumentation traces our own PUT. The flush runs off a timer with
    // no active span, so that client span becomes a root of its own -> document -> PUT -> root,
    // amplifying without bound (worst on S3 failures, where every retry spawns more work).
    // Same reason the OTLP exporters suppress tracing around their transport.
    await context.with(suppressTracing(context.active()), () =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.options.s3.bucket,
          Key: key,
          Body: gzipEnabled ? gzipSync(json) : json,
          ContentType: "application/json; charset=utf-8",
          ContentEncoding: gzipEnabled ? "gzip" : undefined,
          ServerSideEncryption: this.options.s3.serverSideEncryption === false ? undefined : this.options.s3.serverSideEncryption ?? "AES256",
          SSEKMSKeyId: this.options.s3.sseKmsKeyId
        })
      )
    );

    if (this.options.onExported) {
      try {
        this.options.onExported({
          key,
          side: input.side,
          document: input.document as unknown as Record<string, unknown>
        });
      } catch (hookError: unknown) {
        process.stderr.write(`[jaytrace] onExported hook threw ${errorText(hookError)}\n`);
      }
    }
  }

  private async spool(input: ExportInput, error: unknown): Promise<void> {
    const root = this.options.spoolDir ?? join(tmpdir(), "jaytrace-spool");
    const timestamp = new Date(input.document.endedAt ?? input.document.startedAt);
    const key = buildS3Key({
      prefix: this.options.s3.prefix,
      environment: this.options.environment,
      traceId: input.document.traceId,
      side: input.side,
      timestamp,
      seq: input.seq
    });
    const path = join(root, key);

    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify(
        {
          exportError: errorText(error),
          document: input.document
        },
        null,
        2
      )
    );
    process.stderr.write(`[jaytrace] s3 export failed; spooled ${path}\n`);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
