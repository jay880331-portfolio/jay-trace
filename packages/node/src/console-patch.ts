import { format } from "node:util";

export type JayTraceConsoleSeverity = "debug" | "info" | "warn" | "error";

const SEVERITY_BY_METHOD = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug"
} as const satisfies Record<string, JayTraceConsoleSeverity>;

type PatchedMethod = keyof typeof SEVERITY_BY_METHOD;

/**
 * Wraps `console.log/info/warn/error/debug` so each call still reaches the original
 * method first and is then reported to `emit` as `util.format`-ed text (cycle safe).
 * A re-entrancy flag keeps console calls made from inside `emit` on the original
 * methods only. Returns the unpatch function.
 */
export function patchConsole(emit: (severity: JayTraceConsoleSeverity, text: string) => void): () => void {
  let emitting = false;
  const restore: Array<() => void> = [];

  for (const method of Object.keys(SEVERITY_BY_METHOD) as PatchedMethod[]) {
    const original = console[method];
    const severity = SEVERITY_BY_METHOD[method];

    console[method] = (...args: unknown[]): void => {
      original.apply(console, args);
      if (emitting) {
        return;
      }

      emitting = true;
      try {
        emit(severity, format(...args));
      } catch {
        // A throwing sink must never break the app's own logging.
      } finally {
        emitting = false;
      }
    };

    restore.push(() => {
      console[method] = original;
    });
  }

  return () => {
    for (const undo of restore) {
      undo();
    }
  };
}
