import type { JayTraceTimelineDocument, TimelineEvent } from "@jaytrace/core";
import type { JayTraceExportOptions } from "@jaytrace/node";
import type { ReplayDocument, ReplayV2SegmentDocument } from "@jaytrace/replay-core";
import type { ModuleMetadata } from "@nestjs/common";

export type { ExportInput, JayTraceExporter, JayTraceExportOptions, JayTraceS3Options } from "@jaytrace/node";

export interface JayTraceModuleOptions extends JayTraceExportOptions {
  apiKeys?: string[];
  captureBody?: boolean | { maxBytes?: number };
  maxRumPayloadBytes?: number;
  maxRumEvents?: number;
  maxRumReplayEvents?: number;
  rumRateLimit?: false | {
    maxRequests: number;
    windowMs: number;
    maxBuckets?: number;
  };
  /** Serverless: await export completion before the ingest response returns (env JAYTRACE_DRAIN_ON_INGEST). */
  drainOnIngest?: boolean;
}

export interface JayTraceModuleAsyncOptions extends Pick<ModuleMetadata, "imports"> {
  inject?: Array<string | symbol | Function>;
  useFactory: (...args: unknown[]) => JayTraceModuleOptions | Promise<JayTraceModuleOptions>;
}

export interface JayTraceRequestContext {
  traceId: string;
  spanId: string;
  traceparent: string;
  /** RUM session id inherited from the `x-jaytrace-session` request header (validated). */
  sessionId?: string;
  startedAt: Date;
  events: TimelineEvent[];
  context?: Record<string, unknown>;
  backExported?: boolean;
  slowQueryThresholdMs?: number;
  request?: {
    method?: string;
    url?: string;
  };
}

export interface JayTraceRumPayload {
  apiKey: string;
  reason: "error" | "rage_click" | "manual";
  document: JayTraceTimelineDocument | ReplayDocument | ReplayV2SegmentDocument;
}

export interface HttpLikeRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface HttpLikeResponse {
  statusCode?: number;
  setHeader?: (name: string, value: string) => void;
  on?: (event: "finish", listener: () => void) => unknown;
  once?: (event: "finish", listener: () => void) => unknown;
  json?: (body: unknown) => unknown;
  send?: (body: unknown) => unknown;
}
