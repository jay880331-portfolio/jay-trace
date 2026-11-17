import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { JayTraceTimelineDocument } from "@jaytrace/core";
import { isReplayDocument, isReplayV2SegmentDocument, type ReplayDocument, type ReplayV2SegmentDocument } from "@jaytrace/replay-core";

import type { TraceFile } from "./types.js";

export async function collectTraceFiles(root: string): Promise<TraceFile[]> {
  const files = await walkJson(root);
  const traces: TraceFile[] = [];

  for (const path of files) {
    const document = await readTimelineDocument(path);
    if (!document) {
      continue;
    }

    const metadata = await stat(path);
    traces.push({
      path,
      modifiedAt: metadata.mtime,
      document
    });
  }

  return traces;
}

async function walkJson(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJson(path)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(path);
    }
  }

  return files;
}

// gzip magic bytes (RFC 1952). `aws s3 sync` writes gzipped objects (ContentEncoding: "gzip")
// to disk as raw bytes under a *.json name, so files may be gzipped or plain JSON.
function decodeMaybeGzip(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return gunzipSync(bytes).toString("utf8");
  }
  return bytes.toString("utf8");
}

async function readTimelineDocument(path: string): Promise<JayTraceTimelineDocument | ReplayDocument | ReplayV2SegmentDocument | null> {
  try {
    const parsed = JSON.parse(decodeMaybeGzip(await readFile(path))) as unknown;
    const candidate = unwrapDocument(parsed);
    if (isTimelineDocument(candidate)) {
      return candidate;
    }
    if (isReplayV2SegmentDocument(candidate)) {
      return candidate;
    }
    const replay = normalizeReplayDocument(candidate);
    return replay && isReplayDocument(replay) ? replay : null;
  } catch {
    return null;
  }
}

function unwrapDocument(value: unknown): unknown {
  if (value && typeof value === "object" && "document" in value) {
    return (value as { document?: unknown }).document;
  }
  return value;
}

function isTimelineDocument(value: unknown): value is JayTraceTimelineDocument {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<JayTraceTimelineDocument>;
  return (
    candidate.schema === "jaytrace.timeline.v1" &&
    typeof candidate.traceId === "string" &&
    (candidate.side === "front" || candidate.side === "back") &&
    Array.isArray(candidate.timeline)
  );
}

function normalizeReplayDocument(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schema !== "jaytrace.replay.v1" || !Array.isArray(candidate.events)) {
    return value;
  }
  return {
    ...candidate,
    events: candidate.events.map(eventLine).filter(Boolean)
  };
}

function eventLine(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const item = value as Record<string, unknown>;
  return [
    typeof item.at === "string" ? item.at : "",
    typeof item.kind === "string" ? item.kind : "",
    typeof item.level === "string" ? item.level : "",
    typeof item.message === "string" ? item.message : "",
    typeof item.text === "string" ? item.text : ""
  ].filter(Boolean).join(" ");
}
