import { initJayTraceReactNative, type InitJayTraceReactNativeOptions, type JayTraceReactNativeClient, type ReactNativeAppStateLike } from "./init.js";
import { createReactNativeScreenshotProvider } from "./screenshot.js";

export interface JayTraceRootConfig extends Omit<InitJayTraceReactNativeOptions, "apiKey" | "endpoint" | "screenshot"> {
  apiKey: string;
  endpoint: string;
  appState?: ReactNativeAppStateLike;
  captureScreen?: () => Promise<string>;
}

let client: JayTraceReactNativeClient | null = null;

export function ensureJayTraceClient(config: JayTraceRootConfig): JayTraceReactNativeClient {
  if (client) {
    return client;
  }

  const { captureScreen, ...options } = config;
  client = initJayTraceReactNative({
    ...options,
    screenshot: captureScreen
      ? createReactNativeScreenshotProvider({ captureScreen })
      : undefined
  });
  return client;
}

export function getJayTraceClient(): JayTraceReactNativeClient | null {
  return client;
}

export function resetJayTraceClientForTest(): void {
  client?.restore();
  client = null;
}
