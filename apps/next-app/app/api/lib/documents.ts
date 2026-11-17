import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { ListObjectsV2CommandOutput, _Object } from "@aws-sdk/client-s3";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { isReplaySegmentKey } from "../../lib/replaySegments.mjs";
import { pathHasSegment } from "../../lib/pathSegment.mjs";

export { isReplaySegmentKey };

// Shared S3/local document reader used by /api/traces and /api/replay.
// Returns RAW parsed JSON values — each route applies its own type guard
// (traces → documentFromJson, replay → isReplayV2SegmentDocument).

export type S3Source = { bucket: string; prefix: string; region: string };
export type SourceMode = "s3" | "local" | "local-fallback" | "db+s3";

export type CollectedDocuments = {
  sourceMode: SourceMode;
  source: S3Source | null;
  localDirs: string[];
  documents: unknown[];
  rawDocumentsRead: number;
  rawDocumentsTruncated: boolean;
};

export function s3Source(): S3Source | null {
  const bucket = process.env.JAYTRACE_BUCKET ?? process.env.JAYTRACE_S3_BUCKET;
  if (!bucket) {
    return null;
  }
  return {
    bucket,
    prefix: process.env.JAYTRACE_S3_PREFIX ?? "production",
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"
  };
}

export function logDirs(): string[] {
  return [
    process.env.JAYTRACE_LOGS_DIR,
    join(homedir(), ".jaytrace", "logs"),
    join(tmpdir(), "jaytrace-spool")
  ].filter((dir): dir is string => Boolean(dir));
}

// Collect raw documents from S3 (if configured) or the local logs dirs, with
// local fallback when the S3 read throws. `days` and `limit` should already be
// clamped by the caller; `traceId` narrows S3 prefixes when known.
export async function collectRawDocuments(opts: {
  days: number;
  limit: number;
  traceId?: string | null;
  // /api/replay merges v2 segment files, so it must read them. /api/traces (default)
  // discards them and skips reading their bodies for speed.
  includeSegments?: boolean;
}): Promise<CollectedDocuments> {
  const source = s3Source();
  const localDirs = logDirs();
  const includeSegments = opts.includeSegments ?? false;
  const rawDocumentLimit = Math.max(opts.limit * 4, 80);

  if (source) {
    try {
      const result = await readS3Documents(source, opts.days, rawDocumentLimit, opts.traceId ?? null, includeSegments);
      return { sourceMode: "s3", source, localDirs, ...result, rawDocumentsRead: result.documents.length };
    } catch {
      return {
        sourceMode: "local-fallback",
        source,
        localDirs,
        ...await readDocuments(localDirs, includeSegments, opts.traceId ?? null, rawDocumentLimit)
      };
    }
  }
  return {
    sourceMode: "local",
    source: null,
    localDirs,
    ...await readDocuments(localDirs, includeSegments, opts.traceId ?? null, rawDocumentLimit)
  };
}

async function readS3Documents(
  source: S3Source,
  days: number,
  rawDocumentLimit: number,
  traceId: string | null,
  includeSegments: boolean
): Promise<{ documents: unknown[]; rawDocumentsTruncated: boolean }> {
  const client = new S3Client({ region: source.region });
  const prefixes = recentDatePrefixes(source.prefix, days).map(prefix => traceId ? `${prefix}${traceId}/` : prefix);
  const listings = await Promise.all(
    prefixes.map(prefix => listS3Objects(client, source.bucket, prefix, rawDocumentLimit + 1))
  );
  const keys = listings
    .flatMap(listing => listing.objects)
    .filter(object => {
      const key = object.Key;
      return Boolean(key?.endsWith(".json")) && (includeSegments || !isReplaySegmentKey(key ?? ""));
    })
    .sort((left, right) => (right.LastModified?.getTime() ?? 0) - (left.LastModified?.getTime() ?? 0))
    .slice(0, rawDocumentLimit + 1)
    .map(object => object.Key as string);

  const truncated = listings.some(listing => listing.truncated) || keys.length > rawDocumentLimit;
  const documents = await Promise.all(keys.slice(0, rawDocumentLimit).map(key => readS3Document(client, source.bucket, key)));
  return { documents: documents.filter(doc => doc !== null), rawDocumentsTruncated: truncated };
}

// gzip magic bytes (RFC 1952). Valid JSON never begins with these, so this is a
// safe way to detect gzipped bodies even when a Content-Encoding header is absent
// (e.g. files pulled down via `aws s3 sync`).
function hasGzipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function decodeMaybeGzip(bytes: Uint8Array, contentEncoding?: string): string {
  if (contentEncoding === "gzip" || hasGzipMagic(bytes)) {
    return gunzipSync(bytes).toString("utf8");
  }
  return Buffer.from(bytes).toString("utf8");
}

async function readS3Document(client: S3Client, bucket: string, key: string): Promise<unknown | null> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    // New objects are gzipped (ContentEncoding: "gzip"); old objects are plain JSON.
    // Handle both — decodeMaybeGzip falls back to plaintext when not gzipped.
    const bytes = (await response.Body?.transformToByteArray()) ?? new Uint8Array();
    return JSON.parse(decodeMaybeGzip(bytes, response.ContentEncoding) || "null") as unknown;
  } catch {
    return null;
  }
}

async function listS3Objects(client: S3Client, bucket: string, prefix: string, maxObjects: number) {
  const objects: _Object[] = [];
  let token: string | undefined;
  let truncated = false;

  do {
    const response: ListObjectsV2CommandOutput = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: Math.min(1000, maxObjects - objects.length),
        ContinuationToken: token
      })
    );
    objects.push(...(response.Contents ?? []));
    truncated ||= objects.length >= maxObjects && Boolean(response.NextContinuationToken);
    token = objects.length < maxObjects ? response.NextContinuationToken : undefined;
  } while (token);

  return { objects, truncated };
}

function recentDatePrefixes(prefix: string, days: number): string[] {
  const result: string[] = [];
  const now = new Date();
  for (let index = 0; index < days; index += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - index));
    const yyyy = String(date.getUTCFullYear());
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    result.push(`${prefix}/${yyyy}/${mm}/${dd}/`);
  }
  return result;
}

async function readDocuments(dirs: string[], includeSegments: boolean, traceId: string | null, rawDocumentLimit: number) {
  const files = (await Promise.all(dirs.map(dir => listJsonFiles(dir, rawDocumentLimit + 1, traceId)))).flat()
    .filter(path => includeSegments || !isReplaySegmentKey(path))
    .slice(0, rawDocumentLimit + 1);
  const truncated = files.length > rawDocumentLimit;
  const documents = await Promise.all(files.slice(0, rawDocumentLimit).map(readJsonDocument));
  return { documents: documents.filter(doc => doc !== null), rawDocumentsRead: documents.length, rawDocumentsTruncated: truncated };
}

async function listJsonFiles(dir: string, maxFiles: number, traceId: string | null = null): Promise<string[]> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const nested: string[] = [];
  for (const entry of entries) {
    if (nested.length >= maxFiles) break;
    if (entry.name === ".state" || entry.name === "_state") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        nested.push(...await listJsonFiles(path, maxFiles - nested.length, traceId));
      } else if (entry.isFile() && entry.name.endsWith(".json") && (!traceId || pathHasSegment(path, traceId))) {
        nested.push(path);
      }
  }

  return nested;
}

async function readJsonDocument(path: string): Promise<unknown | null> {
  try {
    // Local files are usually plain JSON, but `aws s3 sync` may deposit gzipped
    // objects into these dirs — decodeMaybeGzip handles both by magic-byte sniff.
    return JSON.parse(decodeMaybeGzip(await readFile(path))) as unknown;
  } catch {
    return null;
  }
}
