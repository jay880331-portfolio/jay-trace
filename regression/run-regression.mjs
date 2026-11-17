// JayTrace regression fixture runner.
// Loads the frozen S3-shaped fixtures, exercises the REAL CLI API, and asserts
// every `expected` field per scenario. No live devices/servers/S3.
//
// Usage: node regression/run-regression.mjs   (or: pnpm test:regression)
// Requires the CLI to be built first (pnpm build) so @jaytrace/cli/dist exists.

import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let collectTraceFiles, joinTraces, createAnalysisPrompt, main;
try {
  ({ collectTraceFiles, joinTraces, createAnalysisPrompt, main } = await import("@jaytrace/cli"));
} catch (error) {
  console.error("[regression] could not import @jaytrace/cli. Run `pnpm build` first (it emits packages/cli/dist).");
  console.error(`[regression] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const scenarioFiles = ["offline-reconnect", "minified-stack", "mobile-no-screenshot"];

// Reference derivation of the spec's dashboardBadges from replay network events. No product/dashboard
// implementation exists yet; this validates that the pipeline preserves the failure+recovery event
// strings the badges would be derived from.
// Push "network:error" on a network error event, "network:recovered" on a LATER 2xx network event.
function deriveNetworkBadges(events) {
  const badges = [];
  events.forEach((line, index) => {
    if (/network .*error=/.test(line)) {
      badges.push("network:error");
    }
    if (/network .*status=2\d\d/.test(line) && events.slice(0, index).some((prior) => /network .*error=/.test(prior))) {
      badges.push("network:recovered");
    }
  });
  return badges;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Writes each input document to <tmp>/prod/2026/07/01/<traceId>/<file>, then runs the real CLI collect+join.
async function loadScenario(scenario) {
  const tmp = await mkdtemp(join(tmpdir(), `jaytrace-regression-${scenario.scenario}-`));
  for (const { file, document } of scenario.input) {
    const dir = join(tmp, "prod", "2026", "07", "01", document.traceId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, file), JSON.stringify(document, null, 2));
  }
  const files = await collectTraceFiles(tmp);
  const traces = joinTraces(files);
  return { tmp, files, traces };
}

// Each verifier returns [{ name, pass, detail }]. `expected` is the fixture's expected block.
const verifiers = {
  "offline-reconnect"({ traces }, expected, input) {
    const results = [];
    const trace = traces.find((t) => t.traceId === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const events = trace?.replay?.document.events ?? [];
    const inputEventCount = input[0].document.events.length;
    const lostEvents = inputEventCount - events.length;
    results.push({
      name: "lostEvents",
      pass: lostEvents === expected.lostEvents,
      detail: `joined ${events.length}/${inputEventCount} events, lost=${lostEvents} (expected ${expected.lostEvents})`
    });
    const containsFailureAndRecovery =
      events.some((line) => /error=Network request failed/.test(line)) && events.some((line) => /status=201/.test(line));
    results.push({
      name: "containsFailureAndRecovery",
      pass: containsFailureAndRecovery === expected.containsFailureAndRecovery,
      detail: `failure+recovery=${containsFailureAndRecovery} (expected ${expected.containsFailureAndRecovery})`
    });
    const sessionId = trace?.replay?.document.sessionId;
    results.push({
      name: "sameSessionId",
      pass: sessionId === expected.sameSessionId,
      detail: `sessionId=${sessionId} (expected ${expected.sameSessionId})`
    });
    const badges = deriveNetworkBadges(events);
    results.push({
      name: "dashboardBadges",
      pass: deepEqual(badges, expected.dashboardBadges),
      detail: `derived=${JSON.stringify(badges)} (expected ${JSON.stringify(expected.dashboardBadges)})`
    });
    return results;
  },

  "minified-stack"({ traces }, expected) {
    const results = [];
    const matching = traces.filter((t) => t.traceId === "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const trace = matching[0];
    const joinedByTraceId = matching.length === 1 && Boolean(trace?.front) && Boolean(trace?.back);
    results.push({
      name: "joinedByTraceId",
      pass: joinedByTraceId === expected.joinedByTraceId,
      detail: `traces=${matching.length} front=${Boolean(trace?.front)} back=${Boolean(trace?.back)}`
    });
    const release = trace?.front?.document.context?.release;
    results.push({
      name: "release",
      pass: release === expected.release,
      detail: `release=${release} (expected ${expected.release})`
    });
    const prompt = trace ? createAnalysisPrompt(trace) : "";
    const missing = expected.aiPromptContains.filter((needle) => !prompt.includes(needle));
    results.push({
      name: "aiPromptContains",
      pass: missing.length === 0,
      detail: missing.length ? `prompt missing: ${JSON.stringify(missing)}` : `prompt contains all ${expected.aiPromptContains.length} substrings`
    });
    return results;
  },

  async "mobile-no-screenshot"({ traces, tmp }, expected) {
    const results = [];
    const trace = traces.find((t) => t.traceId === "cccccccccccccccccccccccccccccccc");
    const doc = trace?.replay?.document;
    let promptOk = false;
    let promptError = "";
    try {
      createAnalysisPrompt(trace);
      promptOk = true;
    } catch (error) {
      promptError = error instanceof Error ? error.message : String(error);
    }
    const noFrames = !doc?.frames || doc.frames.length === 0;
    results.push({
      name: "rendersWithoutFrames",
      pass: (noFrames && promptOk) === expected.rendersWithoutFrames,
      detail: `noFrames=${noFrames} promptRan=${promptOk}${promptError ? ` err=${promptError}` : ""}`
    });
    // Belt-and-suspenders: metadata itself carries the flag missingScreenshotProviders() reads.
    const showsMissing = doc?.metadata?.["replay.screenshot"] === "missing";
    results.push({
      name: "showsScreenshotsMissing",
      pass: showsMissing === expected.showsScreenshotsMissing,
      detail: `replay.screenshot=${doc?.metadata?.["replay.screenshot"]}`
    });

    // Exercises the REAL CLI `--list` path (index.ts printTraceList + missingScreenshotProviders),
    // not a reimplementation: run main() and grep its captured stdout.
    const originalWrite = process.stdout.write;
    let captured = "";
    process.stdout.write = (chunk) => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    try {
      await main(["--logs-dir", tmp, "--list", "--platform", "flutter"]);
    } finally {
      process.stdout.write = originalWrite;
    }
    const cliListLine = captured.split("\n").find((line) => line.startsWith(trace?.traceId ?? "\0"));
    results.push({
      name: "cliListShowsScreenshotsMissing",
      pass: Boolean(cliListLine?.includes("screenshots=missing")) === expected.showsScreenshotsMissing,
      detail: `cli --list line: ${JSON.stringify(cliListLine)}`
    });
    results.push({
      name: "cliListShowsPlatformFilter",
      pass: Boolean(cliListLine?.includes("platforms=flutter")),
      detail: `cli --list line: ${JSON.stringify(cliListLine)}`
    });
    const containsTap = (doc?.events ?? []).some((line) => /x=140 y=620/.test(line));
    results.push({
      name: "containsTapCoordinates",
      pass: containsTap === expected.containsTapCoordinates,
      detail: `tapCoords=${containsTap}`
    });
    // CLI derives platforms off replay.document.platform; assert the doc AND that the derived set includes it.
    const platforms = [...new Set((trace?.replays ?? []).map((r) => r.document.platform))];
    const platformOk = doc?.platform === expected.platformFilter && platforms.includes(expected.platformFilter);
    results.push({
      name: "platformFilter",
      pass: platformOk,
      detail: `platform=${doc?.platform} derived=${JSON.stringify(platforms)} (expected ${expected.platformFilter})`
    });
    return results;
  }
};

let allPass = true;
for (const name of scenarioFiles) {
  const scenario = JSON.parse(await readFile(join(here, "scenarios", `${name}.json`), "utf8"));
  const loaded = await loadScenario(scenario);
  const results = await verifiers[scenario.scenario](loaded, scenario.expected, scenario.input);
  await rm(loaded.tmp, { recursive: true, force: true });

  const failed = results.filter((r) => !r.pass);
  if (failed.length === 0) {
    console.log(`PASS ${scenario.scenario} (${results.length} assertions)`);
  } else {
    allPass = false;
    console.log(`FAIL ${scenario.scenario}`);
    for (const r of failed) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
  }
  for (const r of results) {
    console.log(`     ${r.pass ? "ok  " : "FAIL"} ${r.name}: ${r.detail}`);
  }
}

console.log(allPass ? "\nregression: 3/3 scenarios PASS" : "\nregression: FAILURES above");
process.exit(allPass ? 0 : 1);
