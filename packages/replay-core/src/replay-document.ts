import { redact } from "@jaytrace/core";
import type { CreateReplayDocumentInput, ReplayDocument, ReplayEvent, ReplayPlatform } from "./types.js";
import { sanitizeReplayLine } from "./mask.js";

export function createReplayDocument(input: CreateReplayDocumentInput): ReplayDocument {
  return redact({
    schema: "jaytrace.replay.v1",
    platform: input.platform,
    traceId: input.traceId,
    sessionId: input.sessionId,
    traceparent: input.traceparent,
    mode: input.mode,
    startedAt: input.startedAt.toISOString(),
    endedAt: input.endedAt?.toISOString(),
    metadata: input.metadata,
    events: input.events.map(formatReplayLine),
    frames: input.frames,
    mutations: input.mutations
  });
}

export function formatReplayLine(event: ReplayEvent): string {
  return sanitizeReplayLine(`${event.at} ${event.kind} ${event.text}`);
}

export function isReplayDocument(value: unknown): value is ReplayDocument {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ReplayDocument>;
  return (
    candidate.schema === "jaytrace.replay.v1" &&
    typeof candidate.traceId === "string" &&
    Array.isArray(candidate.events) &&
    candidate.events.every((event) => typeof event === "string") &&
    (!candidate.frames || (Array.isArray(candidate.frames) && validReplayFrames(candidate.frames, candidate.platform))) &&
    (!candidate.mutations || Array.isArray(candidate.mutations)) &&
    (candidate.platform === "web" || candidate.platform === "react-native" || candidate.platform === "flutter")
  );
}

function validReplayFrames(value: unknown[], platform: ReplayPlatform | undefined): boolean {
  return value.every((frame) => {
    if (!frame || typeof frame !== "object") {
      return false;
    }
    const candidate = frame as Record<string, unknown>;
    return (
      typeof candidate.at === "string" &&
      isReplayKind(candidate.kind) &&
      typeof candidate.text === "string" &&
      optionalFrameType(candidate.type) &&
      optionalString(candidate.url) &&
      optionalString(candidate.html) &&
      optionalReplayImage(candidate.image) &&
      optionalString(candidate.mediaType) &&
      optionalNumber(candidate.width) &&
      optionalNumber(candidate.height) &&
      optionalNumber(candidate.x) &&
      optionalNumber(candidate.y)
    ) && validFramePayload(candidate, platform);
  });
}

function validFramePayload(candidate: Record<string, unknown>, platform: ReplayPlatform | undefined): boolean {
  if (platform === "react-native" || platform === "flutter") {
    return candidate.type === "image" && typeof candidate.image === "string";
  }
  if (candidate.type === "image") {
    return typeof candidate.image === "string";
  }
  if (candidate.image !== undefined) {
    return candidate.type === "image";
  }
  return true;
}

function isReplayKind(value: unknown): boolean {
  return (
    value === "viewport" ||
    value === "route" ||
    value === "click" ||
    value === "input" ||
    value === "scroll" ||
    value === "mutation" ||
    value === "network" ||
    value === "screenshot" ||
    value === "gesture" ||
    value === "error"
  );
}

function optionalFrameType(value: unknown): boolean {
  return value === undefined || value === "dom" || value === "image";
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalReplayImage(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value));
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}
