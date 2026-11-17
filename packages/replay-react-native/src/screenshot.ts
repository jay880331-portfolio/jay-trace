import type { ReactNativeScreenshotFrame } from "./types.js";

const DEFAULT_MAX_SCREENSHOT_BYTES = 320_000;

export interface ReactNativeCaptureScreenOptions {
  format: "png" | "jpg";
  result: "base64";
  quality: number;
}

export interface ReactNativeScreenshotProviderOptions {
  captureScreen: (options: ReactNativeCaptureScreenOptions) => string | Promise<string>;
  enabled?: () => boolean | Promise<boolean>;
  format?: "png" | "jpg";
  quality?: number;
  width?: number;
  height?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

export function createReactNativeScreenshotProvider(options: ReactNativeScreenshotProviderOptions) {
  return async (): Promise<ReactNativeScreenshotFrame | null> => {
    if (options.enabled && !await enabled(options.enabled)) {
      return null;
    }

    const format = options.format ?? "png";
    const base64 = await capture(options, format);

    if (!base64) {
      return null;
    }
    if (base64.startsWith("data:") && !/^data:image\/[a-z0-9.+-]+;base64,/i.test(base64)) {
      return null;
    }
    const raw = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
    if (base64ByteLength(raw) > (options.maxBytes ?? DEFAULT_MAX_SCREENSHOT_BYTES)) {
      return null;
    }

    return {
      image: base64.startsWith("data:") ? base64 : `data:image/${format};base64,${base64}`,
      mediaType: `image/${format}`,
      width: options.width,
      height: options.height
    };
  };
}

async function capture(options: ReactNativeScreenshotProviderOptions, format: "png" | "jpg"): Promise<string | null> {
  try {
    return await withTimeout(
      Promise.resolve(options.captureScreen({
        format,
        result: "base64",
        quality: options.quality ?? 0.6
      })),
      options.timeoutMs ?? 1000
    );
  } catch {
    return null;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("JayTrace React Native screenshot timed out")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function enabled(check: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}

function base64ByteLength(value: string): number {
  const normalized = value.replace(/\s/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}
