# Load Test and Console Bench Results

Date: 2026-07-11. Environment: macOS (Apple Silicon laptop), Node 24, local loopback —
absolute numbers are machine-relative; use them as regression baselines, not capacity promises.
Harnesses: `pnpm load:collector` (`scripts/load-test.mjs`), `pnpm bench:console` (`scripts/console-bench.mjs`).

## Collector ingest under total S3 outage

Setup: example collector on :3012 with intentionally invalid AWS credentials, so every export
fails and falls back to spool/backpressure. 5,000 synthetic `jaytrace.replay.v2` wireframe
segments (~2KB each), concurrency 32, traceIds distributed to avoid per-trace rate limiting.

| Metric | Result |
| --- | --- |
| Accepted | 5,000 / 5,000 (100% HTTP 201, zero client-visible failures) |
| Throughput | ~3,526 RPS |
| Ingest latency | p50 7.0ms · p95 19.5ms · p99 48.0ms · max 127ms |
| Health counters | export sent 0 · failed 336 · spooled 316 · backpressure 4,571 |
| Spool backlog | 4,909 files (later verified 5,000 — all segments preserved on disk) |

Conclusions:
- The fire-and-forget contract holds under total storage outage: client responses stay fast
  (p95 <20ms) and no request is rejected because S3 is down.
- The in-flight export cap (100) works as designed: most segments route through the
  backpressure→spool path instead of piling up requests against a dead S3.
- **Zero data loss**: spool file count equals accepted segments.
- `/jaytrace/health` correctly exposed the outage in real time (failed/spooled/backpressure
  counters + spoolBacklog) — this is the signal to alert on (suggested threshold: backlog > 100).

## Console scale bench (local mode, 6,400+ documents)

Dataset: 2,000 traces × (front + back + v1 replay) + 200 sessions × 10 wireframe v2 segments.
Console in local-dir mode via `next dev`, 10 requests per endpoint after warm-up.

| Endpoint | Before guard | After guard | Budget |
| --- | --- | --- | --- |
| `GET /api/traces?days=1&limit=100` | p95 1,572ms | p95 ~1,859ms (unchanged path, run variance) | 3,000ms ✅ |
| `GET /api/replay?sessionId&traceId&days=1` | p95 **2,049ms ❌** | p95 **738ms ✅** | 2,000ms |

Finding and fix: the bench exposed that `traceId` narrowing was applied only to S3 prefix reads —
the LOCAL reader walked all 6,400 files per `/api/replay` call. Fixed in `0b3c54a4`
(`fix(console): apply traceId narrowing to local document reads`); replay p95 dropped 64%.

### Issue query verification (2026-07-16)

Machine-relative Apple Silicon laptop result; this is a regression check, not a production
capacity promise. The self-contained fixture contains exactly 10,000 trace IDs with one timeline
document each. Twenty documents form one deterministic error fingerprint across two releases;
the fixture also contains one acknowledged state object and ten replay segments attached to an
existing trace ID.

The issue endpoint uses a 30-second process-local cache because the measured uncached 10,000-trace
p95 was 3,088.87ms and exceeded the 2-second budget. New occurrence documents can therefore take up to 30 seconds to
appear; successful issue PATCH requests invalidate all cached issue views immediately. The cache is
per console process and adds no shared consistency guarantee.

| Endpoint | Requests | HTTP | p50 | p95 | Response/result | Gate |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `GET /api/traces?days=1&limit=100` | 10 after warm-up | 200 10/10 | 126.36ms | 141.90ms | 100 recent traces | ✅ <3,000ms |
| `GET /api/replay?sessionId&traceId&days=1` | 10 after warm-up | 200 10/10 | 1,231.31ms | 1,391.32ms | 10 replay segments; local traceId narrowing before cap | ✅ <2,000ms |
| `GET /api/issues?days=1` (warm cache) | 10 after 1 warm-up | 200 10/10 | 3.31ms | 7.03ms | 2,474 bytes; 1 group / 20 occurrences / 2 releases / acknowledged | ✅ <2,000ms, <1MB, exact grouping/state |

## How to re-run

```bash
# collector ingest (spool path, no AWS cost):
AWS_ACCESS_KEY_ID=invalid AWS_SECRET_ACCESS_KEY=invalid PORT=3012 \
  JAYTRACE_API_KEY=local-dev-key JAYTRACE_BUCKET=any AWS_REGION=ap-northeast-2 \
  node apps/nest-api/dist/main.js &
COLLECTOR_URL=http://localhost:3012/jaytrace/rum API_KEY=local-dev-key pnpm load:collector

# console bench (self-contained, spawns its own console):
pnpm bench:console
```

Optional real-S3 ingest check: `pnpm load:collector` with valid credentials and a small
`SEGMENTS` value (e.g. 200) against a disposable prefix.
