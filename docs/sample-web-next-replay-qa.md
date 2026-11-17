# sample-web Next.js Replay QA

Target app:

```txt
../sample-web
```

`sample-web` is a Next.js 16 App Router app. It already initializes Sentry in `src/instrumentation-client.ts`, so JayTrace should be added there as the single frontend integration point. Do not edit page components just to capture replay.

## Preflight

```bash
cd ../sample-web
pnpm install
pnpm check-types
```

For local JayTrace SDK QA before packages are published, keep `sample-web` as a tiny pnpm workspace:

```yaml
# ../sample-web/pnpm-workspace.yaml
packages:
  - "."
  - "./packages/core"
  - "./packages/replay-core"
  - "./packages/replay-web"
  - "./packages/browser-sdk"
```

```json
{
  "dependencies": {
    "@jaytrace/browser": "workspace:*"
  }
}
```

After publish, replace the workspace dependency with the normal package version and remove the local `pnpm-workspace.yaml`.

JayTrace needs a collector endpoint. For local QA, point the browser SDK straight at the local collector; the collector already allows CORS, so no proxy route is required.

```bash
NEXT_PUBLIC_JAYTRACE_QA_API_KEY=local-dev-key
NEXT_PUBLIC_JAYTRACE_ENDPOINT=http://localhost:3012/jaytrace/rum
NEXT_PUBLIC_APP_VERSION=local-qa
```

Verified end-to-end (2026-07-10): with the proxy route removed and only the one-line `initJayTraceNext()` in place, the browser posts directly to the collector (`rumStatuses` 204 preflight + 201s) and the replay lands in S3. Note bare `initJayTraceNext()` tags `service=web`; set `NEXT_PUBLIC_JAYTRACE_SERVICE=sample-web` in the environment (recommended, keeps the one-arg call form) to keep the app's service name, or pass `initJayTraceNext({ service: 'sample-web' })` (still one line) if you prefer an explicit arg.

## One File Integration

Add JayTrace next to Sentry in `src/instrumentation-client.ts`:

```ts
// src/instrumentation-client.ts
import { initJayTraceNext } from '@jaytrace/browser/next';
initJayTraceNext();
```

This sends timeline/replay data directly to the collector at `NEXT_PUBLIC_JAYTRACE_ENDPOINT` (falls back to `/jaytrace/rum` same-origin). No proxy route is required for local QA as long as the browser can reach the collector directly.

Only add the local collector proxy at `src/app/jaytrace/rum/route.ts` if the browser cannot reach the collector directly (e.g. CORS/network restrictions in the deployed environment):

```ts
import { createJayTraceRumProxy } from '@jaytrace/browser/next/rum-route';

export const runtime = 'nodejs';
export const POST = createJayTraceRumProxy();
```

### Advanced

With explicit options instead of env vars:

```ts
import { initJayTraceNext } from '@jaytrace/browser/next';

initJayTraceNext({
  service: 'sample-web',
  replay: {
    maxDurationMs: 30000
  },
});
```

## Local Reproduction Flow

1. Start the JayTrace collector:

```bash
cd .
PORT=3012 JAYTRACE_API_KEY=local-dev-key pnpm --filter @jaytrace/example-nest-api dev
```

Use `JAYTRACE_BODY_LIMIT=1mb` or higher for screenshot-heavy replay payloads.

2. Start the JayTrace console:

```bash
cd .
pnpm --dir apps/next-app dev
```

For the S3-backed dashboard, run the console with the same S3 env as the collector on another port:

```bash
cd ./apps/next-app
node --env-file=../nest-api/.env --input-type=module -e "import { spawn } from 'node:child_process'; spawn('pnpm', ['exec', 'next', 'dev', '-p', '3008'], { stdio: 'inherit', env: process.env });"
```

3. Start `sample-web` with JayTrace env:

```bash
cd ../sample-web
pnpm dev:jaytrace:qa
```

4. Open `http://localhost:3014/ko/jaytrace-qa`, click `Trigger replay failure`, then open `http://localhost:3008` and filter by `Session Replays` or `Web`.

Expected evidence:

- a `front` timeline with `service=sample-web`
- a `replay-web` document with DOM/image-free fallback replay or DOM snapshots
- fetch/XHR rows carrying the same trace id through `traceparent`
- replay summary showing duration, actions, network, errors, and frames

## Replay v2 (always-on) QA

Add to `sample-web`'s `dev:jaytrace:qa` env to force continuous rrweb recording instead of on-error sampling:

```bash
NEXT_PUBLIC_JAYTRACE_REPLAY_MODE=always
NEXT_PUBLIC_JAYTRACE_REPLAY_SAMPLE_RATE=1
```

Then run:

```bash
cd .
pnpm smoke:sample-web-replay-v2
```

This drives sample-web without touching the error button (mode=always flushes segments on its own), then asserts against the collector/S3/console. Expected JSON: `ok: true`, `segments >= 2`, `playerDomNodes > 10`.

Note: the existing `pnpm smoke:sample-web-web` (v1) smoke now reports `consoleReplayVisual: "player"` for error sessions — the console prefers the rrweb player whenever v2 segments exist, and error-triggered sessions always escalate to a v2 segment. This is expected, not a regression.

## Notes

- `src/global-error.tsx` already calls Sentry. JayTrace should not be added there first; SDK global handlers already capture browser errors.
- `src/instrumentation.ts` is server/edge instrumentation. Use it later only if sample-web needs server-side JayTrace export.
- Direct collector CORS must allow `content-type`, `traceparent`, and `x-jaytrace-internal`.
- If a deployed browser cannot call the collector directly, add a Next rewrite from `/jaytrace/rum` to the collector and keep the SDK endpoint as `/jaytrace/rum`.
