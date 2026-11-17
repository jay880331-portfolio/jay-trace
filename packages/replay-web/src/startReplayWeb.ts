import { EventType, IncrementalSource, MouseInteractions, record, type eventWithTime } from "rrweb";
import {
  ReplayBuffer,
  ReplaySegmenter,
  ErrorTailBuffer,
  decideReplaySampling,
  type ReplayDocument,
  type ReplayMetadata,
  type ReplayV2SegmentDocument
} from "@jaytrace/replay-core";
import { elementLabel, inputLine, mutationDiff, mutationLine } from "./dom.js";
import { snapshotHtml } from "./snapshot.js";
import type { NormalizedReplayWebOptions, ReplayWebController, StartReplayWebOptions } from "./types.js";

// 768KB: leaves headroom under the collector's 1MB payload budget for the envelope/metadata.
const ERROR_TAIL_MAX_BYTES = 786_432;

/** Assemble a v2 segment document from a drained segment (or error tail). Pure — unit-tested in self-check. */
export function buildSegmentDocument(
  drained: { seq: number; events: unknown[]; startedAt: Date; endedAt: Date },
  meta: { traceId: string; sessionId: string; metadata?: ReplayMetadata }
): ReplayV2SegmentDocument {
  return {
    schema: "jaytrace.replay.v2",
    engine: "rrweb",
    platform: "web",
    traceId: meta.traceId,
    sessionId: meta.sessionId,
    seq: drained.seq,
    startedAt: drained.startedAt.toISOString(),
    endedAt: drained.endedAt.toISOString(),
    metadata: meta.metadata,
    rrwebEvents: drained.events
  };
}

export function startReplayWeb(options: StartReplayWebOptions): ReplayWebController | null {
  const normalized = normalize(options);
  if (!normalized.enabled) {
    return null;
  }

  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }

  const buffer = new ReplayBuffer({
    platform: "web",
    traceId: options.traceId,
    sessionId: options.sessionId,
    traceparent: options.traceparent,
    metadata: options.metadata,
    mode: normalized.mode,
    maxEvents: normalized.maxEvents,
    maxDurationMs: normalized.maxDurationMs,
    now: normalized.now
  });

  let lastScrollAt = 0;
  let stopped = false;

  // --- v2 rrweb raw-event capture state ---
  let engine = normalized.engine;
  const sampled = normalized.sampled;
  const segMeta = () => ({
    traceId: options.traceId,
    sessionId: options.sessionId ?? options.traceId,
    metadata: options.metadata
  });
  const useSegmenter = engine === "rrweb" && sampled && normalized.mode === "always";
  const segmenter = useSegmenter
    ? new ReplaySegmenter({
        flushMs: normalized.segmentFlushMs,
        maxBytes: normalized.maxSegmentBytes,
        maxSessionMs: normalized.maxSessionMs,
        now: normalized.now
      })
    : null;
  const errorTail = engine === "rrweb" && !useSegmenter ? new ErrorTailBuffer({ maxEvents: 2000, maxBytes: ERROR_TAIL_MAX_BYTES }) : null;
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let paused = false;

  let restoreRrweb = startRrweb();
  armTimers();

  // Each DOM listener body runs on the host loop and computes label/now/DOM
  // values before addFrame's own guard, so the whole body is isolated.
  const addViewport = () => {
    silent(() => addFrame("viewport", `viewport ${window.innerWidth}x${window.innerHeight} ${path()}`));
  };

  const onClick = (event: MouseEvent) => {
    silent(() => addFrame("click", `click ${elementLabel(event.target, normalized.maskText)} x=${event.clientX} y=${event.clientY}`, {
      x: event.clientX,
      y: event.clientY
    }));
  };

  const onInput = (event: Event) => {
    silent(() => {
      const line = inputLine(event.target, normalized.maskInputs);
      if (line) {
        addFrame("input", line);
      }
    });
  };

  const onScroll = () => {
    silent(() => {
      const current = normalized.now().getTime();
      if (current - lastScrollAt < 1000) {
        return;
      }
      lastScrollAt = current;
      addFrame("scroll", `scroll x=${Math.round(window.scrollX)} y=${Math.round(window.scrollY)} ${path()}`);
    });
  };

  const onRoute = () => {
    // Also invoked from the patched history.pushState/replaceState — must not
    // propagate into the host's navigation call.
    silent(() => addFrame("route", `route ${path()}`));
  };
  const restoreHistory = patchHistory(onRoute);

  const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver((records) => {
    // MutationObserver callback runs on the host loop — isolate DOM serialization,
    // which can throw on exotic nodes.
    try {
      for (const record of records.slice(0, 5)) {
        buffer.add("mutation", mutationLine(record, normalized.maskText));
        buffer.addMutation(mutationDiff(record, normalized.maskText));
      }
    } catch {
      // isolation
    }
  });

  addViewport();
  window.addEventListener("resize", addViewport, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("popstate", onRoute);
  document.addEventListener("click", onClick, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onInput, true);
  observer?.observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true
  });

  return {
    get engine() {
      return engine;
    },
    recordAction(text: string) {
      addFrame("gesture", `action ${text}`);
    },
    recordNetwork(text: string) {
      addFrame("network", text);
    },
    recordPerformance(text: string) {
      addFrame("gesture", `performance ${text}`);
    },
    setUser(user) {
      try {
        buffer.deleteMetadataPrefix("user.");
        buffer.setMetadata(user ? userMetadata(user) : undefined);
      } catch {
        // isolation
      }
    },
    markError(text: string) {
      // addFrame / promoteErrorTail / flush are each self-isolating below.
      addFrame("error", `error ${text}`);
      promoteErrorTail();
      if (normalized.mode === "on-error" || normalized.mode === "always") {
        void this.flush("error");
      }
    },
    async flush(reason: "error" | "manual") {
      // Public entry point (and fired as void from markError) — must never reject
      // into the host loop; document() and the host flush callback are isolated.
      try {
        if (reason === "manual") {
          flushSegment();
        }
        if (!buffer.hasEvents()) {
          return;
        }
        await options.flush(buffer.document(), reason);
      } catch {
        // isolation
      }
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      // Isolate each teardown step so one failure never skips the rest or throws to the host.
      silent(flushSegment);
      silent(clearTimers);
      silent(removeResumeListeners);
      silent(restoreRrweb);
      silent(() => observer?.disconnect());
      silent(() => window.removeEventListener("resize", addViewport));
      silent(() => window.removeEventListener("scroll", onScroll));
      silent(() => window.removeEventListener("popstate", onRoute));
      silent(() => document.removeEventListener("click", onClick, true));
      silent(() => document.removeEventListener("input", onInput, true));
      silent(() => document.removeEventListener("change", onInput, true));
      silent(restoreHistory);
    }
  };

  function addFrame(kind: "viewport" | "route" | "click" | "input" | "scroll" | "network" | "error" | "gesture", text: string, point?: { x: number; y: number }): void {
    // Universal frame sink for every DOM listener, history-patch route, rrweb emit,
    // and controller record* call — isolate so none of those can throw into the host.
    try {
      buffer.addFrame(kind, text, {
        type: "dom",
        url: window.location.href,
        width: window.innerWidth,
        height: window.innerHeight,
        html: snapshotHtml(normalized.maskText, normalized.maskInputs, normalized.maxSnapshotBytes),
        ...point
      });
    } catch {
      // isolation
    }
  }

  function startRrweb(): () => void {
    try {
      if (engine === "rrweb") {
        return record({
          emit: handleRrwebEvent,
          maskAllInputs: normalized.maskInputs,
          maskTextSelector: normalized.maskText ? "*" : "[data-jaytrace-mask]",
          blockSelector: "[data-jaytrace-hidden]",
          inlineStylesheet: true,
          sampling: { mousemove: 50, scroll: 100, input: "last", media: 800 },
          recordCanvas: false
        }) ?? (() => {});
      }
      // snapshot engine: v1 byte-identical rrweb options (feeds text-summary buffer)
      return record({
        emit: handleRrwebEvent,
        maskAllInputs: normalized.maskInputs,
        maskTextFn: (text) => normalized.maskText ? "redacted" : text,
        inlineStylesheet: true,
        sampling: {
          mousemove: false,
          scroll: 1000,
          input: "last"
        }
      }) ?? (() => {});
    } catch {
      if (engine === "rrweb") {
        engine = "snapshot";
        buffer.setMetadata({ "replay.engine": "snapshot-fallback" });
      }
      return () => {};
    }
  }

  // Route the raw rrweb event to the segmenter or the error-tail buffer.
  // Runs BEFORE the text-summary pipeline, which stays intact for v1 fallback + CLI summaries.
  function captureRawEvent(event: eventWithTime): void {
    if (engine !== "rrweb") {
      return;
    }
    noteActivity();
    if (segmenter) {
      const result = segmenter.add(event);
      if (result === "flush") {
        flushSegment();
      } else if (result === "session-ended") {
        flushSegment();
        stopRrwebRecording();
      }
    } else if (errorTail) {
      errorTail.add(event);
    }
  }

  function flushSegment(): void {
    // Invoked from the flush interval timer, idle timer, and stop() — isolate the
    // drain/assembly so a timer callback never throws uncaught on the host loop.
    try {
      if (!segmenter) {
        return;
      }
      const drained = segmenter.drain();
      if (drained) {
        safeSendSegment(buildSegmentDocument(drained, segMeta()));
      }
    } catch {
      // isolation
    }
  }

  // Host-supplied sendSegment must never break recording — swallow sync throws and async rejections.
  function safeSendSegment(doc: ReplayV2SegmentDocument): void {
    try {
      Promise.resolve(options.sendSegment?.(doc)).catch(() => {});
    } catch {
      // swallow — sync throw from sendSegment must not break recording
    }
  }

  function promoteErrorTail(): void {
    // Called from markError; normalized.now() and assembly are isolated so markError stays safe.
    try {
    if (!errorTail) {
      return;
    }
    const tail = errorTail.drainTail();
    if (tail.length === 0) {
      return;
    }
    const at = normalized.now();
    const meta = segMeta();
    safeSendSegment(
      buildSegmentDocument(
        { seq: 0, events: tail, startedAt: at, endedAt: at },
        {
          ...meta,
          metadata: {
            ...meta.metadata,
            "replay.sampled": String(sampled),
            "replay.reason": "error"
          }
        }
      )
    );
    // drainTail() emptied the buffer, but rrweb only emits a FullSnapshot once at
    // session start. Without re-priming, the next error's tail would hold only
    // incremental events (EventType 3) the player can never render. Ask rrweb for a
    // fresh FullSnapshot; it emits through the same emit callback and lands back in
    // the now-empty errorTail via captureRawEvent — no manual event injection.
    requestFullSnapshot();
    } catch {
      // isolation
    }
  }

  // Re-prime the error tail with a fresh FullSnapshot after a drain (rrweb engine only).
  // Isolated: takeFullSnapshot runs on the host loop and must never throw into markError.
  function requestFullSnapshot(): void {
    if (engine !== "rrweb") {
      return;
    }
    silent(() => record.takeFullSnapshot());
  }

  // --- timers + idle pause / resume ---
  function armTimers(): void {
    if (engine !== "rrweb" || stopped || paused) {
      return;
    }
    if (segmenter && !flushTimer) {
      flushTimer = setInterval(flushSegment, normalized.segmentFlushMs);
      // Node returns Timeout (unref exists), browsers return number — cast so DOM-lib builds compile.
      (flushTimer as unknown as { unref?: () => void }).unref?.();
    }
    armIdleTimer();
  }

  function armIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(pauseForIdle, normalized.idlePauseMs);
    (idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  function noteActivity(): void {
    if (!paused) {
      armIdleTimer();
    }
  }

  function clearTimers(): void {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  // Session ended (maxSessionMs): stop recording but keep the controller alive.
  function stopRrwebRecording(): void {
    clearTimers();
    removeResumeListeners();
    restoreRrweb();
  }

  function pauseForIdle(): void {
    // setTimeout callback — isolate so rrweb's stop (restoreRrweb) never throws uncaught.
    try {
      if (paused || stopped) {
        return;
      }
      flushSegment();
      paused = true;
      clearTimers();
      // restoreRrweb still points at this already-invoked stop fn until onResume reassigns it;
      // stop() called while paused will invoke it again — relies on rrweb's stop being idempotent (verified acceptable).
      restoreRrweb();
      window.addEventListener("click", onResume, true);
      window.addEventListener("keydown", onResume, true);
      window.addEventListener("scroll", onResume, { passive: true });
    } catch {
      // isolation
    }
  }

  function onResume(): void {
    if (stopped) {
      return;
    }
    removeResumeListeners();
    paused = false;
    restoreRrweb = startRrweb(); // rrweb re-emits a fresh full snapshot on restart
    armTimers();
  }

  function removeResumeListeners(): void {
    window.removeEventListener("click", onResume, true);
    window.removeEventListener("keydown", onResume, true);
    window.removeEventListener("scroll", onResume);
  }

  function handleRrwebEvent(event: eventWithTime): void {
    try {
      handleRrwebEventUnsafe(event);
    } catch {
      // isolation: this is rrweb's emit callback — a throw here would break rrweb recording
    }
  }

  function handleRrwebEventUnsafe(event: eventWithTime): void {
    captureRawEvent(event);

    if (event.type === EventType.Meta) {
      const data = event.data;
      addFrame("viewport", `viewport ${data.width}x${data.height} ${pathFromHref(data.href)}`);
      return;
    }

    if (event.type === EventType.FullSnapshot) {
      buffer.add("mutation", "rrweb full_snapshot");
      return;
    }

    if (event.type !== EventType.IncrementalSnapshot) {
      return;
    }

    const data = event.data;
    if (data.source === IncrementalSource.Mutation) {
      const text = `rrweb mutation adds=${data.adds.length} removes=${data.removes.length} attributes=${data.attributes.length} texts=${data.texts.length}`;
      buffer.add("mutation", text);
      buffer.addMutation({
        target: "rrweb",
        type: data.attributes.length || data.texts.length ? "attributes" : "childList",
        removedCount: data.removes.length
      });
      return;
    }

    if (data.source === IncrementalSource.MouseInteraction && data.type === MouseInteractions.Click) {
      addFrame("click", `click rrweb x=${data.x ?? 0} y=${data.y ?? 0}`, { x: data.x ?? 0, y: data.y ?? 0 });
      return;
    }

    if (data.source === IncrementalSource.Input) {
      addFrame("input", `input rrweb value=${normalized.maskInputs ? "redacted" : data.text}`);
      return;
    }

    if (data.source === IncrementalSource.Scroll) {
      addFrame("scroll", `scroll x=${Math.round(data.x)} y=${Math.round(data.y)} ${path()}`);
      return;
    }

    if (data.source === IncrementalSource.ViewportResize) {
      addFrame("viewport", `viewport ${data.width}x${data.height} ${path()}`);
    }
  }
}

function silent(fn: () => void): void {
  try {
    fn();
  } catch {
    // isolation: teardown/bookkeeping must never throw into the host
  }
}

function userMetadata(user: Record<string, unknown>): Record<string, string | number | boolean | null | undefined> {
  return Object.fromEntries(Object.entries(user).map(([key, value]) => [`user.${key}`, primitive(value)]));
}

function primitive(value: unknown): string | number | boolean | null | undefined {
  return value === null || ["string", "number", "boolean", "undefined"].includes(typeof value) ? value as string | number | boolean | null | undefined : String(value);
}

function patchHistory(onRoute: () => void): () => void {
  if (!window.history) {
    return () => {};
  }

  const pushState = window.history.pushState.bind(window.history);
  const replaceState = window.history.replaceState.bind(window.history);
  window.history.pushState = (...args) => {
    const result = pushState(...args);
    onRoute();
    return result;
  };
  window.history.replaceState = (...args) => {
    const result = replaceState(...args);
    onRoute();
    return result;
  };

  return () => {
    window.history.pushState = pushState;
    window.history.replaceState = replaceState;
  };
}

export function normalize(options: StartReplayWebOptions): NormalizedReplayWebOptions {
  const privacy = options.privacy ?? "mask-all";
  const engine = options.engine === "snapshot" ? "snapshot" : "rrweb";
  const v1Enabled = options.enabled === true && options.mode !== "off";
  // v1/snapshot: sampleRate (0-100) gates enablement, byte-identical to prior behavior.
  // v2/rrweb: sampling never disables — unsampled sessions fall back to the error tail.
  const enabled = engine === "snapshot" ? v1Enabled && sampleRate(options.sampleRate ?? 100) : v1Enabled;
  return {
    enabled,
    engine,
    sampled: decideReplaySampling(rrwebSampleRate(options.sampleRate ?? 1), options.random),
    mode: options.mode === "always" ? "always" : "on-error",
    maskText: options.maskText ?? privacy === "mask-all",
    maskInputs: options.maskInputs ?? privacy !== "allow",
    maxEvents: options.maxEvents ?? 200,
    maxDurationMs: options.maxDurationMs ?? 30_000,
    maxSnapshotBytes: options.maxSnapshotBytes ?? 768_000,
    segmentFlushMs: options.segmentFlushMs ?? 10_000,
    maxSegmentBytes: options.maxSegmentBytes ?? 262_144,
    maxSessionMs: options.maxSessionMs ?? 1_800_000,
    idlePauseMs: options.idlePauseMs ?? 300_000,
    now: options.now ?? (() => new Date())
  };
}

function sampleRate(rate: number): boolean {
  const clamped = Math.max(0, Math.min(rate, 100));
  return clamped >= 100 || Math.random() * 100 < clamped;
}

// v1 callers passed 0-100 percentages; >1 can only be legacy percent
function rrwebSampleRate(rate: number): number {
  return rate > 1 ? rate / 100 : rate;
}

function path(): string {
  return `${window.location.pathname}${window.location.hash}`;
}

function pathFromHref(href: string): string {
  try {
    const url = new URL(href);
    return `${url.pathname}${url.hash}`;
  } catch {
    return path();
  }
}

export type { ReplayDocument };
