# JayTrace Timeline Format

JayTrace stores AI-readable timeline JSON instead of raw event dumps.

## S3 Layout

```txt
s3://bucket/{env}/{yyyy}/{mm}/{dd}/{traceId}/{side}-{timestamp}.json
```

Example:

```txt
s3://jaytrace-prod/prod/2026/07/01/4bf92f3577b34da6a3ce929d0e0e4736/front-2026-07-01T12-34-56-789Z.json
```

## Frontend Document

```json
{
  "schema": "jaytrace.timeline.v1",
  "service": "web",
  "side": "front",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  "startedAt": "2026-07-01T12:00:00.000Z",
  "endedAt": "2026-07-01T12:00:05.000Z",
  "summary": "User rage-clicked Pay and saw payment failure.",
  "context": {
    "url": "https://example.com/checkout",
    "userAgent": "redacted",
    "release": "1.4.2",
    "environment": "prod"
  },
  "timeline": [
    "0.000s navigation info page loaded /checkout",
    "1.200s rage_click error rage-click button#pay count=4 withinMs=1200",
    "1.300s fetch error fetch POST /api/pay status=500 durationMs=81"
  ]
}
```

## Backend Document

```json
{
  "schema": "jaytrace.timeline.v1",
  "service": "api",
  "side": "back",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  "startedAt": "2026-07-01T12:00:04.900Z",
  "endedAt": "2026-07-01T12:00:05.000Z",
  "summary": "POST /api/pay failed: PrismaClientKnownRequestError Unique constraint failed",
  "context": {
    "route": "/api/pay",
    "method": "POST",
    "statusCode": 500,
    "environment": "prod"
  },
  "error": {
    "name": "PrismaClientKnownRequestError",
    "message": "Unique constraint failed",
    "code": "P2002"
  },
  "timeline": [
    "0.000s request info request POST /api/pay",
    "0.080s db error db payment.create failed P2002",
    "0.100s error error PrismaClientKnownRequestError Unique constraint failed"
  ]
}
```

## Local Analysis

```bash
jaytrace-check --sync-s3 s3://jaytrace-prod
```

For prompt inspection:

```bash
jaytrace-check --list
jaytrace-check --ai print --trace-id 4bf92f3577b34da6a3ce929d0e0e4736
jaytrace-check --list --session-id session-rn
jaytrace-check --list --platform web
```

## Data Rules

- Browser SDK sends only to `/jaytrace/rum`; it never receives AWS credentials.
- Sensitive keys such as `password`, `token`, `authorization`, `cookie`, `set-cookie`, and `apiKey` are redacted inside exported documents. The top-level RUM `apiKey` is preserved only long enough for collector authentication and is not written into timeline or replay documents.
- Web long tasks are stored as `performance warn long_task durationMs=... startMs=... path=...` timeline lines.
- Web page-load timings are stored as `performance info navigation_timing durationMs=... ttfbMs=... domContentLoadedMs=... path=...` timeline lines.
- Timeline lines are short text facts for local AI analysis.
- Raw DOM events, request bodies, cookies, and headers are not dumped.

## Replay Document

Replay is opt-in. Web replay stores masked DOM snapshots plus structured DOM mutations. React Native and Flutter replay store sampled screenshot frames from an app-provided capture hook. JayTrace does not store cookies, headers, request bodies, or input values.
Web DOM snapshots are capped at 768KB by default; oversized snapshots are skipped while replay events are still retained.
Web pages can force privacy with `data-jaytrace-mask` on sensitive subtrees or `data-jaytrace-hidden` on subtrees that must not be captured.
React Native and Flutter screenshot helpers skip frames above 320KB by default so a single image does not make the collector reject the whole replay payload. React Native screenshot capture times out after 1s by default.
Replay frame `kind` is one of `viewport`, `route`, `click`, `input`, `scroll`, `mutation`, `network`, `screenshot`, `gesture`, or `error`; frame `type` is `dom` or `image`.
React Native and Flutter screenshot frames use `type: "image"` and may include numeric `x` and `y` tap coordinates for replay pointer overlays.
React Native and Flutter replay metadata includes `"replay.screenshot": "enabled"` when screenshot capture is configured and `"replay.screenshot": "missing"` when JayTrace can only record event timelines.
React Native screen tracking and Flutter route tracking keep the latest view in replay metadata as `"view.name"`.
React Native fatal global errors append `fatal=true` to the replay error event so the console can surface replay-only fatal crashes.
Mobile screenshot replay can contain visible PII. Mask or exclude payment, identity, health, and auth screens before the capture hook returns an image.

```json
{
  "schema": "jaytrace.replay.v1",
  "platform": "web",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  "mode": "on-error",
  "startedAt": "2026-07-01T12:00:00.000Z",
  "endedAt": "2026-07-01T12:00:05.000Z",
  "metadata": {
    "appVersion": "1.2.3",
    "os": "ios",
    "device": "iPhone",
    "view.name": "Checkout",
    "replay.screenshot": "enabled"
  },
  "events": [
    "0.000s viewport 1440x900 /checkout",
    "1.120s click button#pay x=712 y=531 text=redacted",
    "1.250s input input[name=card] value=redacted",
    "1.800s network POST redacted status=500 durationMs=42",
    "2.010s mutation dom button#pay attr=disabled",
    "2.500s error payment failed"
  ],
  "frames": [
    {
      "at": "0.000s",
      "kind": "viewport",
      "text": "viewport 1440x900 /checkout",
      "type": "dom",
      "html": "<!doctype html><html>..."
    },
    {
      "at": "1.120s",
      "kind": "screenshot",
      "text": "tap PayButton x=210 y=640",
      "type": "image",
      "image": "data:image/png;base64,...",
      "mediaType": "image/png",
      "width": 390,
      "height": 844,
      "x": 210,
      "y": 640
    }
  ],
  "mutations": [
    {
      "at": "2.010s",
      "target": "button text=redacted",
      "targetPath": "body:nth-of-type(1) > button:nth-of-type(1)",
      "type": "attributes",
      "attributeName": "disabled",
      "value": ""
    }
  ]
}
```

Replay files use the same trace folder:

```txt
s3://bucket/{env}/{yyyy}/{mm}/{dd}/{traceId}/replay-web-{timestamp}.json
```

React Native uses the same schema with `platform: "react-native"`:

```ts
import { TextInput } from "react-native";
import { createReactNavigationReplayTracker, createReactNativeScreenshotProvider, createReplayRootProps, initJayTraceReactNative, withReplayPress, withReplayTextInput } from "@jaytrace/replay-react-native";

const jaytrace = initJayTraceReactNative({
  apiKey,
  endpoint: "https://api.example.com/jaytrace/rum",
  traceOrigins: ["https://api.example.com"],
  release: appVersion,
  environment: "production",
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

await jaytrace.traceNetwork({
  method: "POST",
  url,
  headers: { "content-type": "application/json" },
  run: headers => client.post(url, { headers }),
  status: response => response.status
});
```

Flutter uses `platform: "flutter"`:

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

await runJayTraceGuarded(jaytrace.replay, () async {
  runApp(
    MaterialApp(
      navigatorObservers: [JayTraceNavigatorObserver(jaytrace.replay)],
      home: JayTraceReplayRoot(
        boundaryKey: boundaryKey,
        replay: jaytrace.replay,
        child: CheckoutScreen(
          onPay: pay,
          onEmailChanged: jayTraceReplayOnChanged(jaytrace.replay, 'EmailInput'),
        ),
      ),
    ),
  );
});

await jaytrace.traceNetwork(
  method: 'POST',
  url: uri,
  run: (headers) => client.post(uri, headers: headers),
  status: (response) => response.statusCode,
);
jaytrace.setUser({'id': userId});
jaytrace.addAction('CheckoutStarted', detail: 'plan=pro');
jaytrace.addInput('EmailInput');
jaytrace.addScroll('CheckoutList', offset: 320);
jaytrace.addPerformance('SlowCheckoutScreen', const Duration(milliseconds: 420), detail: 'route=/checkout');
```
