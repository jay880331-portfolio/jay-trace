import { randomHex } from "./traceparent.js";

// Datadog-style sessionization: a session ends after 15 minutes of inactivity
// and is hard-capped at 4 hours, after which a new one starts.
export const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
export const SESSION_MAX_DURATION_MS = 4 * 60 * 60 * 1000;

export interface SessionState {
  id: string;
  startedAt: number;
  lastActivityAt: number;
}

/** Optional persistence (e.g. sessionStorage) so sessions survive reloads. */
export interface SessionStorage {
  load(): SessionState | undefined;
  save(state: SessionState): void;
}

export interface SessionManagerOptions {
  timeoutMs?: number;
  maxDurationMs?: number;
  generateId?: () => string;
  storage?: SessionStorage;
  now?: () => number;
}

export interface SessionManager {
  /** Records activity and returns the active session id, rotating expired sessions. */
  touch(): string;
}

export function createSessionManager(options: SessionManagerOptions = {}): SessionManager {
  const timeoutMs = options.timeoutMs ?? SESSION_TIMEOUT_MS;
  const maxDurationMs = options.maxDurationMs ?? SESSION_MAX_DURATION_MS;
  const generateId = options.generateId ?? (() => randomHex(16));
  const now = options.now ?? (() => Date.now());
  let state: SessionState | undefined;

  return {
    touch(): string {
      const at = now();
      let current = state ?? loadValidState(options.storage);
      if (!current || at - current.lastActivityAt > timeoutMs || at - current.startedAt > maxDurationMs) {
        current = { id: generateId(), startedAt: at, lastActivityAt: at };
      } else {
        current.lastActivityAt = at;
      }

      state = current;
      try {
        options.storage?.save(current);
      } catch {
        // Storage quota/privacy-mode failures must never break tracing.
      }
      return current.id;
    }
  };
}

function loadValidState(storage: SessionStorage | undefined): SessionState | undefined {
  if (!storage) {
    return undefined;
  }

  try {
    const state = storage.load();
    if (
      state &&
      typeof state.id === "string" &&
      state.id.length > 0 &&
      Number.isFinite(state.startedAt) &&
      Number.isFinite(state.lastActivityAt)
    ) {
      return state;
    }
  } catch {
    // Corrupt storage → start a fresh session.
  }
  return undefined;
}
