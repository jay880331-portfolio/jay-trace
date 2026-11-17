export function buildS3Key(input: {
  prefix?: string;
  environment?: string;
  traceId: string;
  side: string;
  timestamp: Date;
  seq?: number;
}): string {
  const yyyy = String(input.timestamp.getUTCFullYear());
  const mm = String(input.timestamp.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(input.timestamp.getUTCDate()).padStart(2, "0");
  const iso = input.timestamp.toISOString().replace(/[:.]/g, "-");
  const env = sanitizePathPart(input.prefix ?? input.environment ?? "default");
  const traceId = sanitizePathPart(input.traceId);
  const stamp = `${iso}${input.seq === undefined ? "" : `-seq${input.seq}`}`;

  return `${env}/${yyyy}/${mm}/${dd}/${traceId}/${input.side}-${stamp}.json`;
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._=-]/g, "_").slice(0, 180);
}
