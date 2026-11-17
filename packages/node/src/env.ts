import type { JayTraceExportOptions } from "./exporter-types.js";

export type JayTraceExportPolicy = "errors" | "slow" | "all";

export interface ResolvedNodeOptions {
  options: JayTraceExportOptions;
  exportPolicy: JayTraceExportPolicy;
  /** Set to write documents to disk instead of S3 (local dev / e2e). */
  exportDir?: string;
}

const EXPORT_POLICIES = new Set<string>(["errors", "slow", "all"]);

/** Keys accepted by `JAYTRACE_INSTRUMENT_DISABLE`. */
const INSTRUMENT_KEYS = new Set<string>([
  "amqplib",
  "express",
  "http",
  "mysql2",
  "pg",
  "winston",
  "pino",
  "nestjs-core",
  "console"
]);

/**
 * Same env contract as `resolveJayTraceEnvOptions` in @jaytrace/nestjs, but returns null
 * instead of throwing: `import "@jaytrace/node/init"` runs before secrets may be loaded,
 * so "not configured yet" is a normal state the exporter retries out of.
 */
export function resolveNodeOptions(
  env: Record<string, string | undefined> = process.env
): ResolvedNodeOptions | null {
  const apiKey = env.JAYTRACE_API_KEY;
  const bucket = env.JAYTRACE_BUCKET;
  const region = env.AWS_REGION;
  if (!apiKey || !bucket || !region) {
    return null;
  }

  const policy = env.JAYTRACE_EXPORT?.trim();
  const exportDir = env.JAYTRACE_EXPORT_DIR?.trim();

  return {
    options: {
      apiKey,
      service: env.JAYTRACE_SERVICE ?? "api",
      environment: env.NODE_ENV,
      s3: {
        bucket,
        region,
        prefix: env.JAYTRACE_S3_PREFIX ?? env.NODE_ENV
      }
    },
    exportPolicy: policy && EXPORT_POLICIES.has(policy) ? (policy as JayTraceExportPolicy) : "errors",
    ...(exportDir ? { exportDir } : {})
  };
}

interface IgnoreRule {
  path: string;
  /** Entry ended with `*`: match by prefix instead of exact equality. */
  prefix: boolean;
}

/** `JAYTRACE_HTTP_IGNORE_PATHS=/health*,/metrics` — `*` suffix is a prefix match, else exact. */
export function parseHttpIgnorePaths(raw: string | undefined): IgnoreRule[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) =>
      entry.endsWith("*") ? { path: entry.slice(0, -1), prefix: true } : { path: entry, prefix: false }
    );
}

/** null = never read yet; anything else is the raw env value the cache was built from. */
let ignoreRaw: string | null | undefined = null;
let ignoreRules: IgnoreRule[] = [];

/**
 * Read live from `process.env` on every call: the host app injects secrets with
 * `Object.assign(process.env)` after boot, so a value frozen at bootstrap would miss them.
 * Parsing is memoized on the raw string, leaving one string comparison per request.
 *
 * Never throws — a non-string url is simply not ignored.
 */
export function isIgnoredHttpPath(url: string | undefined): boolean {
  const raw = process.env.JAYTRACE_HTTP_IGNORE_PATHS;
  if (raw !== ignoreRaw) {
    ignoreRaw = raw;
    ignoreRules = parseHttpIgnorePaths(raw);
  }
  if (ignoreRules.length === 0 || typeof url !== "string") {
    return false;
  }
  const query = url.indexOf("?");
  const path = query === -1 ? url : url.slice(0, query);
  return ignoreRules.some((rule) => (rule.prefix ? path.startsWith(rule.path) : path === rule.path));
}

/** `JAYTRACE_INSTRUMENT_DISABLE=pg,winston` — unknown names are ignored, not an error. */
export function parseInstrumentDisable(
  env: Record<string, string | undefined> = process.env
): Set<string> {
  const raw = env.JAYTRACE_INSTRUMENT_DISABLE;
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((name) => name.trim())
      .filter((name) => INSTRUMENT_KEYS.has(name))
  );
}
