export const DEFAULT_REDACTED_VALUE = "redacted";

const SENSITIVE_ASSIGNMENT_RE = /\b(password|passwd|token|authorization|cookie|set-cookie|apiKey|api_key|x-api-key|secret)\b\s*[:=]\s*("[^"]*"|'[^']*'|Bearer\s+[^\s,;]+|[^\s,;]+)/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

export const DEFAULT_SENSITIVE_KEYS = new Set([
  "api_key",
  "apikey",
  "api-key",
  "authorization",
  "auth",
  "cookie",
  "password",
  "passwd",
  "secret",
  "set-cookie",
  "token",
  "x-api-key",
  "sessiontoken",
  "session_token",
  "session-token",
  "accesstoken",
  "access_token",
  "access-token",
  "refreshtoken",
  "refresh_token",
  "refresh-token",
  "privatekey",
  "private_key",
  "private-key",
  "clientsecret",
  "client_secret",
  "client-secret",
  "idtoken",
  "id_token",
  "id-token"
]);

export interface RedactOptions {
  /** set false to disable redaction entirely (opt-out; default true) */
  enabled?: boolean;
  sensitiveKeys?: Iterable<string>;
  redactedValue?: string;
  maxDepth?: number;
}

export function redact<T>(value: T, options: RedactOptions = {}): T {
  if (options.enabled === false) {
    return value;
  }

  const sensitiveKeys = normalizeKeys(options.sensitiveKeys ?? DEFAULT_SENSITIVE_KEYS);
  const redactedValue = options.redactedValue ?? DEFAULT_REDACTED_VALUE;
  const maxDepth = options.maxDepth ?? 8;

  return redactValue(value, sensitiveKeys, redactedValue, maxDepth, 0, new WeakSet()) as T;
}

export function isSensitiveKey(key: string, sensitiveKeys: Iterable<string> = DEFAULT_SENSITIVE_KEYS): boolean {
  return isNormalizedSensitiveKey(normalizeKey(key), normalizeKeys(sensitiveKeys));
}

function redactValue(
  value: unknown,
  sensitiveKeys: Set<string>,
  redactedValue: string,
  maxDepth: number,
  depth: number,
  seen: WeakSet<object>
): unknown {
  if (typeof value === "string") {
    return redactString(value, redactedValue);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (depth >= maxDepth) {
    return "[MaxDepth]";
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, sensitiveKeys, redactedValue, maxDepth, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = isNormalizedSensitiveKey(normalizeKey(key), sensitiveKeys)
      ? redactedValue
      : redactValue(item, sensitiveKeys, redactedValue, maxDepth, depth + 1, seen);
  }

  return output;
}

function normalizeKeys(keys: Iterable<string>): Set<string> {
  return new Set(Array.from(keys, normalizeKey));
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[_.\s]+/g, "-");
}

function isNormalizedSensitiveKey(key: string, sensitiveKeys: Set<string>): boolean {
  return sensitiveKeys.has(key) || key.split("-").some((segment) => sensitiveKeys.has(segment));
}

function redactString(value: string, redactedValue: string): string {
  return value
    .replace(SENSITIVE_ASSIGNMENT_RE, (_match, key: string) => `${key}=${redactedValue}`)
    .replace(BEARER_RE, `Bearer ${redactedValue}`);
}
