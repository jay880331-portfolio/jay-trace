import 'dart:convert';

import 'package:jaytrace_flutter/jaytrace_flutter.dart';
import 'package:jaytrace_flutter/jaytrace_flutter_sender.dart';
import 'package:jaytrace_flutter/jaytrace_flutter_segmenter.dart';

Future<void> main() async {
  final calls = <String>[];
  var now = DateTime.utc(2026, 7, 1, 12);
  var screenshotCalls = 0;

  final replay = JayTraceFlutterReplay.init(
    JayTraceFlutterOptions(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      sessionId: 'flutter-session-1',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      release: '1.2.3',
      environment: 'qa',
      metadata: const {
        'appVersion': '1.2.3',
        'os': 'ios',
        'ignored': <String>[]
      },
      now: () => now,
      replay:
          const JayTraceFlutterReplayOptions(enabled: true, engine: 'screenshot'),
      screenshot: () async {
        screenshotCalls += 1;
        if (screenshotCalls <= 2) {
          await Future<void>.delayed(const Duration(milliseconds: 30));
        }
        return const JayTraceScreenshotFrame(
          image: 'data:image/png;base64,Zmx1dHRlcg==',
          width: 390,
          height: 844,
        );
      },
      sender: (endpoint, headers, body) {
        calls.add(body);
      },
    ),
  );

  _assert(replay != null, 'replay created');
  _assert(
    JayTraceFlutterReplay.init(
          JayTraceFlutterOptions(
            apiKey: 'flutter-key',
            endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
            traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
            replay: const JayTraceFlutterReplayOptions(
                enabled: true, sampleRate: 0),
            sender: (endpoint, headers, body) {},
          ),
        ) ==
        null,
    'sampleRate 0 disables replay',
  );
  replay!.recordRoute('/checkout');
  replay.setUser({'id': 'flutter-user-1', 'token': 'secret'});
  now = now.add(const Duration(milliseconds: 100));
  replay.recordTap('PayButton', x: 11, y: 22);
  now = now.add(const Duration(milliseconds: 100));
  replay.recordAction('CheckoutStarted', detail: 'token secret');
  replay.recordInput('EmailInput');
  replay.recordPerformance('RasterBlocked', const Duration(milliseconds: 123),
      detail: 'token secret');
  now = now.add(const Duration(milliseconds: 100));
  await replay.recordNetwork(
    JayTraceNetworkEvent(
      method: 'post',
      url: Uri.parse('https://api.example.test/pay?token=secret'),
      status: 200,
      duration: const Duration(milliseconds: 42),
    ),
  );
  now = now.add(const Duration(milliseconds: 100));
  await replay.recordError(
    Exception('payment failed'),
    stackTrace: StackTrace.fromString('#0 pay (checkout.dart:12:3)'),
  );

  _assert(_replayBodies(calls).length == 1, 'flush on error');
  _assert(_timelineBodies(calls).length == 1, 'timeline flush on error');
  final payload = jsonDecode(_replayBodies(calls).single) as Map<String, dynamic>;
  _assert(payload['apiKey'] == 'flutter-key', 'apiKey is not redacted');
  final document = payload['document'] as Map<String, dynamic>;
  _assert(document['schema'] == 'jaytrace.replay.v1', 'schema');
  _assert(document['platform'] == 'flutter', 'platform');
  _assert(document['sessionId'] == 'flutter-session-1', 'session id');
  final metadata = document['metadata'] as Map<String, dynamic>;
  _assert(metadata['release'] == '1.2.3', 'release metadata');
  _assert(metadata['environment'] == 'qa', 'environment metadata');
  _assert(metadata['appVersion'] == '1.2.3', 'metadata');
  _assert(metadata['replay.screenshot'] == 'enabled', 'screenshot metadata');
  _assert(metadata['view.name'] == 'redacted', 'view metadata');
  _assert(metadata['user.id'] == 'flutter-user-1', 'user metadata');
  _assert(metadata['user.token'] == 'redacted', 'user token redacted');
  _assert(!metadata.containsKey('ignored'), 'metadata filters complex values');
  final frames = document['frames'] as List<dynamic>;
  _assert(
      (frames.first as Map<String, dynamic>)['type'] == 'image', 'image frame');
  _assert(frames.length >= 3, 'captures action frames');
  _assert(jsonEncode(frames).contains('tap redacted x=11 y=22'),
      'tap frame captured');
  _assert(
      frames.any((frame) =>
          frame['text'].toString().contains('x=11 y=22') &&
          frame['x'] == 11 &&
          frame['y'] == 22),
      'tap point frame captured');
  _assert(jsonEncode(document).contains('action redacted redacted'),
      'custom action captured');
  _assert(jsonEncode(document).contains('input redacted value=redacted'),
      'input captured without value');
  _assert(
      jsonEncode(document)
          .contains('performance redacted durationMs=123 redacted'),
      'performance captured');
  _assert(!jsonEncode(document).contains('secret@example.test'),
      'input value not captured');
  _assert(
      jsonEncode(document).contains('POST redacted status=200 durationMs=42'),
      'network captured');
  _assert(!jsonEncode(document).contains('token=secret'), 'network url masked');
  _assert(jsonEncode(document).contains('payment failed'), 'error captured');
  _assert(
      jsonEncode(document).contains('checkout.dart'), 'error stack captured');

  // --- Timeline document (jaytrace.timeline.v1) parity assertions ---
  final timeline =
      jsonDecode(_timelineBodies(calls).single) as Map<String, dynamic>;
  final timelineDoc = timeline['document'] as Map<String, dynamic>;
  _assert(timeline['apiKey'] == 'flutter-key', 'timeline apiKey not redacted');
  _assert(timelineDoc['schema'] == 'jaytrace.timeline.v1', 'timeline schema');
  _assert(timelineDoc['side'] == 'front', 'timeline side front');
  _assert(timelineDoc['service'] == 'flutter', 'timeline service');
  _assert(
      (timelineDoc['traceId'] as String).length == 32 &&
          RegExp(r'^[0-9a-f]{32}$').hasMatch(timelineDoc['traceId'] as String),
      'timeline traceId is 32 lowercase hex');
  _assert(timelineDoc['sessionId'] == 'flutter-session-1', 'timeline sessionId');
  _assert(
      DateTime.tryParse(timelineDoc['startedAt'] as String) != null &&
          DateTime.tryParse(timelineDoc['endedAt'] as String) != null,
      'timeline startedAt/endedAt are ISO');
  final timelineLines = (timelineDoc['timeline'] as List<dynamic>);
  _assert(timelineLines.every((line) => line is String),
      'timeline field is a string array');
  _assert(
      timelineLines.any((line) =>
          RegExp(r'^\d+\.\d{3}s (navigation|click|fetch|error|view) ')
              .hasMatch(line as String)),
      'timeline lines are "<at> <kind> <severity> <text>"');
  final timelineEvents = (timelineDoc['events'] as List<dynamic>)
      .cast<Map<String, dynamic>>();
  _assert(timelineEvents.any((e) => e['kind'] == 'navigation'),
      'timeline records navigation');
  _assert(
      timelineEvents.any((e) =>
          e['kind'] == 'click' &&
          (e['text'] as String).contains('x=11 y=22')),
      'timeline records click with point');
  _assert(
      timelineEvents.any((e) =>
          e['kind'] == 'fetch' &&
          (e['text'] as String).contains('status=200') &&
          e['durationMs'] == 42),
      'timeline records fetch with durationMs');
  _assert(
      timelineEvents.any(
          (e) => e['kind'] == 'error' && e['severity'] == 'error'),
      'timeline records error with error severity');
  final timelineUser = timelineDoc['user'] as Map<String, dynamic>;
  _assert(timelineUser['id'] == 'flutter-user-1', 'timeline user id');
  _assert(timelineUser['token'] == 'redacted', 'timeline user token redacted');

  // --- Sessionization: Datadog-style 15m idle / 4h max rotation ---
  // Placed here (not at the end of main) because a pre-existing hang in
  // runJayTraceGuarded truncates the self-check further down; see the report.
  {
    // Fake clock far in the future so the first touch always rotates past any
    // real-clock session seeded earlier in this run.
    final base = DateTime.utc(2030, 1, 1).millisecondsSinceEpoch;
    final s0 = jayTraceTouchSession(nowMs: () => base);
    final within = jayTraceTouchSession(nowMs: () => base + 14 * 60 * 1000);
    _assert(within == s0, 'session id stable within the 15m idle window');
    final afterIdle = jayTraceTouchSession(
        nowMs: () => base + 14 * 60 * 1000 + 16 * 60 * 1000);
    _assert(afterIdle != within, 'idle past 15m rotates the session id');

    // 4h hard cap: keep activity alive (<15m gaps) but cross 4h total elapsed.
    final capBase = DateTime.utc(2031, 1, 1).millisecondsSinceEpoch;
    final capStart = jayTraceTouchSession(nowMs: () => capBase);
    var capId = capStart;
    for (var m = 10; m <= 250; m += 10) {
      capId = jayTraceTouchSession(nowMs: () => capBase + m * 60 * 1000);
    }
    _assert(capId != capStart,
        'continuous activity past the 4h cap still rotates the session id');

    // headers() surfaces the active session id under the agreed header name.
    final sessionClient = initJayTraceFlutter(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      sender: (endpoint, headers, body) {},
    );
    final sessionHeaders = sessionClient.headers();
    _assert(
        sessionHeaders['x-jaytrace-session'] != null &&
            sessionHeaders['x-jaytrace-session']!.length == 32,
        'headers() include x-jaytrace-session');
    sessionClient.dispose();
  }

  final missingScreenshotCalls = <String>[];
  final missingScreenshotReplay = JayTraceFlutterReplay.init(
    JayTraceFlutterOptions(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceId: 'missing-screenshot-trace',
      replay: const JayTraceFlutterReplayOptions(enabled: true),
      sender: (endpoint, headers, body) {
        missingScreenshotCalls.add(body);
      },
    ),
  );
  await missingScreenshotReplay?.recordError(
    Exception('missing screenshot provider'),
  );
  final missingScreenshotDocument =
      jsonDecode(_replayBodies(missingScreenshotCalls).single)
          as Map<String, dynamic>;
  _assert(
      ((missingScreenshotDocument['document'] as Map<String, dynamic>)['metadata']
              as Map<String, dynamic>)['replay.screenshot'] ==
          'missing',
      'missing screenshot metadata');

  final networkCalls = <String>[];
  final networkReplay = JayTraceFlutterReplay.init(
    JayTraceFlutterOptions(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceId: 'network-trace',
      replay:
          const JayTraceFlutterReplayOptions(enabled: true, engine: 'screenshot'),
      screenshot: () => const JayTraceScreenshotFrame(
        image: 'data:image/png;base64,bmV0d29yaw==',
        width: 390,
        height: 844,
      ),
      sender: (endpoint, headers, body) {
        networkCalls.add(body);
      },
    ),
  );
  await networkReplay?.recordNetwork(
    JayTraceNetworkEvent(
      method: 'get',
      url: Uri.parse('https://api.example.test/fail'),
      status: 503,
      duration: const Duration(milliseconds: 7),
    ),
  );
  _assert(_replayBodies(networkCalls).length == 1, 'network failure flushes');
  _assert(_timelineBodies(networkCalls).length == 1,
      'network failure flushes timeline');
  _assert(
      ((jsonDecode(_replayBodies(networkCalls).single)
                  as Map<String, dynamic>)['document']
              as Map<String, dynamic>)['frames']
          .any((frame) =>
              frame['kind'] == 'network' && frame['type'] == 'image'),
      'network failure includes screenshot frame');

  final failingScreenshotCalls = <String>[];
  final failingScreenshotReplay = JayTraceFlutterReplay.init(
    JayTraceFlutterOptions(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceId: 'failing-screenshot-trace',
      replay:
          const JayTraceFlutterReplayOptions(enabled: true, engine: 'screenshot'),
      screenshot: () {
        throw StateError('capture failed');
      },
      sender: (endpoint, headers, body) {
        failingScreenshotCalls.add(body);
      },
    ),
  );
  await failingScreenshotReplay
      ?.recordError(Exception('crash despite screenshot failure'));
  _assert(_replayBodies(failingScreenshotCalls).length == 1,
      'screenshot failure does not block flutter flush');
  _assert(
      _replayBodies(failingScreenshotCalls)
          .single
          .contains('crash despite screenshot failure'),
      'flutter error kept without screenshot');

  final failingSenderReplay = JayTraceFlutterReplay.init(
    JayTraceFlutterOptions(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceId: 'failing-sender-trace',
      replay: const JayTraceFlutterReplayOptions(enabled: true),
      sender: (endpoint, headers, body) {
        throw StateError('collector down');
      },
    ),
  );
  await failingSenderReplay?.recordError(Exception('app crash'));
  _assert(
      (failingSenderReplay?.snapshot()['events'] as List<dynamic>)
          .any((line) => line.toString().contains('app crash')),
      'flutter sender failure does not drop replay event');

  final invalidScreenshotCalls = <String>[];
  final invalidScreenshotReplay = JayTraceFlutterReplay.init(
    JayTraceFlutterOptions(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceId: 'invalid-screenshot-trace',
      replay:
          const JayTraceFlutterReplayOptions(enabled: true, engine: 'screenshot'),
      screenshot: () => const JayTraceScreenshotFrame(
        image: 'data:text/plain;base64,Zm9v',
      ),
      sender: (endpoint, headers, body) {
        invalidScreenshotCalls.add(body);
      },
    ),
  );
  await invalidScreenshotReplay?.recordError(Exception('invalid screenshot'));
  final invalidScreenshotDocument =
      (jsonDecode(_replayBodies(invalidScreenshotCalls).single)
          as Map<String, dynamic>)['document'] as Map<String, dynamic>;
  _assert(!invalidScreenshotDocument.containsKey('frames'),
      'non-image screenshot skipped');
  _assert(jsonEncode(invalidScreenshotDocument).contains('invalid screenshot'),
      'error kept when screenshot skipped');

  final oversizedScreenshotCalls = <String>[];
  final oversizedScreenshotReplay = JayTraceFlutterReplay.init(
    JayTraceFlutterOptions(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceId: 'oversized-screenshot-trace',
      replay:
          const JayTraceFlutterReplayOptions(enabled: true, engine: 'screenshot'),
      screenshot: () => JayTraceScreenshotFrame(
        image: 'data:image/png;base64,${'a' * 500000}',
      ),
      sender: (endpoint, headers, body) {
        oversizedScreenshotCalls.add(body);
      },
    ),
  );
  await oversizedScreenshotReplay
      ?.recordError(Exception('oversized screenshot'));
  _assert(
      !((jsonDecode(_replayBodies(oversizedScreenshotCalls).single)
                  as Map<String, dynamic>)['document'] as Map<String, dynamic>)
          .containsKey('frames'),
      'oversized screenshot skipped');

  final wrappedCalls = <String>[];
  var wrappedNow = DateTime.utc(2026, 7, 1, 12);
  final wrappedReplay = JayTraceFlutterReplay.init(
    JayTraceFlutterOptions(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceId: 'wrapped-trace',
      now: () => wrappedNow,
      replay: const JayTraceFlutterReplayOptions(enabled: true),
      sender: (endpoint, headers, body) {
        wrappedCalls.add(body);
      },
    ),
  );
  final result = await wrappedReplay?.traceNetwork<int>(
    method: 'post',
    url: Uri.parse('https://api.example.test/wrapped?token=secret'),
    run: () async {
      wrappedNow = wrappedNow.add(const Duration(milliseconds: 12));
      return 201;
    },
    status: (statusCode) => statusCode,
  );
  _assert(result == 201, 'wrapped network returns result');
  await Future<void>.delayed(Duration.zero);
  await wrappedReplay?.flush('manual');
  _assert(wrappedCalls.length == 1, 'wrapped network captured on manual flush');
  _assert((wrappedReplay?.snapshot()['events'] as List<dynamic>).isEmpty,
      'successful manual flush clears flutter replay buffer');
  _assert(
      (jsonDecode(wrappedCalls.single) as Map<String, dynamic>)['apiKey'] ==
          'flutter-key',
      'wrapped apiKey is not redacted');
  _assert(
      wrappedCalls.single.contains('POST redacted status=201 durationMs=12'),
      'wrapped network line');

  final timerCalls = <String>[];
  final timerReplay = JayTraceFlutterReplay.init(
    JayTraceFlutterOptions(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceId: 'timer-trace',
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        flushInterval: Duration(milliseconds: 1),
      ),
      sender: (endpoint, headers, body) {
        timerCalls.add(body);
      },
    ),
  );
  timerReplay?.recordAction('TimerBatch');
  await Future<void>.delayed(const Duration(milliseconds: 10));
  timerReplay?.dispose();
  _assert(timerCalls.length == 1, 'timer batch flushes flutter replay');

  final wrappedFailureCalls = <String>[];
  final wrappedFailureReplay = JayTraceFlutterReplay.init(
    JayTraceFlutterOptions(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceId: 'wrapped-failure-trace',
      replay: const JayTraceFlutterReplayOptions(enabled: true),
      sender: (endpoint, headers, body) {
        wrappedFailureCalls.add(body);
      },
    ),
  );
  try {
    await wrappedFailureReplay?.traceNetwork<void>(
      method: 'get',
      url: Uri.parse('https://api.example.test/wrapped-fail'),
      run: () async {
        throw StateError('wrapped failure');
      },
    );
    throw StateError('expected wrapped network failure');
  } catch (error) {
    _assert(error.toString().contains('wrapped failure'),
        'wrapped network rethrows');
  }
  await Future<void>.delayed(Duration.zero);
  _assert(_replayBodies(wrappedFailureCalls).length == 1,
      'wrapped network failure flushes');

  final slowNetworkCalls = <String>[];
  final slowNetworkReplay = JayTraceFlutterReplay.init(
    JayTraceFlutterOptions(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceId: 'slow-network-trace',
      replay: const JayTraceFlutterReplayOptions(enabled: true),
      sender: (endpoint, headers, body) async {
        await Future<void>.delayed(const Duration(milliseconds: 50));
        slowNetworkCalls.add(body);
      },
    ),
  );
  final slowStartedAt = DateTime.now();
  final slowStatus = await slowNetworkReplay?.traceNetwork<int>(
    method: 'post',
    url: Uri.parse('https://api.example.test/slow'),
    run: () async => 503,
    status: (statusCode) => statusCode,
  );
  _assert(slowStatus == 503, 'slow network returns result');
  _assert(DateTime.now().difference(slowStartedAt).inMilliseconds < 45,
      'traceNetwork response does not wait for replay flush');
  await Future<void>.delayed(const Duration(milliseconds: 70));
  _assert(_replayBodies(slowNetworkCalls).length == 1,
      'slow network eventually flushes');

  final autoCalls = <String>[];
  var autoErrorCalled = false;
  final autoReplay = JayTraceFlutterReplay.init(
    JayTraceFlutterOptions(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceId: 'auto-trace',
      replay: const JayTraceFlutterReplayOptions(enabled: true),
      sender: (endpoint, headers, body) {
        autoCalls.add(body);
      },
    ),
  );
  await runJayTraceGuarded<void>(
    autoReplay,
    () {
      throw StateError('auto crash');
    },
    onError: (error, stackTrace) {
      autoErrorCalled = true;
    },
  );
  await Future<void>.delayed(Duration.zero);
  _assert(
      _replayBodies(autoCalls).length == 1, 'guarded error flushes replay');
  _assert(autoErrorCalled, 'guarded onError called');

  final oneLineCalls = <String>[];
  final oneLine = initJayTraceFlutter(
    apiKey: 'flutter-key',
    endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
    release: '2.0.0',
    environment: 'qa',
    sender: (endpoint, headers, body) {
      oneLineCalls.add(body);
    },
  );
  _assert(oneLine.traceparent.startsWith('00-'), 'one-line traceparent');
  _assert(oneLine.traceId.length == 32, 'one-line trace id');
  _assert(oneLine.sessionId.length == 32 && oneLine.sessionId != oneLine.traceId,
      'one-line session id');
  final headers = oneLine.headers({'accept': 'application/json'});
  // headers() emits a child span: same traceId + flags, a fresh spanId.
  final parentParts = oneLine.traceparent.split('-');
  final childParts = headers['traceparent']!.split('-');
  _assert(headers['traceparent'] != oneLine.traceparent,
      'one-line headers emit a child traceparent (not the parent)');
  _assert(childParts[1] == parentParts[1],
      'one-line child traceparent keeps the traceId');
  _assert(childParts[3] == parentParts[3],
      'one-line child traceparent keeps the flags');
  _assert(childParts[2] != parentParts[2] && childParts[2].length == 16,
      'one-line child traceparent mints a fresh 16-hex spanId');
  final headers2 = oneLine.headers();
  _assert(headers2['traceparent']!.split('-')[2] != childParts[2],
      'each headers() call mints a distinct child spanId');
  _assert(headers['accept'] == 'application/json',
      'one-line headers preserve existing');
  oneLine.setUser({'id': 'one-line-user', 'token': 'secret'});
  oneLine.addAction('OneLineCheckout', detail: 'token secret');
  oneLine.addInput('CouponInput');
  oneLine.addScroll('CheckoutList', offset: 320);
  oneLine.addPerformance('SlowScreen', const Duration(milliseconds: 234),
      detail: 'token secret');
  oneLine.replay?.recordTap('PayButton', x: 1, y: 2);
  await oneLine.replay?.recordError(Exception('one-line crash'));
  _assert(_replayBodies(oneLineCalls).length == 1, 'one-line error flushes');
  final oneLineReplay = _replayBodies(oneLineCalls).single;
  _assert(oneLineReplay.contains('one-line crash'), 'one-line payload');
  _assert(
      oneLineReplay.contains('performance redacted durationMs=234 redacted'),
      'one-line performance forwards to replay');
  _assert(
      ((jsonDecode(oneLineReplay) as Map<String, dynamic>)['document']
              as Map<String, dynamic>)['sessionId'] ==
          oneLine.sessionId,
      'one-line replay uses session id');
  final oneLineMetadata =
      ((jsonDecode(oneLineReplay) as Map<String, dynamic>)['document']
          as Map<String, dynamic>)['metadata'] as Map<String, dynamic>;
  _assert(oneLineMetadata['release'] == '2.0.0', 'one-line release');
  _assert(oneLineMetadata['environment'] == 'qa', 'one-line environment');
  _assert(oneLineMetadata['user.id'] == 'one-line-user', 'one-line user');
  _assert(oneLineReplay.contains('action redacted redacted'),
      'one-line action');
  _assert(oneLineReplay.contains('input redacted value=redacted'),
      'one-line input');
  _assert(oneLineReplay.contains('scroll redacted offset=320'),
      'one-line scroll');
  // The one-line client also emits a timeline document (click + error).
  final oneLineTimeline = _timelineBodies(oneLineCalls).single;
  _assert(oneLineTimeline.contains('"schema":"jaytrace.timeline.v1"'),
      'one-line timeline document');
  _assert(oneLineTimeline.contains('click redacted x=1 y=2'),
      'one-line timeline click');

  final clientTraceCalls = <String>[];
  final tracedClient = initJayTraceFlutter(
    apiKey: 'flutter-key',
    endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
    traceOrigins: ['https://api.example.test'],
    sender: (endpoint, headers, body) {
      clientTraceCalls.add(body);
    },
  );
  final tracedStatus = await tracedClient.traceNetwork<int>(
    method: 'post',
    url: Uri.parse('https://api.example.test/client-trace'),
    run: (headers) async {
      // traceNetwork injects a child span, not the parent traceparent verbatim.
      final injected = headers['traceparent']!.split('-');
      final parent = tracedClient.traceparent.split('-');
      _assert(injected[1] == parent[1] && injected[2] != parent[2],
          'client traceNetwork injects a child traceparent');
      return 503;
    },
    status: (statusCode) => statusCode,
  );
  _assert(tracedStatus == 503, 'client traceNetwork returns result');
  await Future<void>.delayed(Duration.zero);
  _assert(_replayBodies(clientTraceCalls).length == 1,
      'client traceNetwork flushes failure');
  _assert(_replayBodies(clientTraceCalls).single.contains(
          'POST redacted status=503'),
      'client traceNetwork records network');

  await tracedClient.traceNetwork<int>(
    method: 'get',
    url: Uri.parse('https://analytics.example.test/collect'),
    run: (headers) async {
      _assert(!headers.containsKey('traceparent'),
          'client traceNetwork skips third-party traceparent');
      return 200;
    },
    status: (statusCode) => statusCode,
  );
  _assert(_replayBodies(clientTraceCalls).length == 1,
      'client traceNetwork skips third-party replay');

  // jayTraceHttpSender는 존재하고 JayTraceReplaySender 시그니처와 일치한다.
  const JayTraceReplaySender assigned = jayTraceHttpSender;
  _assert(identical(assigned, jayTraceHttpSender), 'default sender exported');

  // --- JayTraceReplaySegmenter / decideJayTraceReplaySampling / JayTraceErrorTailBuffer ---
  // Ports segmenter.ts semantics: push-then-check, ended short-circuit,
  // empty drain -> null, seq increments only on non-empty drain.

  {
    var segNow = DateTime.utc(2026, 7, 1, 12);
    final seg = JayTraceReplaySegmenter(
      flushMs: 100,
      maxBytes: 1000000,
      maxSessionMs: 1000000,
      now: () => segNow,
    );
    _assert(seg.add('a', 10) == 'buffered', 'segmenter buffered before flushMs');
    segNow = segNow.add(const Duration(milliseconds: 100));
    _assert(seg.add('b', 10) == 'flush', 'segmenter time-based flush');
    final drained = seg.drain();
    _assert(drained != null, 'segmenter time flush drain non-null');
    _assert(drained!.items.length == 2, 'segmenter time flush drains both frames');
    _assert(drained.seq == 0, 'segmenter first drain seq is 0');
  }

  {
    var segNow = DateTime.utc(2026, 7, 1, 12);
    final seg = JayTraceReplaySegmenter(
      flushMs: 1000000,
      maxBytes: 20,
      maxSessionMs: 1000000,
      now: () => segNow,
    );
    _assert(seg.add('x', 15) == 'buffered', 'segmenter size buffered under maxBytes');
    _assert(seg.add('y', 10) == 'flush', 'segmenter size-based flush');
    final drained = seg.drain()!;
    _assert(drained.items.length == 2, 'segmenter size flush drains both frames');

    _assert(seg.drain() == null, 'segmenter empty drain returns null');
    seg.add('z', 5);
    final second = seg.drain()!;
    _assert(second.seq == 1, 'segmenter seq increments only on non-empty drain');
  }

  {
    var segNow = DateTime.utc(2026, 7, 1, 12);
    final seg = JayTraceReplaySegmenter(
      flushMs: 1000000,
      maxBytes: 1000000,
      maxSessionMs: 50,
      now: () => segNow,
    );
    _assert(seg.add('p', 5) == 'buffered', 'segmenter session not yet ended');
    segNow = segNow.add(const Duration(milliseconds: 60));
    _assert(seg.add('q', 5) == 'session-ended', 'segmenter add trips session-ended');
    final tail = seg.drain();
    _assert(tail != null, 'segmenter final drain non-null');
    _assert(tail!.items.length == 2,
        'segmenter final drain includes the tripping frame');
    _assert(seg.drain() == null, 'segmenter drain after session-ended is null');
    _assert(seg.add('r', 5) == 'session-ended',
        'segmenter add after ended short-circuits');
  }

  _assert(decideJayTraceReplaySampling(1) == true,
      'sampling rate>=1 is always true');
  _assert(decideJayTraceReplaySampling(0) == false,
      'sampling rate<=0 is always false');
  _assert(decideJayTraceReplaySampling(0.5, random: () => 0.4) == true,
      'sampling 0.5 with random 0.4 is true');
  _assert(decideJayTraceReplaySampling(0.5, random: () => 0.6) == false,
      'sampling 0.5 with random 0.6 is false');
  _assert(decideJayTraceReplaySampling(50, random: () => 0.4) == true,
      'legacy percent rate 50 behaves as 0.5 (random 0.4)');
  _assert(decideJayTraceReplaySampling(50, random: () => 0.6) == false,
      'legacy percent rate 50 behaves as 0.5 (random 0.6)');

  {
    final tailBuffer = JayTraceErrorTailBuffer(maxEvents: 2);
    tailBuffer.add('e1');
    tailBuffer.add('e2');
    tailBuffer.add('e3');
    final tail = tailBuffer.drainTail();
    _assert(tail.length == 2, 'error tail buffer keeps only maxEvents');
    _assert(tail.first == 'e2' && tail.last == 'e3',
        'error tail buffer keeps the most recent events');
    _assert(tailBuffer.drainTail().isEmpty,
        'error tail buffer drainTail empties the buffer');
  }

  // Byte cap eviction: past maxBytes the oldest items are dropped, using the
  // caller-supplied byte estimate, but the last item is never evicted even if
  // it alone exceeds the cap.
  {
    final byteBuffer =
        JayTraceErrorTailBuffer(maxEvents: 100, maxBytes: 25);
    byteBuffer.add('a', 10);
    byteBuffer.add('b', 10);
    byteBuffer.add('c', 10); // running sum 30 > 25 -> evict oldest ('a')
    final tail = byteBuffer.drainTail();
    _assert(tail.length == 2 && tail.first == 'b' && tail.last == 'c',
        'error tail buffer evicts oldest past maxBytes');

    final oversized = JayTraceErrorTailBuffer(maxEvents: 100, maxBytes: 5);
    oversized.add('single', 1000); // one item over cap is kept as-is
    final onlyTail = oversized.drainTail();
    _assert(onlyTail.length == 1 && onlyTail.single == 'single',
        'error tail buffer never evicts the last remaining item');

    // Without an explicit estimate the size is derived from the event; three
    // short strings stay under a generous cap.
    final derived = JayTraceErrorTailBuffer(maxEvents: 100, maxBytes: 1000);
    derived.add('x');
    derived.add('y');
    _assert(derived.drainTail().length == 2,
        'error tail buffer derives byte estimate when none is supplied');
  }

  // --- Redaction options: sensitiveKeys merge + redactionEnabled toggle ---
  {
    final redactCalls = <String>[];
    final merged = initJayTraceFlutter(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      metadata: const {'ssn': '123-45-6789', 'plainField': 'visible'},
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        sensitiveKeys: ['ssn'],
      ),
      sender: (endpoint, headers, body) {
        redactCalls.add(body);
      },
    );
    await merged.replay?.recordError(Exception('merge redaction crash'));
    final mergedReplay = _replayBodies(redactCalls).single;
    final mergedMeta =
        ((jsonDecode(mergedReplay) as Map<String, dynamic>)['document']
            as Map<String, dynamic>)['metadata'] as Map<String, dynamic>;
    _assert(mergedMeta['ssn'] == 'redacted',
        'user sensitiveKeys merge into the built-in keyset (ssn masked)');
    _assert(mergedMeta['plainField'] == 'visible',
        'non-sensitive metadata is left intact');
    // Built-in keys still redact alongside user keys.
    _assert(
        (jsonDecode(mergedReplay) as Map<String, dynamic>)
            .toString()
            .isNotEmpty,
        'merged redaction produced a document');

    final toggleCalls = <String>[];
    final toggled = initJayTraceFlutter(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      metadata: const {'token': 'super-secret'},
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        redactionEnabled: false,
      ),
      sender: (endpoint, headers, body) {
        toggleCalls.add(body);
      },
    );
    await toggled.replay?.recordError(Exception('toggle redaction crash'));
    final toggledMeta =
        ((jsonDecode(_replayBodies(toggleCalls).single)
                as Map<String, dynamic>)['document']
            as Map<String, dynamic>)['metadata'] as Map<String, dynamic>;
    _assert(toggledMeta['token'] == 'super-secret',
        'redactionEnabled=false skips sensitive-key masking');
  }

  // --- captureBody: cap + [truncated] + sensitive-key masking ---
  {
    final bodyCalls = <String>[];
    final bodyClient = initJayTraceFlutter(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceOrigins: ['https://api.example.test'],
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        mode: JayTraceReplayMode.always,
        captureBody: 16, // small cap to force truncation
      ),
      sender: (endpoint, headers, body) {
        bodyCalls.add(body);
      },
    );
    final longBody = 'password=hunter2 ${'x' * 100}';
    await bodyClient.traceNetwork<int>(
      method: 'post',
      url: Uri.parse('https://api.example.test/login'),
      requestBody: longBody,
      run: (headers) async => 200,
      responseBody: (_) => 'Bearer abcdef123456 token=leak',
      status: (code) => code,
    );
    await bodyClient.replay?.flush('manual');
    final joined = bodyCalls.join('\n');
    _assert(joined.contains('network-body request POST'),
        'captureBody records a request body line');
    _assert(joined.contains('[truncated]'),
        'captureBody truncates bodies past the cap');
    _assert(joined.contains('password=redacted'),
        'captureBody masks sensitive key=value assignments');
    _assert(joined.contains('network-body response POST'),
        'captureBody records a response body line');
    _assert(joined.contains('Bearer redacted') &&
        !joined.contains('abcdef123456'),
        'captureBody masks bare Bearer tokens in the response body');

    // Off by default: no body lines recorded when captureBody is unset.
    final offCalls = <String>[];
    final offClient = initJayTraceFlutter(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceOrigins: ['https://api.example.test'],
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        mode: JayTraceReplayMode.always,
      ),
      sender: (endpoint, headers, body) {
        offCalls.add(body);
      },
    );
    await offClient.traceNetwork<int>(
      method: 'post',
      url: Uri.parse('https://api.example.test/login'),
      requestBody: 'password=hunter2',
      run: (headers) async => 200,
      status: (code) => code,
    );
    await offClient.replay?.flush('manual');
    _assert(!offCalls.join('\n').contains('network-body'),
        'captureBody off by default records no body lines');
  }

  // --- Timeline fetch event: structured requestBody/responseBody attach ---
  {
    final fetchBodyCalls = <String>[];
    final fetchBodyClient = initJayTraceFlutter(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceId: 'ffffffffffffffffffffffffffffffff',
      traceOrigins: ['https://api.example.test'],
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        mode: JayTraceReplayMode.always,
        captureBody: true,
      ),
      sender: (endpoint, headers, body) {
        fetchBodyCalls.add(body);
      },
    );
    await fetchBodyClient.traceNetwork<int>(
      method: 'post',
      url: Uri.parse('https://api.example.test/login'),
      requestBody: '{"password":"hunter2","name":"jo"}',
      run: (headers) async => 200,
      responseBody: (_) => '{"ok":true,"token":"leak"}',
      status: (code) => code,
    );
    await fetchBodyClient.replay?.flushTimeline('manual');
    final fetchDoc = (jsonDecode(_timelineBodies(fetchBodyCalls).single)
        as Map<String, dynamic>)['document'] as Map<String, dynamic>;
    final fetchEvent = (fetchDoc['events'] as List<dynamic>)
        .cast<Map<String, dynamic>>()
        .firstWhere((e) => e['kind'] == 'fetch');
    final fetchData = fetchEvent['data'] as Map<String, dynamic>;
    final requestBody = fetchData['requestBody'] as Map<String, dynamic>;
    _assert(requestBody['password'] == 'redacted',
        'timeline fetch requestBody masks sensitive keys');
    _assert(requestBody['name'] == 'jo',
        'timeline fetch requestBody keeps non-sensitive fields');
    final responseBody = fetchData['responseBody'] as Map<String, dynamic>;
    _assert(responseBody['ok'] == true,
        'timeline fetch responseBody keeps non-sensitive fields');
    _assert(responseBody['token'] == 'redacted',
        'timeline fetch responseBody masks sensitive keys');
  }

  // --- recordView: timeline + replay dual-record, name dedup, 100 cap ---
  {
    final viewCalls = <String>[];
    final viewClient = initJayTraceFlutter(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0',
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        privacy: JayTraceReplayPrivacy.allow,
      ),
      sender: (endpoint, headers, body) {
        viewCalls.add(body);
      },
    );
    viewClient.recordView('Hero');
    viewClient.recordView('Hero'); // duplicate name -> ignored
    viewClient.recordView('Card');
    _assert(
        viewClient.replay!.snapshot()['events'].toString().contains('view Hero'),
        'recordView writes a replay view line');
    await viewClient.replay?.flushTimeline('manual');
    final viewEvents = ((jsonDecode(_timelineBodies(viewCalls).single)
                as Map<String, dynamic>)['document'] as Map<String, dynamic>)[
            'events'] as List<dynamic>;
    final tlViews = viewEvents
        .cast<Map<String, dynamic>>()
        .where((e) => e['kind'] == 'view')
        .toList();
    _assert(tlViews.length == 2,
        'recordView dedupes by name across timeline + replay (Hero once)');
    _assert(
        tlViews.any((e) => e['text'] == 'Hero') &&
            tlViews.any((e) => e['text'] == 'Card'),
        'recordView records both distinct view names');

    // 100-per-session cap, verified on the replay buffer (cap 200 > 100).
    final capCalls = <String>[];
    final capClient = initJayTraceFlutter(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceId: 'cccccccccccccccccccccccccccccccc',
      replay: const JayTraceFlutterReplayOptions(
        enabled: true,
        privacy: JayTraceReplayPrivacy.allow,
      ),
      sender: (endpoint, headers, body) {
        capCalls.add(body);
      },
    );
    for (var i = 0; i < 150; i++) {
      capClient.recordView('screen-$i');
    }
    final capViews = (capClient.replay!.snapshot()['events'] as List<dynamic>)
        .where((line) => line.toString().contains(' view '))
        .toList();
    _assert(capViews.length == 100, 'recordView caps at 100 views per session');
  }

  // --- log(level, message, context): severity mapping, masking, replay line ---
  {
    final logCalls = <String>[];
    final logClient = initJayTraceFlutter(
      apiKey: 'flutter-key',
      endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
      traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      replay: const JayTraceFlutterReplayOptions(enabled: true),
      sender: (endpoint, headers, body) {
        logCalls.add(body);
      },
    );
    logClient.log('debug', 'debug entry');
    logClient.log('info', 'info entry');
    logClient.log('warn', 'warn entry');
    logClient.log('error', 'error entry', {'userId': 'u-1', 'token': 'secret'});
    logClient.log('verbose', 'weird level entry'); // invalid level -> info

    // An error-level log is NOT a flush trigger on its own; only thrown
    // exceptions drive the error flush. Nothing is sent until a manual flush.
    _assert(_timelineBodies(logCalls).isEmpty,
        'log(error) does not trigger a flush by itself');

    await logClient.replay?.flushTimeline('manual');
    final logDoc = (jsonDecode(_timelineBodies(logCalls).single)
        as Map<String, dynamic>)['document'] as Map<String, dynamic>;
    final logEvents = (logDoc['events'] as List<dynamic>)
        .cast<Map<String, dynamic>>()
        .where((e) => e['kind'] == 'log')
        .toList();
    Map<String, dynamic> logByText(String text) =>
        logEvents.firstWhere((e) => e['text'] == 'log $text');

    // 4-level severity mapping.
    _assert(logByText('debug entry')['severity'] == 'debug',
        'log maps debug severity');
    _assert(logByText('info entry')['severity'] == 'info',
        'log maps info severity');
    _assert(logByText('warn entry')['severity'] == 'warn',
        'log maps warn severity');
    _assert(logByText('error entry')['severity'] == 'error',
        'log maps error severity');

    // Unknown level falls back to info.
    _assert(logByText('weird level entry')['severity'] == 'info',
        'log falls back to info for an unknown level');

    // context attaches as masked data.
    final errorData = logByText('error entry')['data'] as Map<String, dynamic>;
    _assert(errorData['userId'] == 'u-1',
        'log attaches non-sensitive context fields');
    _assert(errorData['token'] == 'redacted',
        'log masks sensitive context keys');

    // No-context log omits the data field entirely.
    _assert(!logByText('debug entry').containsKey('data'),
        'log without context omits the data field');

    // Parallel replay line recorded for every log call (web parity).
    final replayLogLines =
        (logClient.replay!.snapshot()['events'] as List<dynamic>)
            .where((line) => line.toString().contains(' log log '))
            .toList();
    _assert(replayLogLines.length == 5,
        'log records a parallel replay line per call');
  }

  // --- Isolation invariant: SDK bookkeeping never throws into the host ---
  // A sender AND a screenshot provider that throw on every call. Every public
  // bookkeeping API must still return normally; only user-run callbacks may
  // propagate (asserted separately below).
  final hostile = initJayTraceFlutter(
    apiKey: 'flutter-key',
    endpoint: Uri.parse('https://api.example.test/jaytrace/rum'),
    release: '9.9.9',
    environment: 'qa',
    replay: const JayTraceFlutterReplayOptions(
      enabled: true,
      mode: JayTraceReplayMode.always,
      engine: 'screenshot',
    ),
    screenshot: () => throw StateError('screenshot boom'),
    sender: (endpoint, headers, body) => throw StateError('sender boom'),
  );
  // None of these may throw despite the hostile sender + screenshot provider.
  hostile.setUser({'id': 'u', 'token': 'secret'});
  hostile.addAction('Act', detail: 'token secret');
  hostile.addInput('Field');
  hostile.addScroll('List', offset: 10);
  hostile.addPerformance('Slow', const Duration(milliseconds: 5));
  hostile.log('error', 'host log', {'token': 'secret'});
  hostile.headers({'accept': 'application/json'});
  hostile.replay?.recordTap('Btn', x: 1, y: 2);
  await hostile.replay?.recordError(Exception('host survives'));
  await hostile.replay?.flush('manual');
  _assert(true, 'hostile sender/screenshot: public API never throws');

  // traceNetwork: the user run() result flows through untouched; the failing
  // sender in the bookkeeping flush around it must be swallowed, not surfaced.
  final tnStatus = await hostile.traceNetwork<int>(
    method: 'get',
    url: Uri.parse('https://api.example.test/thing'),
    run: (headers) async => 503, // 503 -> record failure -> flush -> throws
    status: (code) => code,
  );
  _assert(tnStatus == 503, 'traceNetwork returns despite failing-sender flush');
  await Future<void>.delayed(Duration.zero);
  // The sender failed, so the buffer is retained (nothing cleared).
  _assert(
    (hostile.replay?.snapshot()['events'] as List<dynamic>)
        .any((l) => l.toString().contains('host survives')),
    'failing sender keeps buffered replay events',
  );

  // runJayTraceGuarded: the USER body throw MUST still reach onError untouched,
  // even though SDK recordError bookkeeping (failing sender) runs around it.
  Object? guardedUserErr;
  await runJayTraceGuarded<void>(
    hostile.replay,
    () => throw StateError('user body throw'),
    onError: (e, st) => guardedUserErr = e,
  );
  await Future<void>.delayed(Duration.zero);
  _assert(guardedUserErr.toString().contains('user body throw'),
      'runJayTraceGuarded surfaces the user body throw to onError');

  // A throwing user `status` extractor is bookkeeping around the result — it
  // must never convert the user's successful result into a failure.
  final statusThrowResult = await hostile.traceNetwork<int>(
    method: 'get',
    url: Uri.parse('https://api.example.test/ok'),
    run: (headers) async => 200,
    status: (_) => throw StateError('status extractor boom'),
  );
  _assert(statusThrowResult == 200,
      'throwing status extractor does not lose the successful result');

  // The user run() error itself must still propagate untouched.
  var runErrorPropagated = false;
  try {
    await hostile.traceNetwork<int>(
      method: 'get',
      url: Uri.parse('https://api.example.test/user-throw'),
      run: (headers) async => throw StateError('user run boom'),
    );
  } on StateError catch (error) {
    runErrorPropagated = error.toString().contains('user run boom');
  }
  _assert(runErrorPropagated,
      'traceNetwork still propagates the user run error under a hostile sender');

  hostile.dispose();
}

void _assert(bool condition, String message) {
  if (!condition) {
    throw StateError('self-check failed: $message');
  }
}

Map<String, dynamic> _documentOf(String body) =>
    (jsonDecode(body) as Map<String, dynamic>)['document'] as Map<String, dynamic>;

/// Sender bodies carrying a replay document (`jaytrace.replay.v1`). recordError
/// and network failures now emit a parallel `jaytrace.timeline.v1` document, so
/// replay-specific assertions filter to this subset.
List<String> _replayBodies(List<String> calls) =>
    calls.where((b) => _documentOf(b)['schema'] == 'jaytrace.replay.v1').toList();

/// Sender bodies carrying a console-timeline document (`jaytrace.timeline.v1`).
List<String> _timelineBodies(List<String> calls) =>
    calls.where((b) => _documentOf(b)['schema'] == 'jaytrace.timeline.v1').toList();
