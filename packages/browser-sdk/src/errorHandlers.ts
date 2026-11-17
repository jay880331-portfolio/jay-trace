import type { JayTraceError } from "@jaytrace/core";

export interface ErrorHandlers {
  restore(): void;
}

export interface ErrorHandlerOptions {
  addError: (text: string, error?: JayTraceError) => void;
  flush: () => void;
}

export function installErrorHandlers(windowRef: Window, options: ErrorHandlerOptions): ErrorHandlers {
  const onError = (event: ErrorEvent): void => {
    // Runs inside the host 'error' listener — a throw here would itself become an
    // uncaught error, so all SDK bookkeeping is isolated.
    try {
      const message = event.error instanceof Error ? `${event.error.name}: ${event.error.message}` : event.message;
      const location = event.filename ? ` at ${event.filename}:${event.lineno}:${event.colno}` : "";
      options.addError(`window.onerror ${message}${location}`, errorDetails(event.error));
      options.flush();
    } catch {
      // isolation
    }
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    try {
      options.addError(`unhandledrejection ${reasonText(event.reason)}`, errorDetails(event.reason));
      options.flush();
    } catch {
      // isolation
    }
  };

  windowRef.addEventListener("error", onError);
  windowRef.addEventListener("unhandledrejection", onUnhandledRejection);

  return {
    restore() {
      windowRef.removeEventListener("error", onError);
      windowRef.removeEventListener("unhandledrejection", onUnhandledRejection);
    }
  };
}

function reasonText(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`;
  }

  if (typeof reason === "string") {
    return reason;
  }

  return typeof reason;
}

function errorDetails(value: unknown): JayTraceError | undefined {
  if (!(value instanceof Error)) {
    return undefined;
  }

  return {
    name: value.name,
    message: value.message,
    stack: value.stack
  };
}
