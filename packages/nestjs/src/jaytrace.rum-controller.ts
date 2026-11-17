import { BadRequestException, Body, Controller, HttpException, HttpStatus, Inject, Logger, Post, UnauthorizedException } from "@nestjs/common";
import { redact } from "@jaytrace/core";
import { isReplayDocument, isReplayV2SegmentDocument, type ReplayV2SegmentDocument } from "@jaytrace/replay-core";

import { JayTraceMetrics } from "./jaytrace.metrics.js";
import { JAYTRACE_EXPORTER, JAYTRACE_METRICS, JAYTRACE_OPTIONS } from "./tokens.js";
import type { JayTraceExporter, JayTraceModuleOptions, JayTraceRumPayload } from "./types.js";

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const DEFAULT_MAX_RUM_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_RUM_EVENTS = 1000;
const DEFAULT_MAX_RUM_REPLAY_EVENTS = 5000;
const DEFAULT_RUM_RATE_LIMIT = {
  maxBuckets: 10_000,
  maxRequests: 120,
  windowMs: 60_000
};

@Controller("jaytrace/rum")
export class JayTraceRumController {
  private readonly logger = new Logger("JayTraceRum");
  private readonly rateBuckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    @Inject(JAYTRACE_OPTIONS) private readonly options: JayTraceModuleOptions,
    @Inject(JAYTRACE_EXPORTER) private readonly exporter: JayTraceExporter,
    @Inject(JAYTRACE_METRICS) private readonly metrics: JayTraceMetrics = new JayTraceMetrics()
  ) {}

  @Post()
  async ingest(@Body() payload: JayTraceRumPayload): Promise<{ ok: true }> {
    try {
      if (!payload || !isAllowedApiKey(payload.apiKey, this.options)) {
        throw new UnauthorizedException("Invalid JayTrace apiKey");
      }

      this.assertRateLimit(payload.document?.traceId);
      assertPayloadBudget(payload, this.options);

      if (!isValidPayload(payload.document, this.options)) {
        throw new BadRequestException("Invalid JayTrace payload");
      }

      const document = payload.document;
      const isV2 = isReplayV2SegmentDocument(document);
      this.exporter.export({
        side: isV2 || document.schema === "jaytrace.replay.v1" ? `replay-${(document as { platform: string }).platform}` : (document as { side?: string }).side === "back" ? "back" : "front",
        seq: isV2 ? (document as ReplayV2SegmentDocument).seq : undefined,
        document: isV2 ? redactV2(document) : redact(document)
      });

      this.metrics.inc("rumAccepted");
      if (this.options.drainOnIngest && this.exporter.drain) {
        await this.exporter.drain();
      }
      return { ok: true };
    } catch (error) {
      const statusCode = error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
      const reason = error instanceof HttpException ? error.message : String(error);
      const rateLimited = statusCode === HttpStatus.TOO_MANY_REQUESTS;
      this.metrics.inc(rateLimited ? "rumRateLimited" : "rumRejected");
      if (!rateLimited) {
        this.metrics.rejectReason(reason);
      }
      const traceId = payload?.document?.traceId ?? "unknown";
      const schema = payload?.document?.schema ?? "unknown";
      this.logger.warn(`RUM rejected status=${statusCode} reason="${reason}" traceId=${traceId} schema=${schema}`);
      throw error;
    }
  }

  private assertRateLimit(traceId: string | undefined): void {
    const limit = this.options.rumRateLimit === false ? null : this.options.rumRateLimit ?? DEFAULT_RUM_RATE_LIMIT;
    if (!limit) {
      return;
    }

    const key = traceId && TRACE_ID_RE.test(traceId) ? traceId : "unknown";
    const now = Date.now();
    const bucket = this.rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.pruneExpiredRateBuckets(now);
      if (!this.rateBuckets.has(key) && this.rateBuckets.size >= (limit.maxBuckets ?? DEFAULT_RUM_RATE_LIMIT.maxBuckets)) {
        throw new HttpException("JayTrace RUM rate limit bucket capacity exceeded", HttpStatus.TOO_MANY_REQUESTS);
      }
      this.rateBuckets.set(key, {
        count: 1,
        resetAt: now + limit.windowMs
      });
      return;
    }

    bucket.count += 1;
    if (bucket.count > limit.maxRequests) {
      throw new HttpException("JayTrace RUM rate limit exceeded", HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private pruneExpiredRateBuckets(now: number): void {
    for (const [key, bucket] of this.rateBuckets) {
      if (bucket.resetAt <= now) {
        this.rateBuckets.delete(key);
      }
    }
  }
}

function isAllowedApiKey(apiKey: string | undefined, options: JayTraceModuleOptions): boolean {
  if (!apiKey) {
    return false;
  }

  return new Set([options.apiKey, ...(options.apiKeys ?? [])]).has(apiKey);
}

function isValidPayload(
  document: JayTraceRumPayload["document"] | undefined,
  options: JayTraceModuleOptions
): document is JayTraceRumPayload["document"] {
  if (!document) {
    return false;
  }

  if (!TRACE_ID_RE.test(document.traceId)) {
    return false;
  }

  const maxEvents = options.maxRumEvents ?? DEFAULT_MAX_RUM_EVENTS;
  if (isReplayV2SegmentDocument(document)) {
    const maxReplayEvents = options.maxRumReplayEvents ?? DEFAULT_MAX_RUM_REPLAY_EVENTS;
    // ponytail: guard now covers engine "wireframe" too (rrwebEvents/wireframeFrames are
    // each required by isReplayV2SegmentDocument for their own engine), so branch instead
    // of a bare non-null assertion that would crash on a real wireframe payload.
    if (document.engine === "wireframe") {
      return (document.wireframeFrames ?? []).length <= maxReplayEvents;
    }
    return (document.rrwebEvents ?? []).length <= maxReplayEvents;
  }

  if (isReplayDocument(document)) {
    return (
      (document.platform === "web" || document.platform === "react-native" || document.platform === "flutter") &&
      document.events.length <= maxEvents &&
      boundedArray(document.frames, maxEvents) &&
      boundedArray(document.mutations, maxEvents)
    );
  }

  if (document.schema !== "jaytrace.timeline.v1" || (document.side !== "front" && document.side !== "back") || document.timeline.length > maxEvents) {
    return false;
  }

  if (!document.timeline.every((line) => typeof line === "string")) {
    return false;
  }

  if (document.events !== undefined && (!Array.isArray(document.events) || document.events.length > maxEvents)) {
    return false;
  }

  return true;
}

function redactV2(document: ReplayV2SegmentDocument): ReplayV2SegmentDocument {
  // rrwebEvents/wireframeFrames are masked at record time (privacy option), so
  // key-based redaction must not walk frames — it would mangle node text/coords.
  const { rrwebEvents, wireframeFrames, ...rest } = document;
  return { ...redact(rest), rrwebEvents, wireframeFrames };
}

function boundedArray(value: unknown[] | undefined, maxItems: number): boolean {
  return !value || value.length <= maxItems;
}

function assertPayloadBudget(payload: JayTraceRumPayload, options: JayTraceModuleOptions): void {
  const maxBytes = options.maxRumPayloadBytes ?? DEFAULT_MAX_RUM_PAYLOAD_BYTES;
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (bytes > maxBytes) {
    throw new BadRequestException("JayTrace payload too large");
  }
}
