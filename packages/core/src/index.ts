export type {
  CreateTimelineDocumentInput,
  JayTraceContext,
  JayTraceError,
  JayTraceSeverity,
  JayTraceSide,
  JayTraceTimelineDocument,
  TimelineEvent,
  TimelineEventKind
} from "./types.js";

export {
  createChildTraceparent,
  createTraceparent,
  getTraceId,
  parseTraceparent,
  type Traceparent
} from "./traceparent.js";

export {
  DEFAULT_REDACTED_VALUE,
  DEFAULT_SENSITIVE_KEYS,
  isSensitiveKey,
  redact,
  type RedactOptions
} from "./redaction.js";

export {
  createTimelineDocument,
  createTimelineEvent,
  formatTimelineLine,
  summarizeTimeline
} from "./timeline.js";

export {
  createSessionManager,
  SESSION_MAX_DURATION_MS,
  SESSION_TIMEOUT_MS,
  type SessionManager,
  type SessionManagerOptions,
  type SessionState,
  type SessionStorage
} from "./session.js";
