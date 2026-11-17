import { buildBackDocument, isFailedRoot, isTrackedRoot, rootRouteLabel, type LogLite, type SpanLite } from "./converter.js";
import type { ExportInput, JayTraceExporter, JayTraceExportOptions } from "./exporter-types.js";
import { getRouteStats, type RouteStatsRecorder } from "./route-stats.js";

export interface TraceBufferOptions {
  options: JayTraceExportOptions;
  exporter: JayTraceExporter;
  exportPolicy: "errors" | "slow" | "all";
  /** Spans + logs kept per root; anything past this is counted as truncated. */
  maxEventsPerRoot?: number;
  /** Roots buffered at once; new roots past this are dropped. */
  maxConcurrentRoots?: number;
  /** Latency counters; defaults to the process-wide collector (null without JAYTRACE_DB_*). */
  stats?: RouteStatsRecorder;
}

const DEFAULT_MAX_EVENTS_PER_ROOT = 500;
const DEFAULT_MAX_CONCURRENT_ROOTS = 1000;
const DEFAULT_SLOW_REQUEST_THRESHOLD_MS = 3000;

interface RootBucket {
  children: SpanLite[];
  logs: LogLite[];
  truncatedCount: number;
  /** Span ids mapped to this root, so finalize can clear them without leaking. */
  spanIds: Set<string>;
}

/**
 * Buffers spans and logs per local root span and turns each finished root into one
 * timeline document. Shared by the span processor and the log record processor.
 *
 * Every public method swallows its own failures: telemetry must never break the app.
 */
export class TraceBuffer {
  private readonly buckets = new Map<string, RootBucket>();
  private readonly spanToRoot = new Map<string, string>();
  private dropped = 0;

  constructor(private readonly config: TraceBufferOptions) {}

  /** Number of spans/logs dropped because their root was unknown, gone, or over the limits. */
  get droppedSpans(): number {
    return this.dropped;
  }

  /**
   * Swaps in the real options once env is available. `@jaytrace/node/init` builds the buffer
   * before secrets may be loaded, so service name and export policy can arrive late.
   */
  updateOptions(options: JayTraceExportOptions, exportPolicy: TraceBufferOptions["exportPolicy"]): void {
    this.config.options = options;
    this.config.exportPolicy = exportPolicy;
  }

  /** Flush hook for the processors: hands off to the exporter, never rejects. */
  async drain(): Promise<void> {
    try {
      await this.config.exporter.drain?.();
      // Otherwise a pod restart drops up to one flush interval of counters.
      await this.stats()?.flush?.();
    } catch (error) {
      warn("drain", error);
    }
  }

  onSpanStart(spanId: string, parentSpanId: string | undefined, parentIsRemote: boolean): void {
    try {
      if (parentSpanId === undefined || parentIsRemote) {
        if (this.buckets.size >= (this.config.maxConcurrentRoots ?? DEFAULT_MAX_CONCURRENT_ROOTS)) {
          this.dropped += 1;
          return;
        }
        this.buckets.set(spanId, { children: [], logs: [], truncatedCount: 0, spanIds: new Set([spanId]) });
        this.spanToRoot.set(spanId, spanId);
        return;
      }

      const rootId = this.spanToRoot.get(parentSpanId);
      const bucket = rootId === undefined ? undefined : this.buckets.get(rootId);
      if (rootId === undefined || bucket === undefined) {
        // Parent was never tracked (or its root already finished) — nothing to attach to.
        this.dropped += 1;
        return;
      }
      this.spanToRoot.set(spanId, rootId);
      bucket.spanIds.add(spanId);
    } catch (error) {
      warn("onSpanStart", error);
    }
  }

  onSpanEnd(span: SpanLite): void {
    try {
      const rootId = this.spanToRoot.get(span.spanId);
      const bucket = rootId === undefined ? undefined : this.buckets.get(rootId);
      if (rootId === undefined || bucket === undefined) {
        this.dropped += 1;
        return;
      }

      if (rootId !== span.spanId) {
        this.push(bucket, bucket.children, span);
        this.spanToRoot.delete(span.spanId);
        bucket.spanIds.delete(span.spanId);
        return;
      }

      // Root finished: build the document and forget everything under it. Children that
      // outlive their root (fire-and-forget work) are dropped — known limitation.
      this.buckets.delete(rootId);
      for (const id of bucket.spanIds) {
        this.spanToRoot.delete(id);
      }
      this.finalize(span, bucket);
    } catch (error) {
      warn("onSpanEnd", error);
    }
  }

  onLog(spanId: string | undefined, log: LogLite): void {
    try {
      const rootId = spanId === undefined ? undefined : this.spanToRoot.get(spanId);
      const bucket = rootId === undefined ? undefined : this.buckets.get(rootId);
      if (bucket === undefined) {
        this.dropped += 1;
        return;
      }
      this.push(bucket, bucket.logs, log);
    } catch (error) {
      warn("onLog", error);
    }
  }

  private push<T>(bucket: RootBucket, target: T[], entry: T): void {
    if (bucket.children.length + bucket.logs.length >= (this.config.maxEventsPerRoot ?? DEFAULT_MAX_EVENTS_PER_ROOT)) {
      bucket.truncatedCount += 1;
      return;
    }
    target.push(entry);
  }

  /** Injected in tests; in production the collector is built on first use, once env is there. */
  private stats(): RouteStatsRecorder | null {
    return this.config.stats ?? getRouteStats();
  }

  /**
   * Counted before the export decision on purpose: documents only exist for failed requests,
   * and a p95 needs the healthy ones as its denominator.
   */
  private recordStats(root: SpanLite): void {
    // CLIENT/INTERNAL roots are stray fire-and-forget work, not a route anyone asks p95 about.
    if (!isTrackedRoot(root)) {
      return;
    }
    this.stats()?.record(
      this.config.options.service,
      rootRouteLabel(root),
      Math.max(0, root.endMs - root.startMs),
      isFailedRoot(root)
    );
  }

  private finalize(root: SpanLite, bucket: RootBucket): void {
    this.recordStats(root);
    // Decide before building: under the default "errors" policy every healthy request
    // would otherwise pay for a full document just to have it thrown away.
    if (!this.shouldExport(root)) {
      return;
    }
    const { options, exporter } = this.config;
    const document = buildBackDocument({
      root,
      children: bucket.children,
      logs: bucket.logs,
      options,
      truncatedCount: bucket.truncatedCount
    });
    const side: ExportInput["side"] = options.service ? `back-${sanitize(options.service)}` : "back";
    exporter.export({ document, side });
  }

  private shouldExport(root: SpanLite): boolean {
    if (this.config.exportPolicy === "all" || isFailedRoot(root)) {
      return true;
    }
    if (this.config.exportPolicy === "slow") {
      const durationMs = Math.max(0, root.endMs - root.startMs);
      return durationMs > (this.config.options.slowRequestThresholdMs ?? DEFAULT_SLOW_REQUEST_THRESHOLD_MS);
    }
    return false;
  }
}

// Same rule as the s3 key path parts: the service name ends up in the object key.
function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._=-]/g, "_").slice(0, 180);
}

function warn(where: string, error: unknown): void {
  // No String(error): a hostile thrown value would throw again from inside the handler.
  process.stderr.write(`[jaytrace] trace buffer ${where} failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
}
