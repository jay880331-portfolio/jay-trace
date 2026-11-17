import type { JayTraceTimelineDocument } from "@jaytrace/core";
import type { ReplayDocument, ReplayV2SegmentDocument } from "@jaytrace/replay-core";

export type AiRunner = "ollama" | "claude" | "print";
export type ReplayPlatform = ReplayDocument["platform"];

export interface CliOptions {
  logsDir: string;
  ai: AiRunner;
  model: string;
  limit: number;
  minScreens?: number;
  traceId?: string;
  sessionId?: string;
  platform?: ReplayPlatform;
  syncS3?: string;
  syncOnly?: boolean;
  list?: boolean;
}

export interface TraceFile {
  path: string;
  modifiedAt: Date;
  document: JayTraceTimelineDocument | ReplayDocument | ReplayV2SegmentDocument;
}

export interface JoinedTrace {
  traceId: string;
  front?: TraceFile;
  back?: TraceFile;
  replay?: TraceFile;
  replays: TraceFile[];
  score: number;
}
