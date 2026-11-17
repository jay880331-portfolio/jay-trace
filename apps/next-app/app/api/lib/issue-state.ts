import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { IssueState } from "../../lib/issues.mjs";
import { isIssueFingerprint } from "../../lib/issues.mjs";
import { logDirs, s3Source } from "./documents.ts";

const ISSUE_STATE_S3_DIR = "_state/issues/";
const statuses = new Set<IssueState["status"]>(["new", "acknowledged", "resolved"]);
const writeQueues = new Map<string, Promise<unknown>>();
type S3Command = GetObjectCommand | PutObjectCommand;
type SendS3 = (command: S3Command) => Promise<unknown>;

export class SharedStateWriteError extends Error {}

export async function readIssueStates(
  fingerprints: Iterable<string>,
  sendS3?: SendS3
): Promise<Record<string, IssueState>> {
  const states: Record<string, IssueState> = {};
  const wanted = [...new Set(fingerprints)].filter(isIssueFingerprint);
  const stateRoot = join(logDirs()[0]!, ".state", "issues");

  await Promise.all(wanted.map(async fingerprint => {
    const path = join(stateRoot, `${fingerprint}.json`);
    try {
      mergeState(states, parseState(await readFile(path, "utf8"), path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Failed to read issue state ${path}`, error);
    }
  }));

  const source = s3Source();
  if (!source) return states;
  const send = s3Sender(source.region, sendS3);
  await Promise.all(wanted.map(async fingerprint => {
    const key = `${s3StatePrefix(source.prefix)}${fingerprint}.json`;
    try {
      const response = await send(new GetObjectCommand({ Bucket: source.bucket, Key: key })) as GetObjectCommandOutput;
      mergeState(states, parseState((await response.Body?.transformToString()) ?? "", key));
    } catch (error) {
      if (!isNotFound(error)) console.error(`Failed to read issue state ${key}`, error);
    }
  }));
  return states;
}

export function writeIssueState(
  fingerprint: string,
  status: IssueState["status"],
  lastSeen: string,
  sendS3?: SendS3
): Promise<IssueState> {
  if (!isIssueFingerprint(fingerprint)) return Promise.reject(new Error("Invalid issue fingerprint"));
  if (!statuses.has(status)) return Promise.reject(new Error("Invalid issue status"));
  const normalizedLastSeen = canonicalTimestamp(lastSeen);
  if (!normalizedLastSeen) return Promise.reject(new Error("Invalid issue lastSeen"));

  return serializeWrite(fingerprint, async () => {
    const now = new Date().toISOString();
    const state: IssueState = {
      schema: "jaytrace.issue-state.v1",
      fingerprint,
      status,
      updatedAt: now,
      resolvedAt: status === "resolved" ? now : null,
      lastOccurrenceAtResolution: status === "resolved" ? normalizedLastSeen : null
    };
    const source = s3Source();
    if (!source) {
      await writeLocalState(state);
      return state;
    }

    try {
      return await writeS3State(source, state, s3Sender(source.region, sendS3));
    } catch (error) {
      console.error(`Failed to write issue state ${fingerprint} to S3; spooled locally`, error);
      await writeLocalState(state);
      throw new SharedStateWriteError("Shared S3 issue state was not persisted", { cause: error });
    }
  });
}

async function writeS3State(source: NonNullable<ReturnType<typeof s3Source>>, state: IssueState, send: SendS3): Promise<IssueState> {
  const key = `${s3StatePrefix(source.prefix)}${state.fingerprint}.json`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let existing: IssueState | null = null;
    let etag: string | undefined;
    try {
      const response = await send(new GetObjectCommand({ Bucket: source.bucket, Key: key })) as GetObjectCommandOutput;
      etag = response.ETag;
      existing = parseState((await response.Body?.transformToString()) ?? "", key);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (existing && Date.parse(existing.updatedAt) > Date.parse(state.updatedAt)) return existing;
    try {
      await send(new PutObjectCommand({
        Bucket: source.bucket,
        Key: key,
        ContentType: "application/json",
        Body: JSON.stringify(state),
        ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" })
      }));
      return state;
    } catch (error) {
      if (!isConflict(error) || attempt === 2) throw error;
    }
  }
  throw new Error("unreachable");
}

function serializeWrite<T>(fingerprint: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(fingerprint) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  writeQueues.set(fingerprint, next);
  void next.finally(() => {
    if (writeQueues.get(fingerprint) === next) writeQueues.delete(fingerprint);
  }).catch(() => undefined);
  return next;
}

function parseState(json: string, source: string): IssueState | null {
  try {
    const value = JSON.parse(json) as Partial<IssueState> | null;
    const resolved = value?.status === "resolved";
    const updatedAt = canonicalTimestamp(value?.updatedAt);
    const resolvedAt = canonicalTimestamp(value?.resolvedAt);
    const lastOccurrenceAtResolution = canonicalTimestamp(value?.lastOccurrenceAtResolution);
    if (!value || value.schema !== "jaytrace.issue-state.v1" || !isIssueFingerprint(value.fingerprint)
      || value.fingerprint !== basename(source, ".json") || !statuses.has(value.status as IssueState["status"]) || !updatedAt
      || (resolved ? !resolvedAt || !lastOccurrenceAtResolution : value.resolvedAt !== null || value.lastOccurrenceAtResolution !== null)) {
      throw new Error("Invalid issue state schema");
    }
    return { ...value, updatedAt, resolvedAt: resolved ? resolvedAt : null, lastOccurrenceAtResolution: resolved ? lastOccurrenceAtResolution : null } as IssueState;
  } catch (error) {
    console.error(`Failed to parse issue state ${source}`, error);
    return null;
  }
}

function mergeState(states: Record<string, IssueState>, state: IssueState | null): void {
  const existing = state ? states[state.fingerprint] : undefined;
  if (state && (!existing || Date.parse(state.updatedAt) > Date.parse(existing.updatedAt))) states[state.fingerprint] = state;
}

async function writeLocalState(state: IssueState): Promise<void> {
  const stateRoot = join(logDirs()[0]!, ".state", "issues");
  await mkdir(stateRoot, { recursive: true });
  const tempPath = join(stateRoot, `${state.fingerprint}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tempPath, JSON.stringify(state), "utf8");
  await rename(tempPath, join(stateRoot, `${state.fingerprint}.json`));
}

function s3StatePrefix(prefix: string): string {
  const root = prefix.replace(/\/+$/, "");
  return root ? `${root}/${ISSUE_STATE_S3_DIR}` : ISSUE_STATE_S3_DIR;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(timestamp)) return null;
  const canonical = new Date(timestamp).toISOString();
  const [date] = value.split("T");
  const [year, month, day] = date!.split("-").map(Number);
  const probe = new Date(Date.UTC(year!, month! - 1, day!));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month! - 1 || probe.getUTCDate() !== day) return null;
  return canonical;
}

function isNotFound(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value?.name === "NoSuchKey" || value?.$metadata?.httpStatusCode === 404;
}

function isConflict(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value?.name === "PreconditionFailed" || value?.$metadata?.httpStatusCode === 412;
}

function s3Sender(region: string, sendS3?: SendS3): SendS3 {
  if (sendS3) return sendS3;
  const client = new S3Client({ region });
  return command => client.send(command as never);
}
