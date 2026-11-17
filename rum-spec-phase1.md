# RUM Spec Phase 1

JayTrace Phase 1 S3 log schema and SDK interface draft for Next.js, React Native, and Flutter.

## 1. Scope

| Area | Phase 1 Decision |
| --- | --- |
| Storage | S3 object storage is the source of truth. App servers and collectors write JSON files. Consoles and CLIs read from S3 or a synced local copy. |
| Trace join key | `traceId` from W3C `traceparent`. Frontend, backend, and replay documents must share this value. |
| Session join key | `sessionId`. Multiple traces can belong to one user session. |
| Document types | `jaytrace.timeline.v1` for compact RUM/backend timelines, `jaytrace.replay.v1` for session replay. |
| Privacy baseline | No cookies, headers, request bodies, or raw input values. Sensitive keys are redacted. Mobile screenshots require an explicit screenshot provider. |
| AI target | Documents are short, text-first, and timeline-shaped so local CLI AI can explain "user action -> network/backend failure -> replay evidence". |

## 2. S3 Object Layout

Recommended object key format:

```text
s3://{bucket}/{environment}/{yyyy}/{mm}/{dd}/{traceId}/{side}-{timestamp}.json
```

Examples:

```text
s3://jaytrace-prod/production/2026/07/03/4bf92f3577b34da6a3ce929d0e0e4736/front-2026-07-03T10-15-30-100Z.json
s3://jaytrace-prod/production/2026/07/03/4bf92f3577b34da6a3ce929d0e0e4736/back-2026-07-03T10-15-30-140Z.json
s3://jaytrace-prod/production/2026/07/03/4bf92f3577b34da6a3ce929d0e0e4736/replay-web-2026-07-03T10-15-30-200Z.json
s3://jaytrace-prod/production/2026/07/03/4bf92f3577b34da6a3ce929d0e0e4736/replay-react-native-2026-07-03T10-15-30-200Z.json
s3://jaytrace-prod/production/2026/07/03/4bf92f3577b34da6a3ce929d0e0e4736/replay-flutter-2026-07-03T10-15-30-200Z.json
```

## 3. Common Session and Event Format

### 3.1 Timeline Document

Used by Next.js/Web RUM and backend error logs.

```json
{
  "schema": "jaytrace.timeline.v1",
  "side": "front",
  "service": "web",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "sessionId": "session-01HY...",
  "spanId": "00f067aa0ba902b7",
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  "startedAt": "2026-07-03T10:15:30.000Z",
  "endedAt": "2026-07-03T10:15:31.000Z",
  "context": {
    "release": "1.2.3",
    "environment": "production",
    "route": "/checkout",
    "user.id": "user-123"
  },
  "timeline": [
    "0.000s navigation info page loaded /checkout",
    "0.018s performance info navigation_timing durationMs=789 ttfbMs=46 domContentLoadedMs=346 path=/checkout",
    "0.567s click info click button text=redacted x=1322 y=58",
    "0.600s fetch error fetch POST /api/pay status=500 durationMs=33",
    "0.602s error error unhandledrejection Error: Pay now failed with 500"
  ],
  "error": {
    "name": "Error",
    "message": "Pay now failed with 500",
    "stack": "Error: Pay now failed with 500\n    at pay (/app/checkout.tsx:42:11)"
  }
}
```

### 3.2 Common Fields

| Field | Type | Required | Applies To | Notes |
| --- | --- | --- | --- | --- |
| `schema` | string | yes | all docs | `jaytrace.timeline.v1` or `jaytrace.replay.v1`. |
| `traceId` | string | yes | all docs | 32 lowercase hex chars. Primary join key. |
| `sessionId` | string | recommended | all docs | Groups repeated traces into one session. |
| `traceparent` | string | recommended | all docs | W3C trace context. Used for frontend/backend propagation. |
| `startedAt` | ISO string | yes | all docs | UTC start timestamp. |
| `endedAt` | ISO string | recommended | all docs | UTC end timestamp. |
| `context` | object | optional | timeline | Compact operational metadata. |
| `metadata` | object | optional | replay | Replay metadata such as release, environment, device, and `view.name`. |
| `timeline` | string[] | yes | timeline | Short, ordered text facts for AI. |
| `events` | string[] | yes | replay | Short, ordered replay facts for AI. |
| `frames` | object[] | optional | replay | Visual replay frames. Web uses DOM snapshots; mobile uses screenshots. |

### 3.3 Timeline Line Format

```text
{offset}s {kind} {severity} {message}
```

| Part | Example | Notes |
| --- | --- | --- |
| `offset` | `0.600s` | Relative to `startedAt`. |
| `kind` | `navigation`, `click`, `fetch`, `error`, `performance`, `db` | Small vocabulary; readable beats perfect ontology. |
| `severity` | `info`, `warn`, `error` | Used for filtering and issue grouping. |
| `message` | `fetch POST /api/pay status=500 durationMs=33` | Prefer compact key/value text. |

## 4. Web Session Replay Payload

Phase 1 web replay is rrweb-compatible in spirit: masked DOM snapshots plus event/mutation timelines. The storage document remains JayTrace's compact `jaytrace.replay.v1` shape so S3 console and CLI use one reader.

```json
{
  "schema": "jaytrace.replay.v1",
  "platform": "web",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "sessionId": "web-session-01",
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  "mode": "on-error",
  "startedAt": "2026-07-03T10:15:30.000Z",
  "endedAt": "2026-07-03T10:15:31.000Z",
  "metadata": {
    "release": "1.2.3",
    "environment": "production",
    "url": "https://app.example.com/checkout",
    "userAgent": "Mozilla/5.0 ..."
  },
  "events": [
    "0.000s viewport viewport 1440x900 /checkout",
    "0.018s gesture performance navigation_timing durationMs=789 ttfbMs=46 domContentLoadedMs=346 path=/checkout",
    "0.567s click click button text=redacted x=1322 y=58",
    "0.600s network fetch POST /api/pay status=500 durationMs=33",
    "0.602s error error unhandledrejection Error: Pay now failed with 500"
  ],
  "frames": [
    {
      "at": "0.000s",
      "kind": "viewport",
      "text": "viewport 1440x900 /checkout",
      "type": "dom",
      "url": "https://app.example.com/checkout",
      "width": 1440,
      "height": 900,
      "html": "<!doctype html><html><head><base href=\"https://app.example.com/checkout\"></head><body>...</body></html>"
    },
    {
      "at": "0.567s",
      "kind": "click",
      "text": "click button text=redacted x=1322 y=58",
      "type": "dom",
      "url": "https://app.example.com/checkout",
      "width": 1440,
      "height": 900,
      "x": 1322,
      "y": 58,
      "html": "<!doctype html><html>...</html>"
    }
  ],
  "mutations": [
    {
      "at": "0.570s",
      "type": "attributes",
      "target": "button",
      "targetPath": "html > body > main > button",
      "attributeName": "disabled",
      "value": ""
    }
  ]
}
```

### 4.1 Web Replay Frame Fields

| Field | Type | Notes |
| --- | --- | --- |
| `kind` | enum | `viewport`, `route`, `click`, `input`, `scroll`, `mutation`, `network`, `gesture`, `error`. |
| `type` | string | Web visual frames use `dom`. |
| `html` | string | Masked DOM snapshot. Capped by SDK option. |
| `x`, `y` | number | Present for click/pointer frames. |
| `url` | string | Current page URL. |
| `width`, `height` | number | Viewport dimensions. |

## 5. Mobile Replay Payload

Phase 1 mobile replay uses native event logs plus sampled screenshot frames. This avoids trying to serialize every platform-specific native view into a fragile universal tree while still giving a Datadog-like "what screen was the user on?" replay.

### 5.1 React Native Sample

```json
{
  "schema": "jaytrace.replay.v1",
  "platform": "react-native",
  "traceId": "33333333333333333333019f28068007",
  "sessionId": "s3-mobile-session-rn",
  "traceparent": "00-33333333333333333333019f28068007-00f067aa0ba902b7-01",
  "mode": "on-error",
  "startedAt": "2026-07-03T10:15:30.000Z",
  "endedAt": "2026-07-03T10:15:31.000Z",
  "metadata": {
    "release": "1.0.0-rn",
    "environment": "qa",
    "user.id": "mobile-user-rn",
    "view.name": "Checkout",
    "os": "ios",
    "device": "iPhone",
    "replay.screenshot": "enabled"
  },
  "events": [
    "0.000s route screen Checkout",
    "0.180s input input EmailInput value=redacted",
    "0.240s scroll scroll CheckoutList offset=320",
    "0.300s gesture tap PayButton x=210 y=640",
    "0.420s gesture performance JSFrameBlocked durationMs=124",
    "0.600s network POST https://api.example.test/pay status=500 durationMs=70",
    "0.620s error Error: rn s3 payment failed"
  ],
  "frames": [
    {
      "at": "0.300s",
      "kind": "gesture",
      "text": "tap PayButton x=210 y=640",
      "type": "image",
      "image": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB...",
      "mediaType": "image/png",
      "width": 390,
      "height": 844,
      "x": 210,
      "y": 640
    }
  ]
}
```

### 5.2 Flutter Sample

```json
{
  "schema": "jaytrace.replay.v1",
  "platform": "flutter",
  "traceId": "44444444444444444444019f28068007",
  "sessionId": "s3-mobile-session-flutter",
  "traceparent": "00-44444444444444444444019f28068007-00f067aa0ba902b7-01",
  "mode": "on-error",
  "startedAt": "2026-07-03T10:15:30.000Z",
  "endedAt": "2026-07-03T10:15:31.000Z",
  "metadata": {
    "release": "1.0.0-flutter",
    "environment": "qa",
    "user.id": "mobile-user-flutter",
    "view.name": "Checkout",
    "os": "android",
    "device": "Pixel",
    "replay.screenshot": "enabled"
  },
  "events": [
    "0.000s route route /checkout",
    "0.180s input input EmailInput value=redacted",
    "0.240s scroll scroll CheckoutList offset=320",
    "0.300s gesture tap ElevatedButton#pay x=205 y=632",
    "0.420s gesture performance RasterBlocked durationMs=123",
    "0.600s network POST https://api.example.test/pay status=500 durationMs=73",
    "0.620s error Exception: flutter s3 payment failed"
  ],
  "frames": [
    {
      "at": "0.300s",
      "kind": "gesture",
      "text": "tap ElevatedButton#pay x=205 y=632",
      "type": "image",
      "image": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB...",
      "mediaType": "image/png",
      "width": 393,
      "height": 852,
      "x": 205,
      "y": 632
    }
  ]
}
```

### 5.3 Mobile Virtual Tree Event Shape

If a future mobile SDK adds a native virtual tree snapshot, keep it optional and additive:

```json
{
  "at": "0.300s",
  "kind": "gesture",
  "text": "tap PayButton x=210 y=640",
  "tree": {
    "type": "Screen",
    "name": "Checkout",
    "children": [
      {
        "type": "Button",
        "label": "PayButton",
        "bounds": { "x": 180, "y": 620, "width": 120, "height": 48 },
        "text": "redacted"
      }
    ]
  }
}
```

Phase 1 does not require this field. Screenshots plus compact events are the baseline because they are simpler, cheaper, and more robust across RN and Flutter rendering stacks.

## 6. SDK Init Interfaces

The product-level abstraction name is `MyRUM`. Implementations can delegate to JayTrace SDKs internally.

### 6.1 Next.js

```ts
// src/instrumentation-client.ts
import { initJayTraceNext } from "@jaytrace/browser/next";

export const MyRUM = {
  init(options: {
    apiKey: string;
    endpoint?: string;
    service?: string;
    release?: string;
    environment?: string;
    traceOrigins?: string[];
    replay?: {
      enabled?: boolean;
      mode?: "on-error" | "always" | "off";
      privacy?: "mask-all" | "mask-inputs" | "allow";
      networkOrigins?: string[];
    };
  }) {
    return initJayTraceNext({
      apiKey: options.apiKey,
      endpoint: options.endpoint ?? "/jaytrace/rum",
      service: options.service ?? "web",
      release: options.release,
      environment: options.environment,
      traceOrigins: options.traceOrigins,
      replay: {
        enabled: options.replay?.enabled ?? true,
        mode: options.replay?.mode ?? "on-error",
        privacy: options.replay?.privacy ?? "mask-all",
        networkOrigins: options.replay?.networkOrigins ?? options.traceOrigins
      }
    });
  }
};

MyRUM.init({
  apiKey: process.env.NEXT_PUBLIC_JAYTRACE_API_KEY!,
  traceOrigins: ["https://api.example.com"],
  replay: { mode: "on-error" }
});
```

### 6.2 React Native

```ts
import {
  createReactNavigationReplayTracker,
  createReactNativeScreenshotProvider,
  createReplayRootProps,
  initJayTraceReactNative,
  withReplayPress,
  withReplayTextInput
} from "@jaytrace/replay-react-native";
import { AppState } from "react-native";

export const MyRUM = {
  init(options: {
    apiKey: string;
    endpoint: string;
    release?: string;
    environment?: string;
    traceOrigins?: string[];
    navigationRef?: { getCurrentRoute(): { key?: string; name: string } | undefined };
    captureScreen?: () => Promise<string>;
  }) {
    const client = initJayTraceReactNative({
      apiKey: options.apiKey,
      endpoint: options.endpoint,
      release: options.release,
      environment: options.environment,
      traceOrigins: options.traceOrigins,
      appState: AppState,
      metadata: {
        release: options.release,
        environment: options.environment,
        os: "ios"
      },
      screenshot: options.captureScreen
        ? createReactNativeScreenshotProvider({ capture: options.captureScreen })
        : undefined,
      replay: { enabled: true, mode: "on-error" }
    });

    const tracker = options.navigationRef
      ? createReactNavigationReplayTracker(client.replay, options.navigationRef)
      : null;

    return {
      ...client,
      tracker,
      createReplayRootProps: () => createReplayRootProps(client.replay),
      withReplayPress: (name: string, handler: () => void) => withReplayPress(client.replay, name, handler),
      withReplayTextInput: (name: string, handler: (value: string) => void) => withReplayTextInput(client.replay, name, handler)
    };
  }
};
```

### 6.3 Flutter

```dart
import 'package:jaytrace_flutter/jaytrace_flutter.dart';
import 'package:jaytrace_flutter/jaytrace_flutter_widgets.dart';

class MyRUM {
  static JayTraceFlutterWidgetsClient init({
    required String apiKey,
    required Uri endpoint,
    required JayTraceReplaySender sender,
    required GlobalKey replayBoundaryKey,
    String? release,
    String? environment,
    List<String>? traceOrigins,
  }) {
    return initJayTraceFlutterWidgets(
      apiKey: apiKey,
      endpoint: endpoint,
      sender: sender,
      release: release,
      environment: environment,
      traceOrigins: traceOrigins,
      metadata: {
        'release': release,
        'environment': environment,
        'os': 'android',
      },
      screenshot: createJayTraceScreenshotProvider(replayBoundaryKey),
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        mode: JayTraceReplayMode.onError,
      ),
    );
  }
}

final jaytrace = MyRUM.init(
  apiKey: const String.fromEnvironment('JAYTRACE_API_KEY'),
  endpoint: Uri.parse('https://api.example.com/jaytrace/rum'),
  sender: jayTraceHttpSender,
  replayBoundaryKey: replayBoundaryKey,
  release: '1.2.3',
  environment: 'production',
);
```

## 7. Platform Responsibility Matrix

| Capability | Next.js/Web | React Native | Flutter |
| --- | --- | --- | --- |
| One-line init | `initJayTraceNext(...)` | `initJayTraceReactNative(...)` | `initJayTraceFlutterWidgets(...)` |
| Trace propagation | fetch/XHR `traceparent` | patched fetch and `traceNetwork` | `headers()` and `traceNetwork` |
| Error capture | `window.onerror`, unhandled rejection | global error and unhandled rejection handlers | Flutter/platform error handlers |
| User action | click, scroll, custom action | press, input, scroll, custom action | tap, input, scroll, custom action |
| Replay visual | masked DOM snapshot | screenshot provider | screenshot provider |
| Replay route | browser path/history | React Navigation tracker | Navigator observer |
| Performance | navigation timing, long task | custom `addPerformance` | custom `addPerformance` |
| Privacy | DOM mask/hide attributes | no input values, explicit screenshot gate | no input values, explicit screenshot gate |

## 8. Validation Rules

| Rule | Required Behavior |
| --- | --- |
| `traceId` | Must be present and stable across front, back, and replay documents for one incident. |
| `traceparent` | Must follow W3C format: `00-{traceId}-{spanId}-{flags}`. |
| `timeline` / `events` | Must be ordered, compact strings. Avoid dumping raw objects. |
| Mobile screenshots | Must be `data:image/png;base64,...`, `data:image/jpg;base64,...`, or `data:image/jpeg;base64,...`. |
| Input privacy | Input values are always `redacted`. |
| Secret privacy | Keys such as `password`, `token`, `authorization`, `cookie`, `set-cookie`, and `apiKey` are redacted in documents. |
| Replay metadata | Mobile replay should include `replay.screenshot`, `release`, `environment`, `user.id`, `view.name`, `os`, and `device` when available. |

## 9. Local AI Join Contract

The CLI or local AI agent should join files by `traceId`, then group sessions by `sessionId`.

```text
front timeline:  jaytrace.timeline.v1 side=front traceId=A
back timeline:   jaytrace.timeline.v1 side=back  traceId=A
session replay:  jaytrace.replay.v1   platform=* traceId=A
```

Prompt input should be ordered by time and labeled:

```text
FRONTEND USER TIMELINE
- 0.567s click info click button text=redacted x=1322 y=58
- 0.600s fetch error fetch POST /api/pay status=500 durationMs=33

BACKEND ERROR TIMELINE
- 0.000s request info request POST /api/pay
- 0.001s db error payment.create failed P2002
- 0.001s error error PrismaClientKnownRequestError Unique constraint failed

SESSION REPLAY SIGNALS
- platform: web
- frames: 11 captured
- performance: navigation_timing durationMs=789 ttfbMs=46
- network: fetch POST /api/pay status=500 durationMs=33
```

This is the Phase 1 contract: compact S3 JSON files first, dashboard and local AI readers second, heavier analytics later only if the S3 contract remains stable.
