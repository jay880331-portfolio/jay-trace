#!/usr/bin/env node
// Load harness for the JayTrace collector's /jaytrace/rum ingest endpoint.
// Fires SEGMENTS synthetic jaytrace.replay.v2 (wireframe) POSTs at CONCURRENCY
// in flight, records per-request latency + status, then prints a JSON summary
// and the collector's /jaytrace/health snapshot. Node builtins only.
//
// Usage: node scripts/load-test.mjs [--segments=5000] [--concurrency=32]
//   [--collector-url=http://localhost:3012/jaytrace/rum] [--api-key=local-dev-key]
// Every flag also reads from an env var of the matching name (SEGMENTS,
// CONCURRENCY, COLLECTOR_URL, API_KEY, HEALTH_URL); flags win over env.
//
// Rate limiting: the collector buckets by document.traceId (default 120
// requests/60s/bucket, maxBuckets 10000). Each request here gets a fresh
// random traceId, so 5000 requests spread across ~5000 buckets never trips
// the per-bucket limit -- 429s are still recorded if the collector is
// configured tighter than default.

import { randomBytes } from "node:crypto";

const SEGMENTS = intArg("segments", "SEGMENTS", 5000);
const CONCURRENCY = intArg("concurrency", "CONCURRENCY", 32);
const COLLECTOR_URL = stringArg("collector-url", "COLLECTOR_URL", "http://localhost:3012/jaytrace/rum");
const API_KEY = stringArg("api-key", "API_KEY", "local-dev-key");
const HEALTH_URL = stringArg("health-url", "HEALTH_URL", `${new URL(COLLECTOR_URL).origin}/jaytrace/health`);

await main();

async function main() {
  const latenciesMs = [];
  const statusCounts = {};
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const i = nextIndex++;
      if (i >= SEGMENTS) return;
      const body = JSON.stringify({ apiKey: API_KEY, reason: "segment", document: makeSegment(i) });
      const startedAt = performance.now();
      let status;
      try {
        const response = await fetch(COLLECTOR_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body
        });
        await response.text().catch(() => undefined); // drain so the socket is reusable
        status = String(response.status);
      } catch {
        status = "error";
      }
      latenciesMs.push(performance.now() - startedAt);
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    }
  }

  const runStartedAt = performance.now();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, SEGMENTS) || 1 }, worker));
  const durationSec = (performance.now() - runStartedAt) / 1000;

  const summary = {
    total: SEGMENTS,
    concurrency: CONCURRENCY,
    collectorUrl: COLLECTOR_URL,
    durationSec: round(durationSec),
    rps: round(SEGMENTS / durationSec),
    latencyMs: percentiles(latenciesMs),
    statusCounts
  };
  console.log(JSON.stringify(summary, null, 2));

  try {
    const healthResponse = await fetch(HEALTH_URL);
    console.log(JSON.stringify({ healthUrl: HEALTH_URL, health: await healthResponse.json() }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ healthUrl: HEALTH_URL, healthError: String(error) }, null, 2));
  }

  const accepted = statusCounts["201"] ?? 0;
  process.exitCode = accepted / SEGMENTS >= 0.99 ? 0 : 1;
}

// ---- synthetic payload -------------------------------------------------

// ~2KB jaytrace.replay.v2 (wireframe) segment: a handful of frames each with
// a handful of nodes, roughly what one flush of a real RN wireframe recorder
// would send.
function makeSegment(index) {
  const traceId = randomBytes(16).toString("hex"); // distributes rate-limit buckets
  const sessionId = `load-session-${Math.floor(index / 50)}`; // ~50 requests/session
  const now = Date.now();
  const baseNodes = [
    { type: "rect", x: 0, y: 0, w: 390, h: 844, bg: "#ffffff" },
    { type: "rect", x: 16, y: 96, w: 358, h: 48, bg: "#4950f6", radius: 8 },
    { type: "text", x: 24, y: 108, w: 220, h: 20, chars: 14, fontSize: 16, color: "#111111" },
    { type: "image", x: 16, y: 180, w: 358, h: 200, opacity: 1 },
    { type: "rect", x: 16, y: 400, w: 358, h: 48, bg: "#22c55e", radius: 8 },
    { type: "text", x: 24, y: 412, w: 220, h: 20, chars: 18, fontSize: 14, color: "#374151" }
  ];
  return {
    schema: "jaytrace.replay.v2",
    engine: "wireframe",
    platform: "react-native",
    traceId,
    sessionId,
    seq: 0,
    startedAt: new Date(now).toISOString(),
    endedAt: new Date(now + 500).toISOString(),
    metadata: { "view.name": "LoadTestScreen", release: "load-test", environment: "load", requestIndex: index },
    wireframeFrames: [
      { atMs: 0, viewport: { width: 390, height: 844 }, nodes: baseNodes },
      { atMs: 200, viewport: { width: 390, height: 844 }, pointer: { x: 195, y: 424, kind: "tap" }, nodes: baseNodes },
      { atMs: 500, viewport: { width: 390, height: 844 }, nodes: baseNodes }
    ]
  };
}

// ---- stats/arg helpers --------------------------------------------------

function percentiles(valuesMs) {
  if (valuesMs.length === 0) {
    return { p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...valuesMs].sort((a, b) => a - b);
  return {
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted[sorted.length - 1])
  };
}

function percentile(sortedAsc, p) {
  const index = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[index];
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function stringArg(flag, envKey, def) {
  return flagValue(flag) ?? process.env[envKey] ?? def;
}

function intArg(flag, envKey, def) {
  const raw = flagValue(flag) ?? process.env[envKey];
  const n = raw === undefined ? def : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

function flagValue(flag) {
  const prefix = `--${flag}=`;
  const hit = process.argv.find(arg => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}
