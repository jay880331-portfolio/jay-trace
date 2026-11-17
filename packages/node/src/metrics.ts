export type JayTraceMetricName =
  | "exportSent"
  | "exportFailed"
  | "exportSpooled"
  | "exportBackpressure"
  | "rumAccepted"
  | "rumRejected"
  | "rumRateLimited";

export interface JayTraceMetricsSnapshot {
  export: { sent: number; failed: number; spooled: number; backpressure: number };
  rum: { accepted: number; rejected: number; rateLimited: number; rejectedReasons: Record<string, number> };
}

/** Cap on distinct reject-reason keys; overflow reasons collapse into this bucket. */
const MAX_REJECT_REASON_KEYS = 20;
const OTHER_REJECT_REASON = "other";

/** In-memory process-lifetime counters for exporter + RUM ingest. No persistence. */
export class JayTraceMetrics {
  readonly startedAt = new Date();
  private readonly counters: Record<JayTraceMetricName, number> = {
    exportSent: 0,
    exportFailed: 0,
    exportSpooled: 0,
    exportBackpressure: 0,
    rumAccepted: 0,
    rumRejected: 0,
    rumRateLimited: 0
  };
  private readonly rejectReasons: Record<string, number> = {};

  inc(name: JayTraceMetricName): void {
    this.counters[name] += 1;
  }

  /** Records a distinct reject reason, collapsing overflow beyond the key cap into "other". */
  rejectReason(reason: string): void {
    const key =
      reason in this.rejectReasons || Object.keys(this.rejectReasons).length < MAX_REJECT_REASON_KEYS
        ? reason
        : OTHER_REJECT_REASON;
    this.rejectReasons[key] = (this.rejectReasons[key] ?? 0) + 1;
  }

  snapshot(): JayTraceMetricsSnapshot {
    const c = this.counters;
    return {
      export: { sent: c.exportSent, failed: c.exportFailed, spooled: c.exportSpooled, backpressure: c.exportBackpressure },
      rum: {
        accepted: c.rumAccepted,
        rejected: c.rumRejected,
        rateLimited: c.rumRateLimited,
        rejectedReasons: { ...this.rejectReasons }
      }
    };
  }
}
