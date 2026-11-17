import type { JayTraceTimelineDocument } from "@jaytrace/core";
import type { ReplayDocument, ReplayV2SegmentDocument } from "@jaytrace/replay-core";
import type { JoinedTrace } from "./types.js";
import { replayV2DurationSeconds, wireframeFrameCount } from "./join-traces.js";

export function createAnalysisPrompt(trace: JoinedTrace): string {
  const replays = trace.replays.length ? trace.replays : trace.replay ? [trace.replay] : [];
  const parts = [
    "You are analyzing a JayTrace full-stack incident.",
    "Find the most likely root cause, explain the front-to-back sequence, and suggest the smallest safe fix.",
    "Use only the provided lightweight timeline and replay data. Do not assume raw logs exist.",
    "",
    `Trace ID: ${trace.traceId}`,
    "",
    formatIncidentSequence(trace),
    "",
    formatSection("FRONTEND USER TIMELINE", trace.front?.document),
    "",
    formatSection("BACKEND ERROR TIMELINE", trace.back?.document),
    "",
    formatReplaySections(replays),
    "",
    "Return:",
    "1. Root cause",
    "2. Evidence chain",
    "3. Minimal fix",
    "4. Verification command or manual check"
  ];

  return `${parts.join("\n")}\n`;
}

function formatIncidentSequence(trace: JoinedTrace): string {
  const events = [
    ...timelineEvents("front", trace.front?.document),
    ...timelineEvents("back", trace.back?.document),
    ...trace.replays.flatMap((replay, index) => timelineEvents(`replay:${replay.document.schema === "jaytrace.replay.v1" ? replay.document.platform : index + 1}`, replay.document))
  ].sort((left, right) => left.time - right.time);

  if (!events.length) {
    return "INCIDENT SEQUENCE\nmissing";
  }

  return [
    "INCIDENT SEQUENCE",
    ...events.slice(0, 80).map((event) => `- ${event.iso} ${event.source} ${event.line}`)
  ].join("\n");
}

function timelineEvents(source: string, document: JayTraceTimelineDocument | ReplayDocument | ReplayV2SegmentDocument | undefined): Array<{ iso: string; line: string; source: string; time: number }> {
  if (!document || document.schema === "jaytrace.replay.v2") {
    // v2 segments carry rrwebEvents, not line-based events; they get a single summary line elsewhere instead.
    return [];
  }
  const startedAt = Date.parse(document.startedAt);
  const lines = document.schema === "jaytrace.replay.v1" ? document.events : document.timeline;
  return lines.map((line) => {
    const time = startedAt + Math.round(offsetSeconds(line) * 1000);
    return {
      iso: Number.isFinite(time) ? new Date(time).toISOString() : document.startedAt,
      line,
      source,
      time: Number.isFinite(time) ? time : startedAt
    };
  });
}

function offsetSeconds(line: string): number {
  return Number.parseFloat(line.match(/^(\d+(?:\.\d+)?)s\b/)?.[1] ?? "0") || 0;
}

function formatSection(title: string, document: JayTraceTimelineDocument | ReplayDocument | ReplayV2SegmentDocument | undefined): string {
  if (document?.schema === "jaytrace.replay.v1") {
    return formatReplaySection(document);
  }

  if (!document || document.schema === "jaytrace.replay.v2") {
    return `${title}\nmissing`;
  }

  const lines = [
    title,
    `service: ${document.service}`,
    `side: ${document.side}`,
    `startedAt: ${document.startedAt}`,
    document.endedAt ? `endedAt: ${document.endedAt}` : undefined,
    document.summary ? `summary: ${document.summary}` : undefined,
    document.context ? `context: ${JSON.stringify(document.context)}` : undefined,
    document.error ? `error: ${JSON.stringify(document.error)}` : undefined,
    "timeline:",
    ...document.timeline.map((line: string) => `- ${line}`)
  ].filter((line): line is string => Boolean(line));

  return lines.join("\n");
}

function formatReplaySection(document: ReplayDocument | JayTraceTimelineDocument | undefined, index?: number): string {
  if (!document || document.schema !== "jaytrace.replay.v1") {
    return "SESSION REPLAY TIMELINE\nmissing";
  }

  return [
    index ? `SESSION REPLAY TIMELINE ${index}` : "SESSION REPLAY TIMELINE",
    `platform: ${document.platform}`,
    `mode: ${document.mode}`,
    `startedAt: ${document.startedAt}`,
    document.endedAt ? `endedAt: ${document.endedAt}` : undefined,
    document.sessionId ? `sessionId: ${document.sessionId}` : undefined,
    document.metadata ? `metadata: ${JSON.stringify(document.metadata)}` : undefined,
    document.frames?.length ? `frames: ${document.frames.length} captured` : undefined,
    visualFrameCount(document) ? `screens: ${visualFrameCount(document)} captured` : undefined,
    replayScreenshotMissing(document) ? "screens: missing screenshot provider" : undefined,
    document.mutations?.length ? `mutations: ${document.mutations.length} captured` : undefined,
    ...replaySignals(document),
    "events:",
    ...document.events.map((line: string) => `- ${line}`)
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function visualFrameCount(document: ReplayDocument): number {
  return document.frames?.filter((frame) => frame.html || frame.image).length ?? 0;
}

function replayScreenshotMissing(document: ReplayDocument): boolean {
  return (document.platform === "react-native" || document.platform === "flutter") && document.metadata?.["replay.screenshot"] === "missing";
}

function formatReplaySections(replays: JoinedTrace["replays"]): string {
  const v1Replays = replays.filter((replay): replay is JoinedTrace["replays"][number] & { document: ReplayDocument } => replay.document.schema === "jaytrace.replay.v1");
  const v2Replays = replays.filter((replay) => replay.document.schema === "jaytrace.replay.v2");

  const sections: string[] = [];
  if (v1Replays.length) {
    sections.push(v1Replays.map((replay, index) => formatReplaySection(replay.document, index + 1)).join("\n\n"));
  }
  if (v2Replays.length) {
    // Summary only — rrwebEvents/wireframeFrames must never reach the AI prompt.
    const hasWireframe = v2Replays.some((replay) => replay.document.schema === "jaytrace.replay.v2" && replay.document.engine === "wireframe");
    const framesPart = hasWireframe ? ` frames=${wireframeFrameCount(v2Replays)}` : "";
    sections.push(`SESSION REPLAY: v2 segments=${v2Replays.length} duration=${replayV2DurationSeconds(v2Replays)}s${framesPart}`);
  }

  return sections.length ? sections.join("\n\n") : "SESSION REPLAY TIMELINE\nmissing";
}

function replaySignals(document: ReplayDocument): string[] {
  const signals: string[] = [];
  const errors = document.events.filter((line) => /\berror\b|status=5\d\d/.test(line));
  if (errors.length) {
    signals.push("errors:");
    signals.push(...errors.slice(0, 5).map((line) => `- ${line}`));
  }
  const network = document.events.filter((line) => line.includes(" network "));
  if (network.length) {
    signals.push("network:");
    signals.push(...network.slice(0, 5).map((line) => `- ${line}`));
  }
  const performance = document.events.filter((line) => /\bperformance\b|long_task/.test(line));
  if (performance.length) {
    signals.push("performance:");
    signals.push(...performance.slice(0, 5).map((line) => `- ${line}`));
  }
  const actionsBeforeError = actionLinesBeforeIssue(document.events);
  if (actionsBeforeError.length) {
    signals.push("actions before issue:");
    signals.push(...actionsBeforeError.map((line) => `- ${line}`));
  }
  if (document.frames?.length) {
    signals.push("frame summary:");
    signals.push(...replaySummaryFrames(document.frames).map(frameSummaryLine));
  }
  if (document.mutations?.length) {
    signals.push("mutation summary:");
    signals.push(...document.mutations.slice(0, 5).map((mutation) => `- ${mutation.at} ${mutation.type} ${mutation.target}`));
  }
  return signals;
}

function actionLinesBeforeIssue(lines: string[]): string[] {
  const issueTime = Math.min(...lines.filter((line) => /\berror\b|status=5\d\d|failed/i.test(line)).map(offsetSeconds));
  if (!Number.isFinite(issueTime)) {
    return [];
  }
  return lines
    .filter((line) => /\b(click|tap|gesture|action|input|scroll)\b/i.test(line) && offsetSeconds(line) <= issueTime)
    .sort((left, right) => offsetSeconds(left) - offsetSeconds(right))
    .slice(-3);
}

function frameSummaryLine(frame: NonNullable<ReplayDocument["frames"]>[number]): string {
  const point = typeof frame.x === "number" && typeof frame.y === "number" ? ` point=${frame.x},${frame.y}` : "";
  return `- ${frame.at} ${frame.kind} ${frame.type ?? "event"} ${frame.width ?? "?"}x${frame.height ?? "?"}${point}${frame.text ? ` ${frame.text}` : ""}`;
}

function replaySummaryFrames(frames: NonNullable<ReplayDocument["frames"]>) {
  const selected = [
    ...frames.slice(0, 3),
    ...frames.filter((frame) => typeof frame.x === "number" && typeof frame.y === "number"),
    ...frames.filter((frame) => /\berror\b|network|status=5\d\d/i.test(`${frame.kind} ${frame.text}`)),
    [...frames].reverse().find((frame) => frame.html || frame.image)
  ].filter((frame): frame is NonNullable<ReplayDocument["frames"]>[number] => Boolean(frame));

  return [...new Map(selected.map((frame) => [`${frame.at}:${frame.kind}:${frame.text}`, frame])).values()].slice(0, 8);
}
