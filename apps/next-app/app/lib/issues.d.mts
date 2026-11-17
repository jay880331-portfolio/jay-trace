import type { ReplayDocument } from "@jaytrace/replay-core";
import type { TraceRow } from "../api/lib/traces";

export type PersistedIssueStatus = "new" | "acknowledged" | "resolved";
export type IssueStatus = PersistedIssueStatus | "regressed";
export type IssueState = {
  schema: "jaytrace.issue-state.v1";
  fingerprint: string;
  status: PersistedIssueStatus;
  updatedAt: string;
  resolvedAt: string | null;
  lastOccurrenceAtResolution: string | null;
};

export type IssueRow = {
  fingerprint: string;
  traceId: string;
  title: string;
  cause: string;
  impact: string;
  status: IssueStatus;
  count: number;
  firstSeen: string;
  lastSeen: string;
  services: string[];
  environments: string[];
  releases: string[];
  platforms: ReplayDocument["platform"][];
  sessionIds: string[];
  userCount: number;
  traceIds: string[];
};

export function normalizeIssueMessage(message: unknown): string;
export function issueFingerprint(trace: TraceRow): string;
export function groupIssues(traces: TraceRow[], states?: Record<string, IssueState>): IssueRow[];
export function deriveIssueStatus(state: Pick<IssueState, "status" | "lastOccurrenceAtResolution"> | undefined, lastSeen: string): IssueStatus;
export function resolutionBlocked(status: PersistedIssueStatus, rawDocumentsTruncated: boolean): boolean;
export function isIssueFingerprint(value: unknown): boolean;
