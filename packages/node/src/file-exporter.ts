import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { buildS3Key } from "./s3-key.js";
import type { ExportInput, JayTraceExporter, JayTraceExportOptions } from "./exporter-types.js";

/**
 * Writes documents to `{dir}/{s3 key}` instead of S3 — local dev / e2e without a bucket.
 * Fire-and-forget like the S3 exporter: write failures land on stderr, never thrown.
 */
export class FileJayTraceExporter implements JayTraceExporter {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly dir: string,
    private readonly options: JayTraceExportOptions
  ) {}

  export(input: ExportInput): void {
    const key = buildS3Key({
      prefix: this.options.s3?.prefix,
      environment: this.options.environment,
      traceId: input.document.traceId,
      side: input.side,
      timestamp: new Date(input.document.endedAt ?? input.document.startedAt),
      seq: input.seq
    });
    const path = join(this.dir, key);

    const promise = mkdir(dirname(path), { recursive: true })
      .then(() => writeFile(path, JSON.stringify(input.document, null, 2)))
      .catch((error: unknown) => {
        process.stderr.write(`[jaytrace] file export failed ${path} ${errorText(error)}\n`);
      });

    this.pending.add(promise);
    void promise.finally(() => {
      this.pending.delete(promise);
    });
  }

  /** Awaits every in-flight write. Never throws — failures already went to stderr. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
