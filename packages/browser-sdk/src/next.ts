import { initJayTrace } from "./initJayTrace.js";
import type { BrowserReplayOptions, InitJayTraceOptions, JayTraceClient } from "./types.js";

// Runtime absence of `process` is handled by safeEnv's try/catch.
declare const process: {
  env: Record<string, string | undefined>;
};

export interface InitJayTraceNextOptions extends Omit<InitJayTraceOptions, "apiKey"> {
  apiKey?: string;
  env?: Record<string, string | undefined>;
}

export function initJayTraceNext(options: InitJayTraceNextOptions = {}): JayTraceClient {
  const env = options.env ?? safeEnv();
  const apiKey = options.apiKey ?? env.NEXT_PUBLIC_JAYTRACE_QA_API_KEY ?? env.NEXT_PUBLIC_JAYTRACE_API_KEY;
  const isProduction = (env.NEXT_PUBLIC_APP_ENV ?? env.NODE_ENV) === "production";
  const endpoint = options.endpoint ?? env.NEXT_PUBLIC_JAYTRACE_ENDPOINT ?? "/jaytrace/rum";
  const traceOrigins = options.traceOrigins ?? deriveTraceOrigins(endpoint, env.NEXT_PUBLIC_JAYTRACE_TRACE_ORIGINS);
  const traceparent = options.traceparent ?? readSSRTraceparentMeta();

  return initJayTrace({
    ...options,
    enabled: options.enabled ?? (!isProduction || Boolean(apiKey)),
    apiKey: apiKey ?? "local-dev-key",
    endpoint,
    traceparent,
    service: options.service ?? env.NEXT_PUBLIC_JAYTRACE_SERVICE ?? "web",
    release: options.release ?? env.NEXT_PUBLIC_JAYTRACE_RELEASE ?? env.NEXT_PUBLIC_APP_VERSION,
    environment: options.environment ?? env.NEXT_PUBLIC_APP_ENV ?? env.NODE_ENV,
    traceOrigins,
    replay: resolveNextReplayOptions(env, traceOrigins, options.replay)
  });
}

// Merge order matters: explicit options.replay fields must win over env-derived
// defaults, which in turn win over the hardcoded base. Swapping spread order
// here silently breaks that precedence — see self-check.ts replay-merge assertions.
export function resolveNextReplayOptions(
  env: Record<string, string | undefined>,
  traceOrigins: string[],
  replay?: Partial<BrowserReplayOptions>
): BrowserReplayOptions {
  return {
    enabled: true,
    mode: "on-error",
    privacy: "mask-all",
    networkOrigins: traceOrigins,
    ...resolveReplayEnvDefaults(env),
    ...replay
  };
}

// Env-derived replay defaults; explicit options.replay fields override these.
export function resolveReplayEnvDefaults(env: Record<string, string | undefined>): Partial<BrowserReplayOptions> {
  const defaults: Partial<BrowserReplayOptions> = {};
  const mode = env.NEXT_PUBLIC_JAYTRACE_REPLAY_MODE;
  if (mode === "always" || mode === "on-error" || mode === "off") {
    defaults.mode = mode;
  }
  const rawRate = env.NEXT_PUBLIC_JAYTRACE_REPLAY_SAMPLE_RATE;
  if (rawRate !== undefined && rawRate !== "" && Number.isFinite(Number(rawRate))) {
    defaults.sampleRate = Number(rawRate);
  }
  const privacy = env.NEXT_PUBLIC_JAYTRACE_REPLAY_PRIVACY;
  if (privacy === "mask-all" || privacy === "mask-inputs" || privacy === "allow") {
    defaults.privacy = privacy;
  }
  return defaults;
}

export function deriveTraceOrigins(endpoint: string, envList: string | undefined): string[] {
  const fromEnv = (envList ?? "")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);
  try {
    // 상대 endpoint(new URL 실패)는 same-origin이므로 cross-origin 유도가 필요 없다.
    const endpointOrigin = new URL(endpoint).origin;
    return [...new Set([endpointOrigin, ...fromEnv])];
  } catch {
    return [...new Set(fromEnv)];
  }
}

// Reads the SSR root traceparent that the root layout injected into <head> via
// `<meta name="jaytrace-traceparent" content={(await getJayTraceSSRTraceparent()) ?? ""} />`.
// Returns undefined outside a browser, when the tag is missing, or when its
// content is empty — initJayTrace then generates its own root. Fully isolated.
function readSSRTraceparentMeta(): string | undefined {
  try {
    if (typeof document === "undefined") {
      return undefined;
    }
    const content = document.querySelector('meta[name="jaytrace-traceparent"]')?.getAttribute("content");
    return content ? content : undefined;
  } catch {
    return undefined;
  }
}

export const MyRUM = {
  init: initJayTraceNext
};

function safeEnv(): Record<string, string | undefined> {
  // Next.js bundlers only inline literal `process.env.NEXT_PUBLIC_*` member
  // expressions, so each key must be spelled out for browser bundles.
  try {
    return {
      NEXT_PUBLIC_JAYTRACE_QA_API_KEY: process.env.NEXT_PUBLIC_JAYTRACE_QA_API_KEY,
      NEXT_PUBLIC_JAYTRACE_API_KEY: process.env.NEXT_PUBLIC_JAYTRACE_API_KEY,
      NEXT_PUBLIC_JAYTRACE_SERVICE: process.env.NEXT_PUBLIC_JAYTRACE_SERVICE,
      NEXT_PUBLIC_JAYTRACE_ENDPOINT: process.env.NEXT_PUBLIC_JAYTRACE_ENDPOINT,
      NEXT_PUBLIC_JAYTRACE_TRACE_ORIGINS: process.env.NEXT_PUBLIC_JAYTRACE_TRACE_ORIGINS,
      NEXT_PUBLIC_JAYTRACE_RELEASE: process.env.NEXT_PUBLIC_JAYTRACE_RELEASE,
      NEXT_PUBLIC_JAYTRACE_REPLAY_MODE: process.env.NEXT_PUBLIC_JAYTRACE_REPLAY_MODE,
      NEXT_PUBLIC_JAYTRACE_REPLAY_SAMPLE_RATE: process.env.NEXT_PUBLIC_JAYTRACE_REPLAY_SAMPLE_RATE,
      NEXT_PUBLIC_JAYTRACE_REPLAY_PRIVACY: process.env.NEXT_PUBLIC_JAYTRACE_REPLAY_PRIVACY,
      NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION,
      NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
      NODE_ENV: process.env.NODE_ENV
    };
  } catch {
    return {};
  }
}
