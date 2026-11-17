# JayTrace

JayTrace is a low-cost full-stack observability toolkit that stores lightweight timeline and replay JSON in S3, then analyzes synced files locally with CLI AI.

## Packages

- `@jaytrace/core`: W3C traceparent, redaction, timeline schema
- `@jaytrace/browser`: Web, React, Next.js RUM SDK
- `@jaytrace/nestjs`: NestJS trace context, RUM ingest, S3 exporter
- `@jaytrace/node`: OTel-based Node auto-instrumentation (`@jaytrace/node/init`)
- `@jaytrace/cli`: `jaytrace-check` local AI analysis CLI
- `@jaytrace/replay-core`: replay schema and ring buffer
- `@jaytrace/replay-web`: event-based Web replay
- `@jaytrace/replay-react-native`: React Native replay helpers
- `jaytrace_flutter`: Flutter replay helpers

## Web / Next.js

For Next.js App Router, put this in `src/instrumentation-client.ts`:

```ts
// src/instrumentation-client.ts
import { initJayTraceNext } from "@jaytrace/browser/next";
initJayTraceNext();
```

| env | 용도 | 기본값 |
| --- | --- | --- |
| `NEXT_PUBLIC_JAYTRACE_ENDPOINT` | collector URL (직접 전송) | `/jaytrace/rum` (same-origin) |
| `NEXT_PUBLIC_JAYTRACE_API_KEY` | 공개 API 키 | — |
| `NEXT_PUBLIC_JAYTRACE_SERVICE` | service 태그 (앱 식별용) | `web` |
| `NEXT_PUBLIC_JAYTRACE_TRACE_ORIGINS` | 추가 traceparent 전파 origin (콤마) | endpoint origin 자동 포함 |
| `NEXT_PUBLIC_APP_VERSION` / `NEXT_PUBLIC_APP_ENV` | release / environment 태그 | — |
| `NEXT_PUBLIC_JAYTRACE_REPLAY_MODE` | `"always"` \| `"on-error"` \| `"off"` | — |
| `NEXT_PUBLIC_JAYTRACE_REPLAY_SAMPLE_RATE` | session 단위 샘플링 (0–1, 예: `"0.1"`); 1보다 큰 값은 legacy v1 percentage로 취급 | — |

By default the browser sends timeline/replay data directly to the collector; the browser SDK never receives AWS credentials. For a real Next.js app QA target, see `docs/sample-web-next-replay-qa.md`.

### Session replay v2 (rrweb)

`replay.mode: "always"` + `replay.sampleRate` enable Datadog-style continuous recording with rrweb: segments upload every ~10s / 256KB as `jaytrace.replay.v2` docs (`replay-web-{ts}-seq{n}.json`, see Storage Layout). Even `on-error` / unsampled sessions keep an rrweb tail buffer and upload a v2 segment the moment an error fires, so ERROR sessions always get player-grade replay. Explicit `options.replay` wins over env. Prod recommendation: `sampleRate 0.1` with `mode: "always"` — error escalation still covers 100% of error sessions regardless of sample rate. Idle pause is 5min, max session length is 30min.

### Advanced

For plain Web (non-Next.js) apps, or to pass explicit options instead of relying on env vars:

```ts
import { initJayTrace } from "@jaytrace/browser";

initJayTrace({
  apiKey: process.env.NEXT_PUBLIC_JAYTRACE_API_KEY!,
  endpoint: "/jaytrace/rum",
  service: "web",
  environment: process.env.NODE_ENV,
  traceOrigins: ["https://api.example.com"],
  replay: {
    enabled: true,
    mode: "on-error",
    privacy: "mask-all",
    networkOrigins: ["https://api.example.com"]
  }
});
```

The browser SDK never receives AWS credentials. It only sends redacted timeline and replay documents to `/jaytrace/rum`.
Use `window.__jayTraceClient?.addAction("CheckoutStarted", { plan: "pro" })` for business breadcrumbs that automatic click/network capture cannot name well.
Use `window.__jayTraceClient?.setUser({ id: user.id })` after login; sensitive user fields are redacted before export.
Use `window.__jayTraceClient?.traceNetwork(...)` around custom HTTP clients that do not use `fetch` or XHR.
Web DOM snapshot frames are capped at 768KB by default; raise `replay.maxSnapshotBytes` only with a matching collector `maxRumPayloadBytes`.
Set `replay.engine: "snapshot"` to opt out of rrweb and keep the v1 DOM-snapshot recorder; if rrweb record fails to start, JayTrace auto-degrades to the v1 recorder and tags the session `replay.engine=snapshot-fallback`.
Tune v2 segment behavior with `replay.segmentFlushMs` (default 10000), `replay.maxSegmentBytes` (default 262144), `replay.maxSessionMs` (default 1800000), and `replay.idlePauseMs` (default 300000).
Record-time masking applies before upload: `privacy: "mask-all"` sets rrweb `maskAllInputs` + `maskTextSelector: "*"`; `data-jaytrace-mask` masks a subtree, `data-jaytrace-hidden` blocks it from recording; canvas capture is off. rrweb events are excluded from key-based redaction on both client and collector since masking already happened at record time.
Browser timeline flush uses `keepalive` only for small payloads; larger payloads fall back to normal fetch so replay-sized data is not dropped by browser keepalive limits.
The browser SDK also flushes pending timeline data on `pagehide` and `visibilitychange:hidden`.
Add API origins to `traceOrigins` for cross-domain `traceparent` propagation and to `replay.networkOrigins` when those requests should appear in session replay.
Browser long tasks are recorded as `performance` timeline warnings when `PerformanceObserver` is available.
Browser navigation timing is recorded as `performance` timeline info when the Navigation Timing API is available.
Web replay also records those browser performance signals as `Perf` frames.
Use `data-jaytrace-mask` to force-mask a DOM subtree and `data-jaytrace-hidden` to remove a subtree from Web replay snapshots.

For Next.js App Router with explicit options instead of env vars:

```ts
import { initJayTraceNext } from "@jaytrace/browser/next";

initJayTraceNext({
  service: "web",
  traceOrigins: ["https://api.example.com"],
  replay: { networkOrigins: ["https://api.example.com"] }
});
```

`initJayTraceNext` reads `NEXT_PUBLIC_JAYTRACE_RELEASE` or `NEXT_PUBLIC_APP_VERSION` for release tagging, and `NEXT_PUBLIC_APP_ENV` for environment tagging.

Direct-to-collector is the default path. If the browser cannot reach the collector directly (e.g. it sits behind a private network boundary), proxy browser RUM through the app server instead:

```ts
import { createJayTraceRumProxy } from "@jaytrace/browser/next/rum-route";

export const runtime = "nodejs";
export const POST = createJayTraceRumProxy();
```

## NestJS

```ts
import { Module } from "@nestjs/common";
import { JayTraceModule } from "@jaytrace/nestjs";

@Module({
  imports: [JayTraceModule.forRoot()]
})
export class AppModule {}
```

| env | 용도 | 기본값 |
| --- | --- | --- |
| `JAYTRACE_API_KEY` | API 키 (필수) | — |
| `JAYTRACE_API_KEYS` | 복수 허용 API 키 (콤마, 선택) | — |
| `JAYTRACE_BUCKET` | S3 버킷 (필수) | — |
| `AWS_REGION` | AWS 리전 (필수) | — |
| `JAYTRACE_S3_PREFIX` | S3 prefix | `NODE_ENV` |
| `JAYTRACE_SERVICE` | 서비스 이름 태그 | `api` |

`JAYTRACE_API_KEY`, `JAYTRACE_BUCKET`, `AWS_REGION` 중 하나라도 없으면 부팅이 빠르게 실패하며 누락된 변수 이름을 알려준다.

### Auto-instrumentation (`@jaytrace/node`)

For OTel-based auto-instrumentation instead of (or in addition to) `JayTraceModule`, import the init module before every other import in `main.ts`:

```ts
// main.ts — first line, before any other import
import "@jaytrace/node/init";

import { NestFactory } from "@nestjs/core";
```

This instruments amqplib, http/https, mysql2, pg, winston, pino, `@nestjs/core`, and patches `console.*` directly. Boot happens in two stages: the `import` patches instrumentation immediately, but the exporter re-reads env on every export attempt rather than only once at boot. If your app injects secrets after boot (the host app loads them from a secret manager post-startup), call `startJayTrace()` right after the secrets land instead of waiting for the next export to pick them up:

```ts
import { startJayTrace } from "@jaytrace/node";

await loadSecretsIntoEnv();
startJayTrace();
```

| env | 용도 | 기본값 |
| --- | --- | --- |
| `JAYTRACE_API_KEY` | API 키 (필수) | — |
| `JAYTRACE_BUCKET` | S3 버킷 (필수) | — |
| `AWS_REGION` | AWS 리전 (필수) | — |
| `JAYTRACE_SERVICE` | 서비스 이름 태그 | `api` |
| `JAYTRACE_EXPORT` | export 정책: `errors` \| `slow` \| `all` | `errors` |
| `JAYTRACE_EXPORT_DIR` | 지정 시 S3 대신 로컬 디렉토리에 문서를 기록(로컬 개발/e2e용) | — (S3) |
| `JAYTRACE_INSTRUMENT_DISABLE` | 비활성화할 계측 이름 콤마 목록 (`amqplib,http,mysql2,pg,winston,pino,nestjs-core,console`) | — |
| `JAYTRACE_DISABLE` | `1` 이면 계측 전체를 끈다 | — |
| `JAYTRACE_S3_PREFIX` | S3 prefix | `NODE_ENV` |

Unlike `JayTraceModule.forRoot()`, missing required env does not fail boot: `import "@jaytrace/node/init"` runs before secrets may be available, so documents are silently dropped (with a single stderr warning) until the required env shows up.

Known limits: Nest's default `ConsoleLogger` writes straight to stdout without going through `console.*`, so it is **not** captured — only `console.*` calls, `winston`, and `pino` are. Logging done outside an active request/span context is not collected either.

When `@jaytrace/node/init` is loaded, `@jaytrace/nestjs` detects it and switches to integrated mode automatically: `JayTraceModule`'s own back-document export is skipped (the OTel span processor becomes the single export path), and request/response bodies ride along as `jaytrace.request_body` / `jaytrace.response_body` span attributes instead of the standalone event-log path. Without `@jaytrace/node/init`, `@jaytrace/nestjs` behaves exactly as documented above (HTTP-only, self-contained export).

`@jaytrace/node/init` is configured by env only. If your app configures `JayTraceModule.forRoot()` with an options object instead (an explicit `apiKey`/`s3` literal, or `forRootAsync` from `ConfigService`), adding the init import is not enough: the OTel span processor becomes the single back-document export path and reads its own config from `JAYTRACE_API_KEY` / `JAYTRACE_BUCKET` / `AWS_REGION`. Set those env vars too, or back documents are silently dropped.

E2E: `pnpm build && pnpm test:otel-e2e` (starts a local RabbitMQ container, so Docker must be running).

### Advanced

With explicit options instead of env vars:

```ts
import { Module } from "@nestjs/common";
import { JayTraceModule } from "@jaytrace/nestjs";

@Module({
  imports: [
    JayTraceModule.forRoot({
      apiKey: process.env.JAYTRACE_API_KEY!,
      service: "api",
      environment: process.env.NODE_ENV ?? "production",
      maxRumPayloadBytes: 1024 * 1024,
      maxRumEvents: 1000,
      rumRateLimit: { maxRequests: 120, windowMs: 60000, maxBuckets: 10000 },
      s3: {
        bucket: process.env.JAYTRACE_BUCKET!,
        region: process.env.AWS_REGION!,
        prefix: process.env.NODE_ENV ?? "production",
        serverSideEncryption: "AES256"
      }
    })
  ]
})
export class AppModule {}
```

With `ConfigService` or another async config source:

```ts
JayTraceModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    apiKey: config.getOrThrow("JAYTRACE_API_KEY"),
    s3: {
      bucket: config.getOrThrow("JAYTRACE_BUCKET"),
      region: config.getOrThrow("AWS_REGION")
    }
  })
})
```

S3 uploads are fire-and-forget. If upload fails, JayTrace writes a spool file under the OS temp directory and keeps the app response path alive.
If S3 stalls, JayTrace caps in-flight exports at `maxInFlightExports` (default 100) and spools overflow immediately.
`JayTraceModule.forRoot(...)` installs request context middleware and an interceptor for backend error export, but it does not install a global exception filter or change your API error response shape.
Inject `JayTraceContextService` and call `setContext({ tenantId, "user.id": userId })` to add redacted backend tags to the exported trace.
For screenshot-heavy replay, raise `maxRumPayloadBytes` deliberately and keep Nest/HTTP body-parser limits aligned. The default collector budget is 1MB.

### Health & metrics

`GET /jaytrace/health` (no auth, no sensitive data) returns `{ ok, uptimeSec, export: { sent, failed, spooled, backpressure }, rum: { accepted, rejected, rateLimited }, spoolBacklog }` — in-memory counters that reset on restart. Alert when `spoolBacklog > 100` (S3 exports are failing and piling up on local disk). For production bucket separation, lifecycle, cost model, and spool re-upload ops, see `infra/aws/README.md`.

## React Native

```tsx
import { JayTraceRoot, useJayTrace } from "@jaytrace/replay-react-native/react";

export function App() {
  return (
    <JayTraceRoot apiKey={apiKey} endpoint={endpoint} navigationRef={navigationRef}>
      <NavigationContainer ref={navigationRef}>
        <RootNavigator />
      </NavigationContainer>
    </JayTraceRoot>
  );
}
```

| prop / hook | 용도 | 기본값 |
| --- | --- | --- |
| `apiKey` | API 키 (필수) | — |
| `endpoint` | collector URL (필수) | — |
| `navigationRef` | React Navigation ref, 화면 전환 추적 | — |
| `captureScreen` | `async () => dataUrl`, 지정 시 스크린샷 캡처 활성화 | 미지정 시 스크린샷 없음 |
| `useJayTrace()` | 클라이언트 반환 (`addAction`/`setUser` 등, 없으면 `null`) | — |

```tsx
import { useJayTrace } from "@jaytrace/replay-react-native/react";

function CheckoutButton() {
  const jaytrace = useJayTrace();
  return <Pressable onPress={() => jaytrace?.addAction("CheckoutStarted", "plan=pro")} />;
}
```

### Wireframe replay (v2)

`replay.engine`은 기본값이 `"wireframe"`이다: 스크린샷 대신 등록/측정된 뷰 트리(`captureViewTree`/measured refs)를 rect/text/image 벡터 프리미티브로 직렬화해 `jaytrace.replay.v2` 세그먼트로 업로드한다(`replay-react-native-{ts}-seq{n}.json`, see Storage Layout — Flutter와 동일한 스토리지 규약) — 가볍고 프라이버시 안전하며 콘솔이 SVG 스크러버로 재생한다. 연속 캡처는 `replay: { engine: "wireframe", sampleRate: 1 }`로 켠다(`sampleRate`가 연속 캡처를 제어하며, RN에는 env가 없으므로 옵션 인자로만 전달 — `"always"` engine 같은 별도 모드는 없다). `on-error` / 미샘플 세션도 프레임 tail 버퍼를 유지하다가 에러 발생 시 seq 0 세그먼트를 즉시 전송하므로, 샘플링과 무관하게 에러 세션은 항상 리플레이가 남는다(rrweb v2·Flutter와 동일한 에러 승격 정책). 텍스트는 캡처 시점에 문자 수(`chars`)만 남기고 마스킹된다 — `privacy: allow`일 때만 원문이 포함된다. `"event"` engine은 기존 이벤트-only 리플레이를 그대로 유지한다.

**마이그레이션 노트:** `captureScreen`/screenshot provider를 지정해도 `replay.engine`이 `"screenshot"`이 아니면 무시된다(픽셀 미업로드, 프라이버시 일관성). 기존 스크린샷 경로가 필요하면 `replay: { engine: "screenshot" }`로 명시적으로 되돌린다(탈출구, 새 캡처 경로는 비활성화됨).

저장소에 실제 React Native 앱이 없어 파이프라인(collector → S3 → 콘솔 WireframePlayer)은 합성 세그먼트로 검증한다: `pnpm smoke:rn-wireframe-console` (see `docs/mobile-replay-qa.md`).

### Advanced

Manual wiring without the `<JayTraceRoot>` wrapper, for full control over screenshot provider, network tracing, and replay-aware input helpers:

```ts
import { AppState, TextInput } from "react-native";
import {
  createReplayRootProps,
  createReactNativeScreenshotProvider,
  createReactNavigationReplayTracker,
  initJayTraceReactNative,
  withReplayPress,
  withReplayTextInput
} from "@jaytrace/replay-react-native";

const jaytrace = initJayTraceReactNative({
  apiKey,
  endpoint: "https://api.example.com/jaytrace/rum",
  traceOrigins: ["https://api.example.com"],
  release: appVersion,
  environment: "production",
  appState: AppState,
  metadata: { appVersion, os: "ios", device: "iPhone" },
  replay: { enabled: true, mode: "on-error", privacy: "mask-all" },
  screenshot: createReactNativeScreenshotProvider({
    enabled: () => !isSensitiveRoute(),
    captureScreen,
    maxBytes: 320_000,
    timeoutMs: 1000
  })
});

const tracker = createReactNavigationReplayTracker(jaytrace.replay, navigationRef);
jaytrace.setUser({ id: userId });
jaytrace.addAction("CheckoutStarted", "plan=pro");
jaytrace.addScroll("CheckoutList", 320);
jaytrace.addPerformance("SlowCheckoutScreen", 420, "route=/checkout");
await jaytrace.traceNetwork({
  method: "POST",
  url: "https://api.example.com/pay",
  run: headers => client.post("/pay", { headers }),
  status: response => response.status
});

<NavigationContainer
  ref={navigationRef}
  onReady={tracker.onReady}
  onStateChange={tracker.onStateChange}
>
  <View {...createReplayRootProps(jaytrace.replay)}>
    <Pressable onPress={withReplayPress(jaytrace.replay, "PayButton", pay)} />
    <TextInput onChangeText={withReplayTextInput(jaytrace.replay, "EmailInput", setEmail)} />
  </View>
</NavigationContainer>;
```

`initJayTraceReactNative` generates `traceparent`, patches `globalThis.fetch`, installs the RN global error and unhandled-rejection handlers when available, and returns `restore()`.
Pass React Native `AppState` to flush pending replay data when the app moves to `inactive` or `background`.
Use `tracker.onReady` and `tracker.onStateChange` with React Navigation, spread `createReplayRootProps(jaytrace.replay)` on the app root, and use `withReplayPress` / `withReplayTextInput` for named controls.
Use `jaytrace.fetch(url, init)` if you do not want global fetch patching, or `jaytrace.traceNetwork(...)` around custom clients.
Screenshot frames are capped at 320KB by default and capture times out after 1s; raise `maxBytes`, `timeoutMs`, and `replay.maxScreenshotBytes` only with a matching collector `maxRumPayloadBytes`.
Replay metadata includes `replay.screenshot=enabled` when a screenshot provider is configured and `replay.screenshot=missing` when JayTrace can only record event timelines.
React Native screen tracking also keeps the latest screen in replay metadata as `view.name`.
Mobile screenshots can contain visible PII. Use `enabled` to skip payment, identity, health, and auth routes, keep those screens out of the capture boundary, or provide a capture hook that masks them before returning the image.
If `sessionId` is omitted, `initJayTraceReactNative` keeps one runtime session id so multiple traces group into one replay session.

## Flutter

```dart
import 'package:jaytrace_flutter/jaytrace_flutter_widgets.dart';

void main() => runJayTrace(() => const MyApp());
```

| `--dart-define` | 용도 | 기본값 |
| --- | --- | --- |
| `JAYTRACE_ENDPOINT` | collector URL | — |
| `JAYTRACE_API_KEY` | API 키 | — |
| `JAYTRACE_RELEASE` | release 태그 | — |
| `JAYTRACE_ENVIRONMENT` | environment 태그 | — |
| `JAYTRACE_TRACE_ORIGINS` | 추가 traceparent 전파 origin (콤마) | — |
| `JAYTRACE_REPLAY_MODE` | `"always"` \| `"on-error"` \| `"off"` | `on-error` |
| `JAYTRACE_REPLAY_SAMPLE_RATE` | session 단위 샘플링 (0–1) | — |

같은 값들을 `runJayTrace(...)`에 named argument로 직접 넘겨도 된다. 모바일/데스크톱 기본 HTTP sender가 내장되어 있으므로 `sender:`를 따로 지정할 필요는 없다.
Navigator observer는 여전히 선택 사항이며 한 줄로 추가한다: `MaterialApp(navigatorObservers: [JayTrace.observer])`.

### Wireframe replay (v2)

`replay.engine`은 기본값이 `"wireframe"`이다: 스크린샷 대신 위젯 렌더 트리를 rect/text/image 벡터 프리미티브로 직렬화해 `jaytrace.replay.v2` 세그먼트로 업로드한다(`replay-flutter-{ts}-seq{n}.json`, see Storage Layout) — 가볍고 프라이버시 안전하며 콘솔이 SVG 스크러버로 재생한다. `--dart-define=JAYTRACE_REPLAY_MODE=always` + `JAYTRACE_REPLAY_SAMPLE_RATE`로 web/rrweb과 동일한 Datadog 방식 연속 캡처를 켠다. `on-error` / 미샘플 세션도 프레임 tail 버퍼를 유지하다가 에러 발생 시 seq 0 세그먼트를 즉시 전송하므로, 샘플링과 무관하게 에러 세션은 항상 리플레이가 남는다(rrweb v2와 동일한 에러 승격 정책). 텍스트는 캡처 시점에 문자 수(`chars`)만 남기고 마스킹된다 — `privacy: allow`일 때만 원문이 포함된다. 기존 스크린샷 경로가 필요하면 `JayTraceFlutterReplayOptions(engine: 'screenshot')`로 되돌린다(탈출구, 새 캡처 경로는 비활성화됨). 저장소에 실제 Flutter 앱이 없어 파이프라인(collector → S3 → 콘솔 WireframePlayer)은 합성 세그먼트로 검증한다: `pnpm smoke:wireframe-console` (see `docs/mobile-replay-qa.md`).

### Advanced

Explicit options and replay/screenshot wiring via `jaytrace_flutter_widgets`:

```dart
import 'package:jaytrace_flutter/jaytrace_flutter.dart';
import 'package:jaytrace_flutter/jaytrace_flutter_widgets.dart';

final boundaryKey = GlobalKey();
final jaytrace = initJayTraceFlutterWidgets(
  apiKey: apiKey,
  endpoint: Uri.parse('https://api.example.com/jaytrace/rum'),
  traceOrigins: ['https://api.example.com'],
  release: appVersion,
  environment: 'production',
  metadata: {'appVersion': appVersion, 'os': 'ios'},
  replay: const JayTraceFlutterReplayOptions(enabled: true),
  screenshot: createJayTraceScreenshotProvider(
    boundaryKey,
    enabled: () => !isSensitiveRoute(),
  ),
  sender: sendWithYourHttpClient,
);

final response = await jaytrace.traceNetwork(
  method: 'POST',
  url: uri,
  headers: {'content-type': 'application/json'},
  run: (headers) => httpClient.post(uri, headers: headers),
  status: (response) => response.statusCode,
);
jaytrace.setUser({'id': userId});
jaytrace.addAction('CheckoutStarted', detail: 'plan=pro');
jaytrace.addInput('EmailInput');
jaytrace.addScroll('CheckoutList', offset: 320);
jaytrace.addPerformance('SlowCheckoutScreen', const Duration(milliseconds: 420), detail: 'route=/checkout');

await runJayTraceGuarded(jaytrace.replay, () async {
  runApp(
    JayTraceReplayRoot(
      boundaryKey: boundaryKey,
      replay: jaytrace.replay,
      child: App(
        replay: jaytrace.replay,
        onEmailChanged: jayTraceReplayOnChanged(jaytrace.replay, 'EmailInput'),
      ),
    ),
  );
});
```

`initJayTraceFlutterWidgets` generates `traceId`, W3C `traceparent`, and installs Flutter framework and platform error handlers.
It also flushes pending replay data when Flutter lifecycle moves to inactive, paused, or detached.
Wrap the app with `JayTraceReplayRoot`, then use `JayTraceNavigatorObserver(jaytrace.replay)` in `navigatorObservers`.
Wrap important API calls with `jaytrace.traceNetwork(...)` to inject `traceparent` and record replay/network frames in one place.
Screenshot frames are capped at 320KB by default; raise `maxBytes` and `replay.maxScreenshotBytes` only with a matching collector `maxRumPayloadBytes`.
Call `jaytrace.dispose()` from your app root dispose hook or test teardown, not immediately after `runApp`.
Replay metadata includes `replay.screenshot=enabled` when a screenshot provider is configured and `replay.screenshot=missing` when JayTrace can only record event timelines.
Flutter route tracking also keeps the latest route in replay metadata as `view.name`.
Mobile screenshots can contain visible PII. Use `enabled` to skip payment, identity, health, and auth routes, keep those screens out of `JayTraceReplayRoot`, or mask them before `createJayTraceScreenshotProvider` captures the boundary.
If `sessionId` is omitted, `initJayTraceFlutter` keeps one app-runtime session id so multiple traces group into one replay session.
`initJayTraceFlutterWidgets` exposes `jaytrace.sessionId` for console/session-link debugging.

## Local AI Analysis

```bash
jaytrace-check --sync-s3 s3://jaytrace-prod
```

Print the prompt without running AI:

```bash
jaytrace-check --list
jaytrace-check --ai print --trace-id 4bf92f3577b34da6a3ce929d0e0e4736
jaytrace-check --list --session-id session-rn
jaytrace-check --list --platform web
```

`jaytrace-check --list` prints `actions`, `network`, `errors`, `screens`, and `screenshots=missing` for mobile replays that forgot the screenshot provider.
For v2 web sessions, `--list` prints `replay=v2 segments={n} duration={s}s` instead; rrweb events never enter AI prompts, timeline docs remain the AI food.

## S3 Console

The Next.js console reads local files by default. Set S3 env on the console server to read the bucket directly:

```bash
JAYTRACE_BUCKET=jaytrace-prod JAYTRACE_S3_PREFIX=production AWS_REGION=ap-northeast-2 pnpm dev:console
# or reuse the example collector env without opening the file:
PORT=3008 pnpm dev:console:s3
```

The browser never receives AWS credentials. Only the server-side `/api/traces` route reads S3.
`pnpm dev:console` and `pnpm dev:console:s3` use `.next-console` so `pnpm check` can build `.next` without breaking the running console.
Web sessions with v2 segments render in an rrweb player (scrubber, 1x/2x/4x speed, network/error markers with seek) via `GET /api/replay?sessionId&days`, which stitches segments into one event stream; v1 filmstrip replay still renders for mobile and legacy docs.

To verify mobile replay storage and console image rendering end-to-end through the collector and S3 console:

```bash
pnpm dev:api
PORT=3022 pnpm dev:console:s3
JAYTRACE_COLLECTOR_URL=http://localhost:3000/jaytrace/rum JAYTRACE_CONSOLE_URL=http://localhost:3022 pnpm smoke:mobile-s3
```

Match `JAYTRACE_COLLECTOR_URL` to the `PORT` in `apps/nest-api/.env`; the smoke default is `http://localhost:3012/jaytrace/rum`.

Set `CHROME_PATH` if Chrome is not installed at the macOS default path.

To verify the real `sample-web` Next.js integration end-to-end:

```bash
pnpm dev:api
PORT=3022 pnpm dev:console:s3
cd ../sample-web && pnpm dev:jaytrace:qa
cd . && JAYTRACE_CONSOLE_URL=http://localhost:3022 pnpm smoke:sample-web-web
```

For simulator or device QA, see `docs/mobile-replay-qa.md`.

For local smoke testing, run the collector and console in separate terminals:

```bash
pnpm dev:api
pnpm dev:console
```

## Storage Layout

```txt
s3://bucket/{env}/{yyyy}/{mm}/{dd}/{traceId}/front-{timestamp}.json
s3://bucket/{env}/{yyyy}/{mm}/{dd}/{traceId}/back-{timestamp}.json
s3://bucket/{env}/{yyyy}/{mm}/{dd}/{traceId}/replay-web-{timestamp}.json
s3://bucket/{env}/{yyyy}/{mm}/{dd}/{traceId}/replay-web-{timestamp}-seq{n}.json
s3://bucket/{env}/{yyyy}/{mm}/{dd}/{traceId}/replay-react-native-{timestamp}.json
s3://bucket/{env}/{yyyy}/{mm}/{dd}/{traceId}/replay-react-native-{timestamp}-seq{n}.json
s3://bucket/{env}/{yyyy}/{mm}/{dd}/{traceId}/replay-flutter-{timestamp}.json
s3://bucket/{env}/{yyyy}/{mm}/{dd}/{traceId}/replay-flutter-{timestamp}-seq{n}.json
```

## AWS Setup

Replace `YOUR_JAYTRACE_BUCKET` in the IAM policy templates under `infra/aws`.

```bash
infra/aws/apply-s3-config.sh --bucket YOUR_JAYTRACE_BUCKET --dry-run
infra/aws/apply-s3-config.sh --bucket YOUR_JAYTRACE_BUCKET
```

Use `infra/aws/producer-iam-policy.json` for production servers and `infra/aws/developer-readonly-iam-policy.json` for local analysis users.

## Verify

```bash
pnpm check
```

Load/perf harnesses: `pnpm load:collector` (collector ingest under S3 outage) and `pnpm bench:console` (console query latency at scale) — see `docs/load-test-results.md` for baseline results.

## Example Env

```bash
cp apps/nest-api/.env.example apps/nest-api/.env
cp apps/next-app/.env.example apps/next-app/.env
```

Keep browser apps on public `NEXT_PUBLIC_JAYTRACE_API_KEY`; keep S3 and AWS credentials only on the Nest collector or local console.
