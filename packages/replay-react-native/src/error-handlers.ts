import type { ReactNativeReplayClient } from "./types.js";

export interface ReactNativeErrorUtilsLike {
  getGlobalHandler?: () => ((error: Error, isFatal?: boolean) => void) | undefined;
  setGlobalHandler?: (handler: (error: Error, isFatal?: boolean) => void) => void;
}

export interface ReactNativeErrorHandlerGlobals {
  ErrorUtils?: ReactNativeErrorUtilsLike;
  addEventListener?: (type: "unhandledrejection", handler: (event: { reason?: unknown }) => void) => void;
  removeEventListener?: (type: "unhandledrejection", handler: (event: { reason?: unknown }) => void) => void;
  onunhandledrejection?: ((event: { reason?: unknown }) => void) | null;
}

export interface ReactNativeReplayErrorHandlers {
  uninstall: () => void;
}

export function installReactNativeReplayErrorHandlers(
  client: ReactNativeReplayClient | null,
  globals: ReactNativeErrorHandlerGlobals = globalThis as unknown as ReactNativeErrorHandlerGlobals
): ReactNativeReplayErrorHandlers {
  if (!client) {
    return { uninstall: () => undefined };
  }

  const errorUtils = globals.ErrorUtils;
  const previous = errorUtils?.getGlobalHandler?.();
  const previousUnhandledRejection = globals.onunhandledrejection;
  const handleUnhandledRejection = (event: { reason?: unknown }) => {
    void client?.recordError(event.reason ?? "Unhandled promise rejection").catch(() => undefined);
    previousUnhandledRejection?.(event);
  };

  errorUtils?.setGlobalHandler?.((error, isFatal) => {
    void client?.recordError(error, { fatal: Boolean(isFatal) }).catch(() => undefined);
    previous?.(error, isFatal);
  });
  globals.addEventListener?.("unhandledrejection", handleUnhandledRejection);
  globals.onunhandledrejection = handleUnhandledRejection;

  return {
    uninstall() {
      if (previous) {
        errorUtils?.setGlobalHandler?.(previous);
      }
      globals.removeEventListener?.("unhandledrejection", handleUnhandledRejection);
      globals.onunhandledrejection = previousUnhandledRejection;
    }
  };
}
