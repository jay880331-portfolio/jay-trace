export interface Traceparent {
  version: "00";
  traceId: string;
  spanId: string;
  flags: string;
  value: string;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function createTraceparent(flags = "01"): Traceparent {
  const normalizedFlags = normalizeFlags(flags);
  const traceId = randomHex(16, "traceId");
  const spanId = randomHex(8, "spanId");
  const value = `00-${traceId}-${spanId}-${normalizedFlags}`;

  return {
    version: "00",
    traceId,
    spanId,
    flags: normalizedFlags,
    value
  };
}

export function parseTraceparent(value: string | null | undefined): Traceparent | null {
  if (!value) {
    return null;
  }

  const match = TRACEPARENT_RE.exec(value.trim().toLowerCase());
  if (!match) {
    return null;
  }

  const [, traceId, spanId, flags] = match;
  if (!traceId || !spanId || !flags || isAllZero(traceId) || isAllZero(spanId)) {
    return null;
  }

  return {
    version: "00",
    traceId,
    spanId,
    flags,
    value: `00-${traceId}-${spanId}-${flags}`
  };
}

export function getTraceId(value: string | null | undefined): string | null {
  return parseTraceparent(value)?.traceId ?? null;
}

export function createChildTraceparent(parent: string | Traceparent, flags?: string): Traceparent {
  const parsed = typeof parent === "string" ? parseTraceparent(parent) : parent;
  if (!parsed) {
    return createTraceparent(flags);
  }

  const nextFlags = normalizeFlags(flags ?? parsed.flags);
  const spanId = randomHex(8, "spanId");
  return {
    version: "00",
    traceId: parsed.traceId,
    spanId,
    flags: nextFlags,
    value: `00-${parsed.traceId}-${spanId}-${nextFlags}`
  };
}

function normalizeFlags(flags: string): string {
  const normalized = flags.trim().toLowerCase();
  if (!/^[0-9a-f]{2}$/.test(normalized)) {
    throw new Error(`Invalid trace flags: ${flags}`);
  }
  return normalized;
}

function isAllZero(value: string): boolean {
  return /^0+$/.test(value);
}

export function randomHex(bytes: number, label = "id"): string {
  const output = new Uint8Array(bytes);
  getRandomValues(output);
  const value = Array.from(output, (byte) => byte.toString(16).padStart(2, "0")).join("");

  if (isAllZero(value)) {
    return randomHex(bytes, label);
  }

  if (label === "traceId" && value.length !== 32) {
    throw new Error("Generated invalid traceId");
  }

  if (label === "spanId" && value.length !== 16) {
    throw new Error("Generated invalid spanId");
  }

  return value;
}

function getRandomValues(output: Uint8Array): void {
  const cryptoLike = globalThis.crypto;
  if (cryptoLike?.getRandomValues) {
    cryptoLike.getRandomValues(output);
    return;
  }

  throw new Error("Secure random generator is unavailable");
}
