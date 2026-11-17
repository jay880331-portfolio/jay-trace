# Mobile Replay QA

Use this after the collector and S3 console are running:

```bash
pnpm dev:api
PORT=3022 pnpm dev:console:s3
```

## React Native

1. Install `@jaytrace/replay-react-native` in the app.
2. Initialize once at app startup with `initJayTraceReactNative(...)`.
3. Pass a real screenshot hook, for example `react-native-view-shot`'s `captureScreen`, through `createReactNativeScreenshotProvider`.
4. Add `createReactNavigationReplayTracker(...)` to React Navigation.
5. Spread `createReplayRootProps(jaytrace.replay)` on the app root.
6. Wrap key press targets with `withReplayPress(...)`.
7. Trigger a screen action that returns a 500 or throws.

Pass criteria:

- `/jaytrace/rum` returns `201`.
- S3 console shows `sourceMode=s3`.
- The trace has `replay:react-native`.
- `replay.screenshot=enabled`.
- `Screens` is greater than 0.
- The replay player shows the phone frame, tap point, and failed network row.

Evidence to capture:

- copy the console trace link with `view=issues`, `platform=react-native`, and `screens=1`
- confirm the selected replay frame has an image, numeric `x` and `y`, and a `status=5xx` network row
- confirm the session row groups repeated failures under the same `sessionId`
- confirm the replay metadata includes `release`, `environment`, `user.id`, `view.name`, `os`, and `device`

## Flutter

1. Install `jaytrace_flutter`.
2. Create a `GlobalKey` for the capture boundary.
3. Initialize once with `initJayTraceFlutterWidgets(...)`.
4. Pass `createJayTraceScreenshotProvider(boundaryKey, enabled: ...)`.
5. Wrap the app in `JayTraceReplayRoot(boundaryKey: boundaryKey, ...)`.
6. Add `JayTraceNavigatorObserver(jaytrace.replay)` to navigation.
7. Use `jaytrace.traceNetwork(...)` around important API calls.
8. Trigger a screen action that returns a 500 or throws.

Pass criteria:

- `/jaytrace/rum` returns `201`.
- S3 console shows `sourceMode=s3`.
- The trace has `replay:flutter`.
- `replay.screenshot=enabled`.
- `Screens` is greater than 0.
- The replay player shows the phone frame, tap point, and failed network row.

Evidence to capture:

- copy the console trace link with `view=issues`, `platform=flutter`, and `screens=1`
- confirm the selected replay frame has an image, numeric `x` and `y`, and a `status=5xx` network row
- confirm the session row groups repeated failures under the same `sessionId`
- confirm the replay metadata includes `release`, `environment`, `user.id`, `view.name`, `os`, and `device`

## React Native wireframe QA

`replay.engine` defaults to `"wireframe"`: instead of screenshots, `@jaytrace/replay-react-native`
serializes registered/measured view-tree nodes to rect/text/image vector frames and uploads them as
`jaytrace.replay.v2` segments. Run this against a real app, not the synthetic smoke below.

1. Run an RN app with `initJayTraceReactNative(...)` / `<JayTraceRoot>` initialized (engine left at
   its `wireframe` default — do not pass `replay: { engine: 'screenshot' }`).
2. Feed the wireframe coordinator with view-tree snapshots via `captureViewTree(node)` (call it from
   app/navigation/press hooks, or rely on the periodic capture timer) using measured
   `ReactNativeViewTreeNode` refs (`measureInWindow` bounds) — no native module is required for this
   partial-fidelity path.
3. Set continuous capture on via options (RN has no env, pass args directly):
   `replay: { engine: "wireframe", sampleRate: 1 }` — `sampleRate: 1` is what drives continuous capture (there is no separate "always" engine/mode for RN).
4. Drive a few screens: navigate between routes, tap a button, scroll a list, and trigger a screen
   action that returns a 500 or throws (error escalation should flush a seq 0 segment immediately
   regardless of sampling).
5. Open the S3 console (`view=sessions`), select the session, and confirm:
   - the session replay panel renders the wireframe SVG player (not the screenshot filmstrip)
   - the scrubber advances through multiple frames as you drag it, matching the screens you drove
   - text nodes show only masked bars/char counts (no visible copy) unless the app used
     `privacy: allow`
   - the error screen's segment is present even if the session was outside the sample rate

Evidence to capture:

- copy the console session link (`view=sessions`, `sessionId=...`)
- confirm `/api/replay?sessionId=...` returns `engine: "wireframe"` and `segments >= 2`
- confirm the replay metadata includes `release`, `environment`, and `view.name`

The repo has no bundled React Native app, so there is no automated device/simulator run for this
flow. `pnpm smoke:rn-wireframe-console` (below) is the automated proxy: it posts synthetic RN
wireframe segments (`platform: "react-native"`) straight to the collector and verifies the same
collector → S3 → console pipeline end to end.

### Native upgrade path

The JS measurement-based capture above is partial-fidelity: it only sees registered/interactive
elements the app explicitly measures (`captureViewTree`/`measureInWindow`), not the full native view
hierarchy. Full-screen wireframe fidelity can be reached with a native module that walks the
platform's real view tree and emits geometry/type directly — `RCTUIManager` on iOS, the Android view
hierarchy on Android — instead of relying on JS-side measurement. That native module is out of scope
here and is documented only; it would slot into the same `viewTreeToWireframeNodes` /
`jaytrace.replay.v2` pipeline unchanged.

## Flutter wireframe QA

`replay.engine` defaults to `"wireframe"`: instead of screenshots, `jaytrace_flutter` serializes the
render tree to rect/text/image vector frames and uploads them as `jaytrace.replay.v2` segments. Run
this against a real device or simulator, not the synthetic smoke below.

1. Run a Flutter app with `jaytrace_flutter` initialized via `initJayTraceFlutterWidgets(...)` (engine
   left at its `wireframe` default — do not pass `engine: 'screenshot'`).
2. Launch with continuous capture on: `flutter run --dart-define=JAYTRACE_REPLAY_MODE=always --dart-define=JAYTRACE_REPLAY_SAMPLE_RATE=1`.
3. Drive a few screens: navigate between routes, tap a button, scroll a list, and trigger a screen
   action that returns a 500 or throws (error escalation should flush a seq 0 segment immediately
   regardless of sampling).
4. Open the S3 console (`view=sessions`), select the session, and confirm:
   - the session replay panel renders the wireframe SVG player (not the screenshot filmstrip)
   - the scrubber advances through multiple frames as you drag it, matching the screens you drove
   - text nodes show only masked bars/char counts (no visible copy) unless the app used
     `privacy: allow`
   - the error screen's segment is present even if the session was outside the sample rate

Evidence to capture:

- copy the console session link (`view=sessions`, `sessionId=...`)
- confirm `/api/replay?sessionId=...` returns `engine: "wireframe"` and `segments >= 2`
- confirm the replay metadata includes `release`, `environment`, and `view.name`

The repo has no bundled Flutter app, so there is no automated device/simulator run for this flow.
`pnpm smoke:wireframe-console` (below) is the automated proxy: it posts synthetic wireframe segments
straight to the collector and verifies the same collector → S3 → console pipeline end to end.

## Fast Smoke

This does not replace device QA. It verifies collector, S3 export, S3 reader, and console replay rendering with valid mobile replay documents.

```bash
JAYTRACE_CONSOLE_URL=http://localhost:3022 pnpm smoke:mobile-s3
```

Smoke pass criteria:

- `sourceMode` is `s3`
- React Native and Flutter each return `screens: 6`
- React Native and Flutter each return `consoleReplayImages: 1` or more
- React Native and Flutter each return `consoleFailureVisible: true`
- each result includes a tap `point`, redacted `input`, `scroll`, `performance`, failed `network` text, `sessionId`, `release`, `environment`, and `userId`

This covers screenshot-path (v1) replay. For the Flutter wireframe (v2) pipeline:

```bash
JAYTRACE_CONSOLE_URL=http://localhost:3022 pnpm smoke:wireframe-console
```

Smoke pass criteria:

- collector accepts both synthetic wireframe segments with `201`
- `/api/replay?sessionId=...` returns `engine: "wireframe"`, `segments >= 2`, and `wireframeFrames.length >= 3`
- the console renders the wireframe SVG player (`.replayPlayer [data-wireframe]`) with 3 or more `<rect>` elements, plus `.replayScrubber` and `.replayPlayToggle`

For the React Native wireframe (v2) pipeline, same pass criteria as above but `platform: "react-native"`:

```bash
JAYTRACE_CONSOLE_URL=http://localhost:3022 pnpm smoke:rn-wireframe-console
```
