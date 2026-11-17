import { Controller, Get, Inject } from "@nestjs/common";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JayTraceMetrics } from "./jaytrace.metrics.js";
import { JAYTRACE_METRICS, JAYTRACE_OPTIONS } from "./tokens.js";
import type { JayTraceModuleOptions } from "./types.js";

const SPOOL_CACHE_MS = 5_000;

export interface JayTraceHealthResponse {
  ok: true;
  uptimeSec: number;
  export: { sent: number; failed: number; spooled: number; backpressure: number };
  rum: { accepted: number; rejected: number; rateLimited: number; rejectedReasons: Record<string, number> };
  spoolBacklog: number;
}

/** Unauthenticated operational health/metrics. Exposes no bucket names, keys, or payloads. */
@Controller("jaytrace")
export class JayTraceHealthController {
  private spoolCache?: { at: number; count: number };

  constructor(
    @Inject(JAYTRACE_METRICS) private readonly metrics: JayTraceMetrics,
    @Inject(JAYTRACE_OPTIONS) private readonly options: JayTraceModuleOptions
  ) {}

  @Get("health")
  async health(): Promise<JayTraceHealthResponse> {
    const snap = this.metrics.snapshot();
    return {
      ok: true,
      uptimeSec: Math.floor((Date.now() - this.metrics.startedAt.getTime()) / 1000),
      export: snap.export,
      rum: snap.rum,
      spoolBacklog: await this.spoolBacklog()
    };
  }

  private async spoolBacklog(): Promise<number> {
    const now = Date.now();
    if (this.spoolCache && now - this.spoolCache.at < SPOOL_CACHE_MS) {
      return this.spoolCache.count;
    }
    // Same resolution as the exporter's spool root.
    const root = this.options.spoolDir ?? join(tmpdir(), "jaytrace-spool");
    let count = 0;
    try {
      count = await countFiles(root);
    } catch {
      count = 0; // missing dir or read error → backlog 0, health stays ok.
    }
    this.spoolCache = { at: now, count };
    return count;
  }
}

async function countFiles(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    count += entry.isDirectory() ? await countFiles(join(dir, entry.name)) : 1;
  }
  return count;
}
