#!/usr/bin/env node
// Console scale bench: generates a synthetic local-mode logs tree, boots the
// Next.js console against it, and measures /api/traces, /api/replay, and
// /api/issues latency
// at scale. Regression guard for the /api/traces segment-exclusion
// optimization (apps/next-app/app/api/lib/documents.ts). Node builtins only.
//
// Phases: 1) generate synthetic docs into a temp dir  2) spawn `next dev`
// pointed at that dir via JAYTRACE_LOGS_DIR, wait for readiness, warm once
// 3) measure p50/p95 for all endpoints, assert thresholds  4) kill the
// server and delete the temp dir/build cache, always (finally).
//
// Overrides: BENCH_TRACES (default 10000), BENCH_SESSIONS (default 1),
// BENCH_PORT (default 3097). Each trace has one timeline document; the ten
// replay segments reuse an existing trace ID so the fixture stays at 10,000 traces.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { issueFingerprint } from "../apps/next-app/app/lib/issues.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const NEXT_APP_DIR = join(REPO_ROOT, "apps/next-app");

// `next dev -p <port>` rewrites these two files on every boot to point at its
// own JAYTRACE_NEXT_DIST_DIR (see apps/next-app/next.config.mjs). Left
// alone, a bench run would permanently clobber whatever distDir reference
// `pnpm dev:console` had written there. Snapshot + restore around the run.
const GUARDED_FILES = ["tsconfig.json", "next-env.d.ts"].map(name => join(NEXT_APP_DIR, name));

const BENCH_TRACES = intEnv("BENCH_TRACES", 10000);
const BENCH_SESSIONS = intEnv("BENCH_SESSIONS", 1);
const SEGMENTS_PER_SESSION = 10;
const BENCH_PORT = intEnv("BENCH_PORT", 3097);
const TRACES_P95_BUDGET_MS = 3000;
const REPLAY_P95_BUDGET_MS = 2000;
const ISSUES_P95_BUDGET_MS = 2000;
const ISSUES_PAYLOAD_BUDGET_BYTES = 1_000_000;
const REQUESTS_PER_ENDPOINT = 10;

if (process.argv.includes("--self-check")) {
  selfCheck();
} else {
  await main();
}

async function main() {
  let tmpRoot;
  let child;
  let exitCode = 0;
  const guardedSnapshots = await Promise.all(GUARDED_FILES.map(snapshotFile));
  try {
    const dataset = await generateDataset();
    tmpRoot = dataset.tmpRoot;
    // Assign `child` the instant it's spawned (not after readiness resolves) so a
    // readiness timeout below still leaves cleanup() able to kill the process --
    // otherwise a failed boot orphans `next dev` forever on BENCH_PORT.
    child = spawnConsole(tmpRoot);
    const baseUrl = `http://localhost:${BENCH_PORT}`;
    await waitForReady(child, baseUrl);
    await warmup(baseUrl, dataset.firstSession);
    const report = await measure(baseUrl, dataset.firstSession);
    console.log(JSON.stringify(report, null, 2));
    exitCode = report.pass ? 0 : 1;
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    await cleanup(child, tmpRoot, guardedSnapshots);
  }
  process.exitCode = exitCode;
}

// ---- phase 1: generate ---------------------------------------------------

async function generateDataset() {
  const tmpRoot = await mkdtemp(join(tmpdir(), "jaytrace-bench-"));
  const started = performance.now();
  const now = new Date();
  const { yyyy, mm, dd } = dateParts(now);
  const dayDir = join(tmpRoot, "prod", yyyy, mm, dd);

  let firstSession = null;

  for (let i = 0; i < BENCH_TRACES; i += 1) {
    const traceId = i.toString(16).padStart(32, "0");
    const traceDir = join(dayDir, traceId);
    const startedAt = new Date(now.getTime() - i);
    const endedAt = new Date(startedAt.getTime() + 350);
    await mkdir(traceDir, { recursive: true });
    await writeDoc(traceDir, `front-${isoStamp(startedAt)}.json`, frontDoc(traceId, startedAt, endedAt, i));
  }

  for (let s = 0; s < BENCH_SESSIONS; s += 1) {
    const traceId = s.toString(16).padStart(32, "0");
    const sessionId = `bench-session-${s}`;
    const traceDir = join(dayDir, traceId);
    await mkdir(traceDir, { recursive: true });
    const writes = [];
    for (let seq = 0; seq < SEGMENTS_PER_SESSION; seq += 1) {
      const startedAt = new Date(now.getTime() + seq * 500);
      const endedAt = new Date(startedAt.getTime() + 400);
      writes.push(
        writeDoc(
          traceDir,
          `replay-react-native-${isoStamp(startedAt)}-seq${seq}.json`,
          wireframeSegmentDoc(traceId, sessionId, seq, startedAt, endedAt)
        )
      );
    }
    await Promise.all(writes);
    firstSession ??= { sessionId, traceId };
  }

  const fingerprint = issueFingerprint(benchIssueTrace(now));
  const stateDir = join(tmpRoot, ".state", "issues");
  await mkdir(stateDir, { recursive: true });
  await writeDoc(stateDir, `${fingerprint}.json`, {
    schema: "jaytrace.issue-state.v1",
    fingerprint,
    status: "acknowledged",
    updatedAt: now.toISOString(),
    resolvedAt: null,
    lastOccurrenceAtResolution: null
  });

  if (!firstSession) {
    throw new Error("BENCH_SESSIONS=0: no session produced for /api/replay measurement");
  }

  console.error(
    `[console-bench] generated exactly ${BENCH_TRACES} traces x1 timeline doc + ${BENCH_SESSIONS} existing traces x${SEGMENTS_PER_SESSION} replay segments ` +
      `in ${round((performance.now() - started) / 1000)}s -> ${tmpRoot}`
  );

  return { tmpRoot, firstSession };
}

function benchIssueTrace(now) {
  const endedAt = new Date(now.getTime() + 350);
  const front = frontDoc("0".repeat(32), now, endedAt, 0);
  return { traceId: front.traceId, sessionId: front.sessionId, lastSeen: endedAt.toISOString(), status: "error", services: [front.service], route: "/checkout", summary: front.error.message, front, replays: [] };
}

function writeDoc(dir, filename, doc) {
  return writeFile(join(dir, filename), JSON.stringify(doc));
}

function frontDoc(traceId, startedAt, endedAt, index) {
  return {
    schema: "jaytrace.timeline.v1",
    service: "bench-front",
    side: "front",
    traceId,
    sessionId: `trace-session-${traceId}`,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    summary: "console-bench synthetic front trace",
    timeline: ["0.000s navigation route /bench", "0.120s fetch /api/bench 200"],
    context: { environment: "production", release: `bench-${index % 2 + 1}`, route: "/checkout" },
    ...(index < 20 ? {
      error: {
        name: "CheckoutError",
        message: `checkout failed for order ${10_000 + index}`,
        stack: `CheckoutError: checkout failed\n    at checkout (/app/checkout.ts:${40 + index}:7)`
      }
    } : {})
  };
}


function wireframeSegmentDoc(traceId, sessionId, seq, startedAt, endedAt) {
  return {
    schema: "jaytrace.replay.v2",
    engine: "wireframe",
    platform: "react-native",
    traceId,
    sessionId,
    seq,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    wireframeFrames: [
      {
        atMs: 0,
        viewport: { width: 390, height: 844 },
        nodes: [
          { type: "rect", x: 0, y: 0, w: 390, h: 844, bg: "#ffffff" },
          { type: "text", x: 24, y: 108, w: 220, h: 20, chars: 10, fontSize: 16 }
        ]
      }
    ]
  };
}

// ---- phase 2: serve -------------------------------------------------------

function spawnConsole(tmpRoot) {
  const distDir = `.next-bench-${process.pid}`;
  const env = { ...process.env, JAYTRACE_LOGS_DIR: tmpRoot, JAYTRACE_NEXT_DIST_DIR: distDir };
  delete env.JAYTRACE_BUCKET;
  delete env.JAYTRACE_S3_BUCKET;

  const child = spawn(
    "pnpm",
    ["--dir", "apps/next-app", "exec", "next", "dev", "-p", String(BENCH_PORT)],
    { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" }
  );
  child.distDir = distDir;
  child.output = [];
  child.stdout.on("data", chunk => child.output.push(chunk.toString()));
  child.stderr.on("data", chunk => child.output.push(chunk.toString()));
  return child;
}

async function waitForReady(child, baseUrl) {
  const readyUrl = `${baseUrl}/api/traces?days=1&limit=1`;
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`console dev server exited early (code ${child.exitCode})\n${child.output.join("")}`);
    }
    try {
      const response = await fetch(readyUrl);
      if (response.ok) {
        console.error(`[console-bench] console ready on ${baseUrl}`);
        return;
      }
    } catch {
      // still starting
    }
    await sleep(500);
  }
  throw new Error(`console dev server did not become ready within 90s\n${child.output.join("")}`);
}

async function warmup(baseUrl, firstSession) {
  await fetch(`${baseUrl}/api/traces?days=1&limit=100`).catch(() => undefined);
  await fetch(`${baseUrl}/api/replay?sessionId=${encodeURIComponent(firstSession.sessionId)}&traceId=${encodeURIComponent(firstSession.traceId)}&days=1`).then(response => response.text()).catch(() => undefined);
  await fetch(`${baseUrl}/api/issues?days=1`).then(response => response.text()).catch(() => undefined);
}

// ---- phase 3: measure -------------------------------------------------------

async function measure(baseUrl, firstSession) {
  const tracesUrl = `${baseUrl}/api/traces?days=1&limit=100`;
  const replayUrl = `${baseUrl}/api/replay?sessionId=${encodeURIComponent(firstSession.sessionId)}` +
    `&traceId=${encodeURIComponent(firstSession.traceId)}&days=1`;
  const issuesUrl = `${baseUrl}/api/issues?days=1`;

  const issues = await timeRequests(issuesUrl, "issues");
  const traces = await timeRequests(tracesUrl, "traces");
  const replay = await timeRequests(replayUrl, "replay");

  const tracesP95 = percentile(traces.sortedMs, 0.95);
  const replayP95 = percentile(replay.sortedMs, 0.95);
  const issuesP95 = percentile(issues.sortedMs, 0.95);
  const issueRows = JSON.parse(issues.lastBody).issues;
  if (!Array.isArray(issueRows)) throw new Error("issues endpoint response is missing issues");
  const issueCount = issueRows.length;
  const groupedAcrossOccurrencesAndReleases = groupedIssueExists(issueRows);
  const expectedIssue = issueRows[0];
  const pass = tracesP95 < TRACES_P95_BUDGET_MS && replayP95 < REPLAY_P95_BUDGET_MS &&
    issuesP95 < ISSUES_P95_BUDGET_MS && issues.maxBytes < ISSUES_PAYLOAD_BUDGET_BYTES &&
    [traces, replay, issues].every(result => allRequestsSucceeded(result.statuses)) &&
    issueCount === 1 && groupedAcrossOccurrencesAndReleases && expectedIssue.count === 20
    && expectedIssue.releases?.join(",") === "bench-1,bench-2" && expectedIssue.status === "acknowledged";

  return {
    requestsPerEndpoint: REQUESTS_PER_ENDPOINT,
    traces: {
      url: tracesUrl,
      p50: round(percentile(traces.sortedMs, 0.5)),
      p95: round(tracesP95),
      budgetMs: TRACES_P95_BUDGET_MS,
      statuses: traces.statuses
    },
    replay: {
      url: replayUrl,
      p50: round(percentile(replay.sortedMs, 0.5)),
      p95: round(replayP95),
      budgetMs: REPLAY_P95_BUDGET_MS,
      statuses: replay.statuses
    },
    issues: {
      url: issuesUrl,
      p50: round(percentile(issues.sortedMs, 0.5)),
      p95: round(issuesP95),
      budgetMs: ISSUES_P95_BUDGET_MS,
      bytes: issues.maxBytes,
      payloadBudgetBytes: ISSUES_PAYLOAD_BUDGET_BYTES,
      issueCount,
      expectedCount: expectedIssue?.count,
      expectedReleases: expectedIssue?.releases,
      expectedStatus: expectedIssue?.status,
      groupedAcrossOccurrencesAndReleases,
      statuses: issues.statuses
    },
    pass
  };
}

async function timeRequests(url, label) {
  const latenciesMs = [];
  const statuses = {};
  let lastBody = "";
  let maxBytes = 0;
  for (let i = 0; i < REQUESTS_PER_ENDPOINT; i += 1) {
    const startedAt = performance.now();
    const response = await fetch(url);
    lastBody = await response.text();
    maxBytes = Math.max(maxBytes, Buffer.byteLength(lastBody));
    latenciesMs.push(performance.now() - startedAt);
    statuses[response.status] = (statuses[response.status] ?? 0) + 1;
  }
  if (!allRequestsSucceeded(statuses)) {
    throw new Error(`${label} endpoint expected ${REQUESTS_PER_ENDPOINT} HTTP 200: ${JSON.stringify(statuses)} (${url})`);
  }
  return { sortedMs: [...latenciesMs].sort((a, b) => a - b), statuses, lastBody, maxBytes };
}

function percentile(sortedAsc, p) {
  const index = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[index];
}

function allRequestsSucceeded(statuses) {
  return statuses[200] === REQUESTS_PER_ENDPOINT;
}

function groupedIssueExists(issues) {
  return issues.some(issue => issue.count > 1 && issue.releases?.length > 1);
}

function selfCheck() {
  assert.equal(allRequestsSucceeded({ 200: 10 }), true);
  assert.equal(allRequestsSucceeded({ 200: 9, 500: 1 }), false);
  assert.equal(groupedIssueExists([]), false);
  assert.equal(groupedIssueExists([{ count: 2, releases: ["bench-1", "bench-2"] }]), true);
  console.log("console-bench self-check passed");
}

// ---- phase 4: cleanup -------------------------------------------------------

async function cleanup(child, tmpRoot, guardedSnapshots = []) {
  if (child) {
    await killTree(child);
  }
  // `next dev` forks a separate "next-server" worker for the actual HTTP
  // server; it can survive a SIGTERM/SIGKILL to the `pnpm exec next dev`
  // process group (observed reparenting to pid 1) and keep BENCH_PORT bound.
  // Always sweep the port directly so a run never leaves it squatted.
  killPort(BENCH_PORT);
  if (child) {
    // Give any trailing worker writes a beat before the final rm so we don't
    // race a partial re-create of distDir.
    await sleep(300);
    await rm(join(NEXT_APP_DIR, child.distDir), { recursive: true, force: true }).catch(() => undefined);
  }
  await Promise.all(guardedSnapshots.map(restoreFile));
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Best-effort: not every platform has lsof (e.g. some minimal Linux/CI
// images), so failures here are swallowed -- killTree() above already
// handles the common case.
function killPort(port) {
  try {
    // -sTCP:LISTEN is required: without it lsof also matches this script's own
    // keep-alive CLIENT sockets to the port and we'd SIGKILL ourselves.
    const result = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    const pids = (result.stdout ?? "").split("\n").map(line => line.trim()).filter(Boolean);
    for (const pid of pids) {
      const numeric = Number(pid);
      if (!Number.isInteger(numeric) || numeric === process.pid) {
        continue;
      }
      try {
        process.kill(numeric, "SIGKILL");
      } catch {
        // already gone
      }
    }
  } catch {
    // lsof unavailable
  }
}

async function snapshotFile(path) {
  try {
    return { path, content: await readFile(path, "utf8") };
  } catch {
    return { path, content: null }; // didn't exist before the run
  }
}

async function restoreFile({ path, content }) {
  if (content === null) {
    await rm(path, { force: true }).catch(() => undefined);
    return;
  }
  await writeFile(path, content).catch(() => undefined);
}

async function killTree(child) {
  if (child.exitCode !== null) {
    return;
  }
  const exited = new Promise(resolve => child.once("exit", resolve));
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timedOut = await Promise.race([exited.then(() => false), sleep(5000).then(() => true)]);
  if (timedOut && child.exitCode === null) {
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

// ---- shared helpers -------------------------------------------------------

function dateParts(date) {
  return {
    yyyy: String(date.getUTCFullYear()),
    mm: String(date.getUTCMonth() + 1).padStart(2, "0"),
    dd: String(date.getUTCDate()).padStart(2, "0")
  };
}

function isoStamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function intEnv(key, def) {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
