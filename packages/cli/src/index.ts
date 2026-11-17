import { parseArgs } from "./args.js";
import { collectTraceFiles } from "./fs.js";
import { joinTraces, replayV2DurationSeconds, wireframeFrameCount } from "./join-traces.js";
import { createAnalysisPrompt } from "./prompt.js";
import { runAi, runAwsSync } from "./runner.js";
import type { ReplayPlatform } from "./types.js";

export { collectTraceFiles } from "./fs.js";
export { joinTraces } from "./join-traces.js";
export { createAnalysisPrompt } from "./prompt.js";
export { parseArgs } from "./args.js";
export type { AiRunner, CliOptions, JoinedTrace, TraceFile } from "./types.js";

if (isMain()) {
  const exitCode = await main(process.argv.slice(2));
  process.exitCode = exitCode;
}

export async function main(argv: string[]): Promise<number> {
  try {
    const options = parseArgs(argv);
    if (options.syncS3) {
      const syncCode = await runAwsSync(options.syncS3, options.logsDir);
      if (syncCode !== 0) {
        return syncCode;
      }
      if (options.syncOnly) {
        process.stderr.write(`[jaytrace] synced ${options.syncS3} to ${options.logsDir}. Run with --list or --ai to analyze.\n`);
        return 0;
      }
    }

    const files = await collectTraceFiles(options.logsDir);
    const traces = joinTraces(files, options.traceId)
      .filter(trace => !options.sessionId || traceSessions(trace).includes(options.sessionId))
      .filter(trace => !options.platform || tracePlatforms(trace).includes(options.platform))
      .filter(trace => replayScreens(trace) >= (options.minScreens ?? 0))
      .slice(0, options.limit);

    if (traces.length === 0) {
      process.stderr.write(`[jaytrace] no trace timeline JSON files found in ${options.logsDir}\n`);
      return 1;
    }

    if (options.list) {
      printTraceList(traces);
      return 0;
    }

    let exitCode = 0;
    for (const trace of traces) {
      const prompt = createAnalysisPrompt(trace);
      const code = await runAi(options.ai, options.model, prompt);
      if (code !== 0) {
        exitCode = code;
      }
    }

    return exitCode;
  } catch (error) {
    process.stderr.write(`[jaytrace] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function printTraceList(traces: ReturnType<typeof joinTraces>): void {
  for (const trace of traces) {
    process.stdout.write(
      [
        trace.traceId,
        `status=${traceStatus(trace)}`,
        `front=${trace.front ? "yes" : "no"}`,
        `back=${trace.back ? "yes" : "no"}`,
        ...formatReplayParts(trace),
        `screens=${replayScreens(trace)}`,
        `actions=${replayEvents(trace, /^(click|tap|input|scroll)\b|^gesture\s+(?!performance\b)/)}`,
        `performance=${replayEvents(trace, /\bperformance\b|long_task/)}`,
        `network=${replayEvents(trace, /^network\b|\snetwork\s|status=\d+/)}`,
        `errors=${replayEvents(trace, /^error\b|\berror\b|status=5\d\d/)}`,
        `screenshots=${missingScreenshotProviders(trace) ? "missing" : "ok"}`,
        `platforms=${replayPlatforms(trace) || "none"}`,
        `sessions=${replaySessions(trace) || "none"}`
      ].join(" ") + "\n"
    );
  }
}

// v1-only traces keep "replay=yes"/"replay=no"; traces with v2 segments report a segment/duration summary instead.
function formatReplayParts(trace: ReturnType<typeof joinTraces>[number]): string[] {
  const v2Segments = trace.replays.filter((replay) => replay.document.schema === "jaytrace.replay.v2");
  if (v2Segments.length > 0) {
    const parts = ["replay=v2", `segments=${v2Segments.length}`, `duration=${replayV2DurationSeconds(v2Segments)}s`];
    const frames = wireframeFrameCount(v2Segments);
    if (v2Segments.some((replay) => replay.document.schema === "jaytrace.replay.v2" && replay.document.engine === "wireframe")) {
      parts.push(`frames=${frames}`);
    }
    return parts;
  }
  return [`replay=${trace.replay ? "yes" : "no"}`];
}

function traceStatus(trace: ReturnType<typeof joinTraces>[number]): "error" | "warning" | "ok" {
  if ([trace.front, trace.back].some(file => file?.document.schema === "jaytrace.timeline.v1" && file.document.error)) {
    return "error";
  }
  if (trace.replays.some(replay => replay.document.schema === "jaytrace.replay.v1" && replay.document.events.some(line => /\berror\b|status=5\d\d/.test(line)))) {
    return "error";
  }
  return trace.front && trace.back ? "ok" : "warning";
}

function replayPlatforms(trace: ReturnType<typeof joinTraces>[number]): string {
  return tracePlatforms(trace).join(",");
}

function tracePlatforms(trace: ReturnType<typeof joinTraces>[number]): ReplayPlatform[] {
  return [...new Set(trace.replays.map(replay => replay.document.schema === "jaytrace.replay.v1" || replay.document.schema === "jaytrace.replay.v2" ? replay.document.platform : undefined).filter((platform): platform is ReplayPlatform => Boolean(platform)))].sort();
}

function replayScreens(trace: ReturnType<typeof joinTraces>[number]): number {
  return trace.replays.reduce((total, replay) => {
    if (replay.document.schema !== "jaytrace.replay.v1") {
      return total;
    }
    return total + (replay.document.frames?.filter(frame => frame.html || frame.image).length ?? 0);
  }, 0);
}

function replayEvents(trace: ReturnType<typeof joinTraces>[number], pattern: RegExp): number {
  return trace.replays.reduce((total, replay) => {
    if (replay.document.schema !== "jaytrace.replay.v1") {
      return total;
    }
    return total + replay.document.events.filter(line => pattern.test(line.replace(/^\d+(?:\.\d+)?s\s+/, ""))).length;
  }, 0);
}

function missingScreenshotProviders(trace: ReturnType<typeof joinTraces>[number]): boolean {
  return trace.replays.some(replay => replay.document.schema === "jaytrace.replay.v1" && (replay.document.platform === "react-native" || replay.document.platform === "flutter") && replay.document.metadata?.["replay.screenshot"] === "missing");
}

function replaySessions(trace: ReturnType<typeof joinTraces>[number]): string {
  return traceSessions(trace).join(",");
}

function traceSessions(trace: ReturnType<typeof joinTraces>[number]): string[] {
  return [...new Set([
    trace.front?.document.sessionId,
    trace.back?.document.sessionId,
    ...trace.replays.map(replay => replay.document.schema === "jaytrace.replay.v1" || replay.document.schema === "jaytrace.replay.v2" ? replay.document.sessionId : undefined)
  ].filter((sessionId): sessionId is string => Boolean(sessionId)))].sort();
}

function isMain(): boolean {
  return process.argv[1]?.endsWith("/jaytrace-check") === true || process.argv[1]?.endsWith("/dist/index.js") === true;
}
