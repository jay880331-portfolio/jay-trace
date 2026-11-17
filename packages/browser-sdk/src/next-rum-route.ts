declare const process:
  | {
      env?: Record<string, string | undefined>;
    }
  | undefined;

const DEFAULT_RUM_ENDPOINT = "http://localhost:3012/jaytrace/rum";

export interface JayTraceRumProxyOptions {
  endpoint?: string;
  apiKey?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
}

export function createJayTraceRumProxy(options: JayTraceRumProxyOptions = {}) {
  return async function POST(request: Request): Promise<Response> {
    const env = options.env ?? safeEnv();
    const endpoint = options.endpoint ?? env.JAYTRACE_RUM_ENDPOINT ?? DEFAULT_RUM_ENDPOINT;
    const apiKey = options.apiKey ?? env.JAYTRACE_API_KEY ?? env.NEXT_PUBLIC_JAYTRACE_API_KEY ?? "local-dev-key";
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": request.headers.get("content-type") ?? "application/json",
        traceparent: request.headers.get("traceparent") ?? ""
      },
      body: withServerApiKey(await request.text(), apiKey)
    });

    return new Response(await response.text(), {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json"
      }
    });
  };
}

export const POST = createJayTraceRumProxy();

function withServerApiKey(rawBody: string, apiKey: string): string {
  try {
    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    payload.apiKey = apiKey;
    return JSON.stringify(payload);
  } catch {
    return rawBody;
  }
}

function safeEnv(): Record<string, string | undefined> {
  return typeof process === "undefined" ? {} : process.env ?? {};
}
