import { redact } from "@jaytrace/core";

const MASKED_TEXT = "redacted";
const SENSITIVE_ASSIGNMENT_RE = /\b(password|passwd|token|authorization|cookie|set-cookie|apiKey|api_key|x-api-key|secret)\b\s*[:=]\s*("[^"]*"|'[^']*'|Bearer\s+[^\s,;]+|[^\s,;]+)/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function maskReplayText(value: string, maskText = true): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!maskText) {
    return trimmed.slice(0, 160);
  }

  if (trimmed.length === 0) {
    return "";
  }

  return MASKED_TEXT;
}

export function maskReplayInput(value: string | undefined, maskInputs = true): string {
  if (!value) {
    return "";
  }

  if (maskInputs) {
    return MASKED_TEXT;
  }

  return redactInlineSecrets(value).replace(/\s+/g, " ").trim().slice(0, 80);
}

export function sanitizeReplayLine(value: string): string {
  const result = redact({ value });
  return redactInlineSecrets(result.value).replace(/\s+/g, " ").trim().slice(0, 240);
}

function redactInlineSecrets(value: string): string {
  return value
    .replace(SENSITIVE_ASSIGNMENT_RE, (_match, key: string) => `${key}=redacted`)
    .replace(BEARER_RE, "Bearer redacted");
}
