export type JayTraceSide = "front" | "back";

export type JayTraceSeverity = "debug" | "info" | "warn" | "error" | "fatal";

export type TimelineEventKind =
  | "navigation"
  | "click"
  | "view"
  | "scroll"
  | "rage_click"
  | "fetch"
  | "error"
  | "request"
  | "db"
  | "queue"
  | "performance"
  | "log";

export interface TimelineEvent {
  at: string;
  kind: TimelineEventKind;
  text: string;
  severity?: JayTraceSeverity;
  /** wall-clock duration of the operation (http request, db query, ...) */
  durationMs?: number;
  /** slow-query / slow-request marker, set when durationMs exceeds the configured threshold */
  slow?: boolean;
  /** structured payload (request/response body, query params, ...) — must be redacted before attach */
  data?: Record<string, unknown>;
}

export interface JayTraceUser {
  id: string;
  email?: string;
  name?: string;
  [key: string]: unknown;
}

export interface JayTraceContext {
  url?: string;
  userAgent?: string;
  release?: string;
  environment?: string;
  route?: string;
  method?: string;
  statusCode?: number;
  [key: string]: unknown;
}

export interface JayTraceError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}

export interface JayTraceTimelineDocument {
  schema: "jaytrace.timeline.v1";
  service: string;
  side: JayTraceSide;
  traceId: string;
  sessionId?: string;
  spanId?: string;
  traceparent?: string;
  startedAt: string;
  endedAt?: string;
  summary: string;
  timeline: string[];
  events?: TimelineEvent[];
  user?: JayTraceUser;
  context?: JayTraceContext;
  error?: JayTraceError;
}

export interface CreateTimelineDocumentInput {
  service: string;
  side: JayTraceSide;
  traceId: string;
  sessionId?: string;
  spanId?: string;
  traceparent?: string;
  startedAt?: Date;
  endedAt?: Date;
  summary: string;
  events: TimelineEvent[];
  user?: JayTraceUser;
  context?: JayTraceContext;
  error?: JayTraceError;
}
