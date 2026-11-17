import type { S3ClientConfig } from "@aws-sdk/client-s3";
import type { JayTraceTimelineDocument } from "@jaytrace/core";
import type { ReplayDocument, ReplayV2SegmentDocument } from "@jaytrace/replay-core";

export interface JayTraceS3Options {
  bucket: string;
  region: string;
  prefix?: string;
  serverSideEncryption?: "AES256" | "aws:kms" | false;
  sseKmsKeyId?: string;
  clientConfig?: S3ClientConfig;
}

/** Options the exporter itself needs. Framework modules extend this with their own knobs. */
export interface JayTraceExportOptions {
  apiKey: string;
  service?: string;
  environment?: string;
  release?: string;
  spoolDir?: string;
  maxInFlightExports?: number;
  exportBatchSize?: number;
  exportFlushMs?: number;
  slowRequestThresholdMs?: number;
  slowQueryThresholdMs?: number;
  /**
   * Invoked after a document is successfully uploaded to S3 (spool path excluded).
   * Runs behind a try/catch so a throwing hook never breaks export or collection.
   */
  onExported?: (info: { key: string; side: string; document: Record<string, unknown> }) => void;
  s3: JayTraceS3Options;
}

export interface ExportInput {
  document: JayTraceTimelineDocument | ReplayDocument | ReplayV2SegmentDocument;
  /** `back-{service}` identifies which backend service produced the document. */
  side: "front" | "back" | `back-${string}` | `replay-${string}`;
  seq?: number;
}

export interface JayTraceExporter {
  export(input: ExportInput): void;
  drain?(): Promise<void>;
}
