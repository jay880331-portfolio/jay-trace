import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jaytrace_flutter/jaytrace_flutter.dart';
import 'package:jaytrace_flutter/jaytrace_flutter_widgets.dart';
import 'package:jaytrace_flutter/jaytrace_flutter_wireframe.dart';

// 1x1 transparent PNG (valid enough for Image.memory geometry).
final Uint8List _tinyPng = Uint8List.fromList(const [
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, //
  0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, //
  156, 99, 250, 207, 0, 0, 0, 3, 0, 1, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, //
  96, 130
]);

Widget _wireframeSample({String label = 'Pay now'}) {
  return MaterialApp(
    home: Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ElevatedButton(
              onPressed: () {},
              child: Text(label),
            ),
            const Text('Label'),
            Image.memory(_tinyPng, width: 80, height: 80),
          ],
        ),
      ),
    ),
  );
}

/// A screen with far more on-screen rect nodes than fit under the wireframe
/// engine's 32KB-per-frame cap, so any capture of it is dropped.
Widget _wireframeManyNodes() {
  return MaterialApp(
    home: Scaffold(
      body: Wrap(
        // DecoratedBox emits a RenderDecoratedBox (a rect node); a plain
        // Container(color:) compiles to RenderColoredBox, which the wireframe
        // walker skips — so use DecoratedBox to actually blow the frame cap.
        children: List.generate(
          1500,
          (i) => const DecoratedBox(
            decoration: BoxDecoration(color: Colors.red),
            child: SizedBox(width: 12, height: 12),
          ),
        ),
      ),
    ),
  );
}

/// Three text boundary cases in one tree: empty string, an emoji + Korean
/// string, and a 10,000-char string.
Widget _wireframeTextBoundaries() {
  return MaterialApp(
    home: Scaffold(
      body: Column(
        children: [
          const Text(''),
          const Text('\u{1F4B3} 결제'), // "💳 결제"
          // maxLines/overflow keep this single-line so a 10,000-char string
          // doesn't blow the Column's height (chars is computed from the
          // full logical string regardless of visual clipping).
          Text('x' * 10000, maxLines: 1, overflow: TextOverflow.clip),
        ],
      ),
    ),
  );
}

Map<String, Object?>? _firstWhereOrNull(
  List<Map<String, Object?>> nodes,
  bool Function(Map<String, Object?>) test,
) {
  for (final node in nodes) {
    if (test(node)) {
      return node;
    }
  }
  return null;
}

void main() {
  testWidgets('navigator observer and tap wrapper compile and record route',
      (tester) async {
    final boundaryKey = GlobalKey();
    final calls = <String>[];
    final replay = JayTraceFlutterReplay.init(
      JayTraceFlutterOptions(
        apiKey: 'flutter-key',
        endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        replay: const JayTraceFlutterReplayOptions(enabled: true),
        screenshot: createJayTraceScreenshotProvider(boundaryKey),
        sender: (endpoint, headers, body) {
          calls.add(body);
        },
      ),
    );

    final observer = JayTraceNavigatorObserver(replay);
    final route = PageRouteBuilder<void>(
      settings: const RouteSettings(name: '/checkout'),
      pageBuilder: (context, animation, secondaryAnimation) =>
          const SizedBox.shrink(),
    );
    observer.didPush(route, null);
    observer.didPop(route, null);

    final widget = JayTraceReplayTap(
      replay: replay,
      target: 'PayButton',
      child: const SizedBox.shrink(),
    );

    expect(widget.target, 'PayButton');
    expect(replay!.snapshot()['events'].toString(), contains('route'));
    expect(replay.snapshot()['events'].toString(), contains('route_end'));

    await tester.pumpWidget(
      JayTraceReplayRoot(
        boundaryKey: boundaryKey,
        replay: replay,
        target: 'App',
        child: const Directionality(
          textDirection: TextDirection.ltr,
          child: Text('Checkout'),
        ),
      ),
    );
    await tester.tap(find.text('Checkout'));
    await tester.pump(const Duration(seconds: 1));
    final screenshotProvider = createJayTraceScreenshotProvider(
      boundaryKey,
      timeout: const Duration(milliseconds: 200),
    );
    expect(screenshotProvider, isA<JayTraceScreenshotProvider>());
    final screenshot = await tester.runAsync(() async => screenshotProvider());
    await tester.pump(const Duration(seconds: 1));
    if (screenshot != null) {
      expect(screenshot.image, startsWith('data:image/png;base64,'));
      expect(screenshot.width, greaterThan(0));
      expect(screenshot.height, greaterThan(0));
    }
    var disabledCaptureCalled = false;
    final disabledProvider = createJayTraceScreenshotProvider(
      boundaryKey,
      enabled: () {
        disabledCaptureCalled = true;
        return false;
      },
    );
    expect(await disabledProvider(), isNull);
    expect(disabledCaptureCalled, isTrue);
    final throwingDisabledProvider = createJayTraceScreenshotProvider(
      boundaryKey,
      enabled: () => throw StateError('route check failed'),
    );
    expect(await throwingDisabledProvider(), isNull);
    expect(replay.snapshot()['events'].toString(), contains('tap redacted'));
    var changedValue = '';
    jayTraceReplayOnChanged(
      replay,
      'EmailInput',
      (value) {
        changedValue = value;
      },
    )('secret@example.test');
    expect(changedValue, 'secret@example.test');
    expect(replay.snapshot()['events'].toString(),
        contains('input redacted value=redacted'));
    expect(replay.snapshot()['events'].toString(),
        isNot(contains('secret@example.test')));

    final errorCalls = <String>[];
    final errorReplay = JayTraceFlutterReplay.init(
      JayTraceFlutterOptions(
        apiKey: 'flutter-key',
        endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
        traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        replay: const JayTraceFlutterReplayOptions(enabled: true),
        sender: (endpoint, headers, body) {
          errorCalls.add(body);
        },
      ),
    );
    final originalOnError = FlutterError.onError;
    final originalPlatformOnError = ui.PlatformDispatcher.instance.onError;
    var previousCalled = false;
    var previousPlatformCalled = false;
    FlutterError.onError = (details) {
      previousCalled = true;
    };
    ui.PlatformDispatcher.instance.onError = (error, stackTrace) {
      previousPlatformCalled = true;
      return true;
    };
    final handlers = installJayTraceFlutterErrorHandler(errorReplay);
    FlutterError.onError?.call(
      FlutterErrorDetails(
        exception: StateError('framework crash'),
      ),
    );
    ui.PlatformDispatcher.instance.onError
        ?.call(StateError('platform crash'), StackTrace.current);
    await tester.runAsync(() async {
      await Future<void>.delayed(Duration.zero);
    });
    handlers.uninstall();
    FlutterError.onError = originalOnError;
    ui.PlatformDispatcher.instance.onError = originalPlatformOnError;
    expect(previousCalled, isTrue);
    expect(previousPlatformCalled, isTrue);
    // recordError now emits a replay document AND a parallel timeline document.
    // The two back-to-back errors' replay flushes interleave into two replay
    // docs, while the timeline addError lands both events before the first
    // (re-entrant, merged) timeline flush — so both crashes are captured across
    // the timeline document(s).
    final errorReplayDocs = errorCalls.where((body) =>
        ((jsonDecode(body) as Map<String, dynamic>)['document']
            as Map<String, dynamic>)['schema'] == 'jaytrace.replay.v1');
    final errorTimelineDocs = errorCalls.where((body) =>
        ((jsonDecode(body) as Map<String, dynamic>)['document']
            as Map<String, dynamic>)['schema'] == 'jaytrace.timeline.v1');
    expect(errorReplayDocs.length, 2);
    expect(errorTimelineDocs, isNotEmpty);
    final errorTimelineText = errorTimelineDocs.join('\n');
    expect(errorTimelineText, contains('framework crash'));
    expect(errorTimelineText, contains('platform crash'));
    expect(errorCalls.join('\n'), contains('framework crash'));
    expect(errorCalls.join('\n'), contains('platform crash'));

    FlutterError.onError = originalOnError;
    ui.PlatformDispatcher.instance.onError = originalPlatformOnError;
    final nullHandlers = installJayTraceFlutterErrorHandler(null);
    expect(FlutterError.onError, same(originalOnError));
    expect(ui.PlatformDispatcher.instance.onError, same(originalPlatformOnError));
    nullHandlers.uninstall();
    expect(FlutterError.onError, same(originalOnError));
    expect(ui.PlatformDispatcher.instance.onError, same(originalPlatformOnError));

    final oneLineCalls = <String>[];
    FlutterError.onError = (details) {};
    final oneLine = initJayTraceFlutterWidgets(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      release: '2.1.0',
      environment: 'qa',
      sender: (endpoint, headers, body) {
        oneLineCalls.add(body);
      },
    );
    oneLine.setUser({'id': 'one-line-user', 'token': 'secret'});
    oneLine.addAction('OneLineCheckout', detail: 'token secret');
    oneLine.addInput('CouponInput');
    oneLine.addScroll('CheckoutList', offset: 320);
    oneLine.addPerformance('SlowScreen', const Duration(milliseconds: 234),
        detail: 'token secret');
    oneLine.lifecycleObserver
        .didChangeAppLifecycleState(AppLifecycleState.paused);
    await tester.runAsync(() async {
      await Future<void>.delayed(Duration.zero);
    });
    FlutterError.onError?.call(
      FlutterErrorDetails(
        exception: StateError('one-line framework crash'),
      ),
    );
    await tester.runAsync(() async {
      await Future<void>.delayed(Duration.zero);
    });
    oneLine.dispose();
    expect(oneLine.sessionId, isNotEmpty);
    expect(oneLineCalls, isNotEmpty);
    expect(oneLineCalls.join('\n'), contains('one-line framework crash'));
    expect(oneLineCalls.join('\n'), contains('"reason":"manual"'));
    expect(oneLineCalls.join('\n'), contains('"release":"2.1.0"'));
    expect(oneLineCalls.join('\n'), contains('"environment":"qa"'));
    expect(oneLineCalls.join('\n'), contains('"user.id":"one-line-user"'));
    expect(oneLineCalls.join('\n'), contains('action redacted redacted'));
    expect(oneLineCalls.join('\n'), contains('input redacted value=redacted'));
    expect(oneLineCalls.join('\n'), contains('scroll redacted offset=320'));
    expect(oneLineCalls.join('\n'),
        contains('performance redacted durationMs=234 redacted'));
  });

  testWidgets('buildJayTraceRoot wraps app in replay boundary', (tester) async {
    final boundaryKey = GlobalKey();
    final client = initJayTraceFlutterWidgets(
      apiKey: 'k',
      endpoint: Uri.parse('https://collector.example.test/jaytrace/rum'),
      sender: (endpoint, headers, body) {},
    );
    addTearDown(client.dispose);

    await tester.pumpWidget(MaterialApp(
      home: buildJayTraceRoot(
        client: client,
        boundaryKey: boundaryKey,
        child: const Text('one-line'),
      ),
    ));

    expect(find.text('one-line'), findsOneWidget);
    expect(find.byKey(boundaryKey), findsOneWidget);
  });

  testWidgets('JayTrace.observer works without init (no-op)', (tester) async {
    JayTrace.instance = null;
    final observer = JayTrace.observer;
    await tester.pumpWidget(MaterialApp(
      navigatorObservers: [observer],
      home: const Text('obs'),
    ));
    expect(find.text('obs'), findsOneWidget);
  });

  testWidgets('captureJayTraceWireframe serializes rect/text/image nodes',
      (tester) async {
    await tester.pumpWidget(_wireframeSample());
    await tester.pump(const Duration(milliseconds: 50));

    final masked = captureJayTraceWireframe(maskText: true);

    // rect node for the button matches the visible Material box within +-1px.
    final materialRect = tester.getRect(find.descendant(
      of: find.byType(ElevatedButton),
      matching: find.byType(Material),
    ));
    final buttonNode = _firstWhereOrNull(
      masked,
      (n) =>
          n['type'] == 'rect' &&
          ((n['x'] as int) - materialRect.left).abs() <= 1 &&
          ((n['y'] as int) - materialRect.top).abs() <= 1 &&
          ((n['w'] as int) - materialRect.width).abs() <= 1 &&
          ((n['h'] as int) - materialRect.height).abs() <= 1,
    );
    expect(buttonNode, isNotNull, reason: 'button rect node with matching geometry');

    // text node: masked keeps only the char count (no original text).
    final textNode =
        _firstWhereOrNull(masked, (n) => n['type'] == 'text' && n['chars'] == 7);
    expect(textNode, isNotNull, reason: 'text node with chars==7 for "Pay now"');
    expect(textNode!.containsKey('text'), isFalse,
        reason: 'masked text node omits the original string');

    // image node present.
    expect(_firstWhereOrNull(masked, (n) => n['type'] == 'image'), isNotNull);

    // privacy allow -> original text is included.
    final unmasked = captureJayTraceWireframe(maskText: false);
    final unmaskedText = _firstWhereOrNull(
        unmasked, (n) => n['type'] == 'text' && n['text'] == 'Pay now');
    expect(unmaskedText, isNotNull, reason: 'unmasked text node carries "Pay now"');
  });

  testWidgets(
      'captureJayTraceWireframe text masking boundaries: empty, emoji, huge',
      (tester) async {
    await tester.pumpWidget(_wireframeTextBoundaries());
    await tester.pump(const Duration(milliseconds: 50));

    final masked = captureJayTraceWireframe(maskText: true);
    final textNodes = masked.where((n) => n['type'] == 'text').toList();

    final emptyNode = _firstWhereOrNull(textNodes, (n) => n['chars'] == 0);
    expect(emptyNode, isNotNull, reason: 'empty-string Text -> chars 0');
    expect(emptyNode!.containsKey('text'), isFalse,
        reason: 'empty-string Text emits no text key when masked');

    // "💳 결제" = 4 grapheme clusters (emoji, space, 결, 제).
    final emojiNode = _firstWhereOrNull(textNodes, (n) => n['chars'] == 4);
    expect(emojiNode, isNotNull, reason: 'emoji Text -> chars > 0 (grapheme count)');
    expect(emojiNode!.containsKey('text'), isFalse,
        reason: 'emoji Text raw string not present when masked');

    final hugeNode = _firstWhereOrNull(textNodes, (n) => n['chars'] == 10000);
    expect(hugeNode, isNotNull,
        reason: '10,000-char Text serializes without error with correct chars');
    expect(hugeNode!.containsKey('text'), isFalse,
        reason: '10,000-char Text raw string not present when masked');
  });

  testWidgets('wireframe engine flushes a v2 segment document via sender',
      (tester) async {
    final docs = <Map<String, Object?>>[];
    final originalOnError = FlutterError.onError;
    FlutterError.onError = (_) {};
    final client = initJayTraceFlutterWidgets(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        mode: JayTraceReplayMode.always,
        engine: 'wireframe',
        wireframeIntervalMs: 0, // event-driven only, deterministic
        maxSegmentBytes: 32, // any real frame trips a flush immediately
      ),
      sender: (endpoint, headers, body) {
        docs.add((jsonDecode(body) as Map<String, Object?>));
      },
    );
    addTearDown(() {
      client.dispose();
      FlutterError.onError = originalOnError;
    });

    await tester.pumpWidget(_wireframeSample());
    await tester.pump(const Duration(milliseconds: 50));

    // A tap trigger schedules a post-frame wireframe capture.
    client.replay!.recordTap('PayButton', x: 40, y: 250);
    await tester.pump();
    await tester.pump();

    final wireframeDoc = _firstWhereOrNull(
      docs,
      (d) => (d['document'] as Map)['engine'] == 'wireframe',
    );
    expect(wireframeDoc, isNotNull, reason: 'a wireframe segment was sent');
    final document = wireframeDoc!['document'] as Map<String, Object?>;
    expect(document['schema'], 'jaytrace.replay.v2');
    expect(document['platform'], 'flutter');
    final frames = document['wireframeFrames'] as List<dynamic>;
    expect(frames, isNotEmpty);
    final frame = frames.first as Map<String, dynamic>;
    expect(frame['atMs'], isA<int>());
    expect((frame['viewport'] as Map)['width'], isA<int>());
    final nodes = frame['nodes'] as List<dynamic>;
    expect(nodes, isNotEmpty);
    for (final node in nodes) {
      expect((node as Map)['type'], isIn(['rect', 'text', 'image']));
      expect(node['x'], isA<int>());
      expect(node['w'], isA<int>());
    }
  });

  testWidgets(
      'periodic capture idle-pauses after consecutive identical frames and '
      'resumes on a real signal', (tester) async {
    final docs = <Map<String, Object?>>[];
    int wireframeSends() => docs
        .where((d) => (d['document'] as Map)['engine'] == 'wireframe')
        .length;
    final client = initJayTraceFlutterWidgets(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        mode: JayTraceReplayMode.always,
        engine: 'wireframe',
        wireframeIntervalMs: 10, // fast tick, deterministic under fake async
        maxSegmentBytes: 32, // each distinct frame flushes immediately
      ),
      sender: (endpoint, headers, body) {
        docs.add(jsonDecode(body) as Map<String, Object?>);
      },
    );
    addTearDown(client.dispose);

    await tester.pumpWidget(_wireframeSample());
    await tester.pump(const Duration(milliseconds: 50));

    final coordinator =
        client.replay!.wireframe! as JayTraceWireframeCoordinator;
    client.lifecycleObserver
        .didChangeAppLifecycleState(AppLifecycleState.resumed);
    expect(coordinator.isRunning, isTrue,
        reason: 'periodic timer starts on AppLifecycleState.resumed');

    // Static screen: every tick after the first produces an identical
    // frame. Pump well past the idle threshold (6 consecutive identical
    // captures at a 10ms interval) — the timer should stop itself.
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 10));
    }
    expect(coordinator.isRunning, isFalse,
        reason:
            'periodic timer auto-pauses once the screen has been idle long enough');

    // Pump further while still idle: the timer stays paused (no self-restart).
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 10));
    }
    expect(coordinator.isRunning, isFalse,
        reason: 'idle timer stays paused until a real signal');

    // A real signal (tap) resumes periodic capture.
    client.replay!.recordTap('PayButton', x: 40, y: 250);
    expect(coordinator.isRunning, isTrue,
        reason: 'a tap restarts the idle-paused periodic timer');
    await tester.pump();
    expect(wireframeSends(), greaterThan(0),
        reason: 'wireframe capture produced at least one segment');

    // The tap left the periodic timer running; cancel it before the test ends
    // so fake_async's end-of-test "!timersPending" invariant is satisfied.
    client.dispose();
  });

  testWidgets(
      'replay.frame.dropped is scoped to the segment it occurred in',
      (tester) async {
    final docs = <Map<String, Object?>>[];
    final client = initJayTraceFlutterWidgets(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        mode: JayTraceReplayMode.always,
        engine: 'wireframe',
        wireframeIntervalMs: 0, // event-driven only, deterministic
        privacy: JayTraceReplayPrivacy.allow, // unmask text: byte size matters
        maxSegmentBytes: 10, // any real frame trips a flush immediately
      ),
      sender: (endpoint, headers, body) {
        docs.add(jsonDecode(body) as Map<String, Object?>);
      },
    );
    addTearDown(client.dispose);

    // Frame 1: ~1500 on-screen rect nodes — its JSON exceeds the 32KB
    // per-frame cap, so it's dropped before it ever reaches a segment.
    await tester.pumpWidget(_wireframeManyNodes());
    await tester.pump(const Duration(milliseconds: 50));
    client.replay!.recordTap('Grid', x: 1, y: 1);
    await tester.pump();
    await tester.pump();
    expect(docs, isEmpty,
        reason: 'the oversized frame is dropped, no segment sent yet');

    // Frame 2: small content. This is the frame that actually fills and
    // flushes segment 0. Pre-fix, the sticky flag would mark this segment
    // (and every later one) as dropped even though none of ITS frames were.
    await tester.pumpWidget(_wireframeSample());
    await tester.pump(const Duration(milliseconds: 50));
    client.replay!.recordTap('PayButton', x: 40, y: 250);
    await tester.pump();
    await tester.pump();

    // Frame 3: different small content -> a fresh segment, no drop at all.
    await tester.pumpWidget(_wireframeSample(label: 'Continue'));
    await tester.pump(const Duration(milliseconds: 50));
    client.replay!.recordTap('ContinueButton', x: 40, y: 250);
    await tester.pump();
    await tester.pump();

    final wireframeDocs = docs
        .map((d) => d['document'] as Map<String, Object?>)
        .where((d) => d['engine'] == 'wireframe')
        .toList();
    expect(wireframeDocs.length, greaterThanOrEqualTo(2),
        reason: 'at least two small-content segments were sent');

    bool hasDropFlag(Map<String, Object?> doc) =>
        (doc['metadata'] as Map<String, Object?>?)
            ?.containsKey('replay.frame.dropped') ==
        true;

    // The drop is recorded on some segment (the one flushed after the oversized
    // frame)...
    expect(wireframeDocs.any(hasDropFlag), isTrue,
        reason: 'the dropped oversized frame surfaced the flag on a segment');
    // ...but a later clean segment exists without it — proving the flag resets
    // per-send instead of sticking for the rest of the session (Task-4 FIX 3).
    // Index-independent, so it does not depend on exact multi-segment flush
    // ordering under fake_async.
    expect(wireframeDocs.any((d) => !hasDropFlag(d)), isTrue,
        reason: 'a later clean segment proves the drop flag is not sticky');
  });

  testWidgets(
      'wireframe engine never invokes the screenshot provider and sends no v1 '
      'image document (only v2 wireframe segments)', (tester) async {
    final docs = <Map<String, Object?>>[];
    var screenshotCalls = 0;
    final originalOnError = FlutterError.onError;
    FlutterError.onError = (_) {};
    final client = initJayTraceFlutterWidgets(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        mode: JayTraceReplayMode.always,
        engine: 'wireframe',
        wireframeIntervalMs: 0, // event-driven only, deterministic
        maxSegmentBytes: 32, // any real frame trips a flush immediately
      ),
      // Explicitly attach a spy provider: under the wireframe engine it must
      // NEVER be invoked (privacy-safe, no pixels captured or uploaded).
      screenshot: () async {
        screenshotCalls++;
        return JayTraceScreenshotFrame(
          image: 'data:image/png;base64,${base64Encode(_tinyPng)}',
          width: 1,
          height: 1,
        );
      },
      sender: (endpoint, headers, body) {
        docs.add(jsonDecode(body) as Map<String, Object?>);
      },
    );
    addTearDown(() {
      client.dispose();
      FlutterError.onError = originalOnError;
    });

    await tester.pumpWidget(_wireframeSample());
    await tester.pump(const Duration(milliseconds: 50));

    // Drive route / tap / error — every v1 screenshot trigger.
    client.replay!.recordRoute('/checkout');
    client.replay!.recordTap('PayButton', x: 40, y: 250);
    await tester.pump();
    await tester.pump();
    await tester.runAsync(() async {
      await client.replay!.recordError(StateError('boom'));
    });
    await tester.pump();

    expect(screenshotCalls, 0,
        reason: 'wireframe engine must never invoke the screenshot provider');

    // No base64 screenshot / image frame leaked into ANY sent document — the v1
    // replay-flutter image path stays inert under wireframe.
    expect(jsonEncode(docs), isNot(contains('"type":"image"')),
        reason: 'no v1 image frame sent under wireframe');
    expect(jsonEncode(docs), isNot(contains('base64,iVBOR')),
        reason: 'no raw base64 PNG payload uploaded under wireframe');

    // ...but v2 wireframe segments ARE still sent.
    expect(
      docs.any((d) => (d['document'] as Map)['engine'] == 'wireframe'),
      isTrue,
      reason: 'wireframe v2 segments are still produced',
    );
  });

  testWidgets(
      'screenshot engine invokes the screenshot provider and sends v1 image '
      'documents (wireframe inert)', (tester) async {
    final docs = <Map<String, Object?>>[];
    var screenshotCalls = 0;
    final originalOnError = FlutterError.onError;
    FlutterError.onError = (_) {};
    final client = initJayTraceFlutterWidgets(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        mode: JayTraceReplayMode.always,
        engine: 'screenshot',
      ),
      screenshot: () async {
        screenshotCalls++;
        return JayTraceScreenshotFrame(
          image: 'data:image/png;base64,${base64Encode(_tinyPng)}',
          width: 1,
          height: 1,
        );
      },
      sender: (endpoint, headers, body) {
        docs.add(jsonDecode(body) as Map<String, Object?>);
      },
    );
    addTearDown(() {
      client.dispose();
      FlutterError.onError = originalOnError;
    });

    await tester.pumpWidget(_wireframeSample());
    await tester.pump(const Duration(milliseconds: 50));

    await tester.runAsync(() async {
      client.replay!.recordTap('PayButton', x: 40, y: 250);
      await client.replay!.recordError(StateError('boom'));
    });
    await tester.pump();

    expect(screenshotCalls, greaterThan(0),
        reason: 'screenshot engine invokes the provider');
    expect(client.replay!.wireframe, isNull,
        reason: 'wireframe coordinator is inert under the screenshot engine');

    final imageDoc = _firstWhereOrNull(
      docs.map((d) => d['document'] as Map<String, Object?>).toList(),
      (d) => d['schema'] == 'jaytrace.replay.v1' && d.containsKey('frames'),
    );
    expect(imageDoc, isNotNull,
        reason: 'a v1 document with image frames was sent');
    expect(jsonEncode(imageDoc), contains('"type":"image"'));
  });

  // NOTE: the "screenshot engine + throwing provider/sender" isolation case is
  // covered by the pure-Dart hostile block in test/self_check.dart — a widget
  // variant deadlocks flutter_test teardown (fake-async futures awaited under
  // runAsync), so it lives there instead.

  testWidgets(
      'wireframe engine survives an adversarial tree and a throwing sender',
      (tester) async {
    final originalOnError = FlutterError.onError;
    final flutterErrors = <FlutterErrorDetails>[];
    FlutterError.onError = flutterErrors.add;
    final client = initJayTraceFlutterWidgets(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        mode: JayTraceReplayMode.always,
        engine: 'wireframe',
        wireframeIntervalMs: 0, // event-driven, no periodic timer
        privacy: JayTraceReplayPrivacy.allow,
        maxSegmentBytes: 10, // any real frame flushes immediately -> sender
      ),
      sender: (endpoint, headers, body) => throw StateError('sender boom'),
    );
    addTearDown(() {
      client.dispose();
      FlutterError.onError = originalOnError;
    });

    // Adversarial oversized tree: its frame JSON blows the 32KB per-frame cap,
    // so the walker/segmenter must drop it without crashing.
    await tester.pumpWidget(_wireframeManyNodes());
    await tester.pump(const Duration(milliseconds: 50));
    client.replay!.recordTap('Grid', x: 1, y: 1);
    await tester.pump();
    await tester.pump();

    // Small tree: this frame actually flushes a segment, so the throwing sender
    // is exercised on the wireframe send path and must be swallowed.
    await tester.pumpWidget(_wireframeSample());
    await tester.pump(const Duration(milliseconds: 50));
    client.replay!.recordRoute('/checkout');
    client.replay!.recordTap('PayButton', x: 40, y: 250);
    await tester.pump();
    await tester.pump();
    await tester.runAsync(() async {
      await client.replay!.recordError(StateError('boom'));
    });
    await tester.pump();

    expect(find.byType(MaterialApp), findsOneWidget,
        reason: 'app tree still renders after adversarial captures');
    expect(flutterErrors, isEmpty,
        reason: 'wireframe capture/send throws never escaped the SDK');
  });

  testWidgets(
      'installed FlutterError/PlatformDispatcher handlers still forward to the '
      'prior handler when the replay send fails', (tester) async {
    final originalOnError = FlutterError.onError;
    final originalPlatformOnError = ui.PlatformDispatcher.instance.onError;

    // Sentinel prior handlers installed before JayTrace.
    FlutterErrorDetails? sentinelDetails;
    var platformSentinelCalled = false;
    FlutterError.onError = (details) => sentinelDetails = details;
    ui.PlatformDispatcher.instance.onError = (error, stack) {
      platformSentinelCalled = true;
      return true;
    };

    final replay = JayTraceFlutterReplay.init(
      JayTraceFlutterOptions(
        apiKey: 'flutter-key',
        endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
        traceId: 'cccccccccccccccccccccccccccccccc',
        replay: const JayTraceFlutterReplayOptions(enabled: true),
        // recordError bookkeeping around the forward will hit this and throw.
        sender: (endpoint, headers, body) => throw StateError('sender boom'),
      ),
    );
    final handlers = installJayTraceFlutterErrorHandler(replay);

    FlutterError.onError!(
      FlutterErrorDetails(exception: StateError('framework crash')),
    );
    ui.PlatformDispatcher.instance.onError!(
      StateError('platform crash'),
      StackTrace.current,
    );
    await tester.runAsync(() async {
      await Future<void>.delayed(Duration.zero);
    });

    handlers.uninstall();
    FlutterError.onError = originalOnError;
    ui.PlatformDispatcher.instance.onError = originalPlatformOnError;

    expect(sentinelDetails, isNotNull,
        reason: 'prior FlutterError.onError still received the details');
    expect(sentinelDetails!.exception.toString(), contains('framework crash'));
    expect(platformSentinelCalled, isTrue,
        reason: 'prior PlatformDispatcher.onError still invoked');
    replay!.dispose();
  });

  testWidgets(
      'segment drain resets the dedup hash so a static screen keeps its next '
      "segment's first frame", (tester) async {
    final docs = <Map<String, Object?>>[];
    int wireframeSegments() => docs
        .where((d) => (d['document'] as Map)['engine'] == 'wireframe')
        .length;
    final originalOnError = FlutterError.onError;
    FlutterError.onError = (_) {};
    final client = initJayTraceFlutterWidgets(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        mode: JayTraceReplayMode.always,
        engine: 'wireframe',
        wireframeIntervalMs: 0, // event-driven only, deterministic
        maxSegmentBytes: 32, // any real frame flushes its segment immediately
      ),
      sender: (endpoint, headers, body) {
        docs.add(jsonDecode(body) as Map<String, Object?>);
      },
    );
    addTearDown(() {
      client.dispose();
      FlutterError.onError = originalOnError;
    });

    await tester.pumpWidget(_wireframeSample());
    await tester.pump(const Duration(milliseconds: 50));

    // Static screen: two taps at the same point produce byte-identical node
    // sets (dedup hashes nodes only, not the pointer). The first tap flushes a
    // segment; without the post-drain hash reset the second identical frame is
    // deduped and its segment would be lost.
    client.replay!.recordTap('PayButton', x: 40, y: 250);
    await tester.pump();
    await tester.pump();
    final afterFirst = wireframeSegments();
    expect(afterFirst, greaterThan(0), reason: 'first tap flushed a segment');

    client.replay!.recordTap('PayButton', x: 40, y: 250);
    await tester.pump();
    await tester.pump();
    expect(wireframeSegments(), greaterThan(afterFirst),
        reason:
            'after drain the dedup hash resets, so the identical next frame is '
            'still captured into a fresh segment');
  });

  testWidgets('tap target auto-derives from the wrapped widget when unset',
      (tester) async {
    // Pure derivation priority: ValueKey value > Semantics label > runtimeType.
    expect(jayTraceDeriveTapTarget(const SizedBox(key: ValueKey('SaveBtn'))),
        'SaveBtn');
    expect(
        jayTraceDeriveTapTarget(
            Semantics(label: 'Checkout', child: const SizedBox())),
        'Checkout');
    expect(jayTraceDeriveTapTarget(const Placeholder()), 'Placeholder');

    final calls = <String>[];
    final replay = JayTraceFlutterReplay.init(
      JayTraceFlutterOptions(
        apiKey: 'flutter-key',
        endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
        traceId: 'dddddddddddddddddddddddddddddddd',
        replay: const JayTraceFlutterReplayOptions(
          enabled: true,
          // keep the derived label visible instead of masked to "redacted"
          privacy: JayTraceReplayPrivacy.allow,
        ),
        sender: (endpoint, headers, body) => calls.add(body),
      ),
    );
    addTearDown(() => replay?.dispose());

    await tester.pumpWidget(
      Directionality(
        textDirection: TextDirection.ltr,
        child: Center(
          child: JayTraceReplayTap(
            replay: replay,
            // target omitted -> derived from the keyed child below
            child: const SizedBox(
              key: ValueKey('DerivedButton'),
              width: 100,
              height: 40,
            ),
          ),
        ),
      ),
    );
    // The bare SizedBox does not absorb pointers itself (the translucent
    // GestureDetector does the hit-testing), so silence the miss warning.
    await tester.tap(find.byType(SizedBox), warnIfMissed: false);
    await tester.pump();
    expect(replay!.snapshot()['events'].toString(),
        contains('tap DerivedButton'),
        reason: 'an unset tap target is auto-derived from the ValueKey child');
  });

  testWidgets('JayTraceViewDetector records a view once on 50% exposure',
      (tester) async {
    FlutterError.onError = (details) {};
    final calls = <String>[];
    final client = initJayTraceFlutterWidgets(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        // keep the derived/explicit name visible instead of masked.
        privacy: JayTraceReplayPrivacy.allow,
      ),
      sender: (endpoint, headers, body) => calls.add(body),
    );
    JayTrace.instance = client;
    addTearDown(() {
      client.dispose();
      JayTrace.instance = null;
    });

    final controller = ScrollController();
    addTearDown(controller.dispose);

    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: ListView(
          controller: controller,
          children: const [
            SizedBox(height: 1000),
            JayTraceViewDetector(
              name: 'Promo',
              child: SizedBox(height: 200, width: 200, child: Text('promo')),
            ),
            SizedBox(height: 1000),
          ],
        ),
      ),
    ));
    await tester.pump();

    // Below the 600px viewport at first: nothing recorded.
    expect(client.replay!.snapshot()['events'].toString(),
        isNot(contains('view Promo')));

    // Scroll the detector into view -> a single view event fires.
    controller.jumpTo(1000);
    await tester.pump();
    await tester.pump();
    expect(client.replay!.snapshot()['events'].toString(),
        contains('view Promo'));

    // Scrolling around it again must not re-record (once per session).
    controller.jumpTo(1100);
    await tester.pump();
    controller.jumpTo(1000);
    await tester.pump();
    final promoCount = (client.replay!.snapshot()['events'] as List)
        .where((line) => line.toString().contains('view Promo'))
        .length;
    expect(promoCount, 1);

    // The exposure also reached the console timeline document.
    await client.replay!.flushTimeline('manual');
    final timeline = calls
        .map((body) => (jsonDecode(body) as Map<String, dynamic>)['document']
            as Map<String, dynamic>)
        .firstWhere((doc) => doc['schema'] == 'jaytrace.timeline.v1');
    final timelineViews = (timeline['events'] as List)
        .cast<Map<String, dynamic>>()
        .where((event) => event['kind'] == 'view')
        .toList();
    expect(timelineViews.length, 1);
    expect(timelineViews.single['text'], 'Promo');
  });

  testWidgets('JayTraceViewDetector derives its name from the child',
      (tester) async {
    FlutterError.onError = (details) {};
    final client = initJayTraceFlutterWidgets(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        privacy: JayTraceReplayPrivacy.allow,
      ),
      sender: (endpoint, headers, body) {},
    );
    JayTrace.instance = client;
    addTearDown(() {
      client.dispose();
      JayTrace.instance = null;
    });

    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: Center(
          child: JayTraceViewDetector(
            // name omitted -> derived from the keyed child.
            child: SizedBox(
              key: ValueKey('HeroCard'),
              height: 100,
              width: 100,
              child: Text('hero'),
            ),
          ),
        ),
      ),
    ));
    await tester.pump();
    await tester.pump();
    expect(client.replay!.snapshot()['events'].toString(),
        contains('view HeroCard'));
  });
}
