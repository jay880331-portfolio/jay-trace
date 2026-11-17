library jaytrace_flutter;

// NOTE: Unlike the web/RN SDKs, this Flutter SDK deliberately does NOT hook
// print/debugPrint for automatic console capture — intercepting them requires
// an intrusive Zone override that would wrap the host app's entire execution.
// Developers emit structured entries explicitly via `log(level, message,
// context)` instead (web/RN parity), which is the only console path here.

import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'jaytrace_flutter_timeline.dart';

export 'jaytrace_flutter_timeline.dart'
    show JayTraceTimelineBuffer, JayTraceTimelineEvent;

typedef JayTraceReplaySender = FutureOr<void> Function(
  Uri endpoint,
  Map<String, String> headers,
  String body,
);

typedef JayTraceScreenshotProvider = FutureOr<JayTraceScreenshotFrame?>
    Function();

enum JayTraceReplayMode { off, onError, always }

enum JayTraceReplayPrivacy { maskAll, maskInputs, allow }

class JayTraceFlutterReplayOptions {
  const JayTraceFlutterReplayOptions({
    this.enabled = false,
    this.mode = JayTraceReplayMode.onError,
    this.sampleRate = 100,
    this.privacy = JayTraceReplayPrivacy.maskAll,
    this.maxEvents = 200,
    this.maxDuration = const Duration(seconds: 30),
    this.maxScreenshotBytes = 320000,
    this.maskText,
    this.maskInputs,
    this.flushInterval,
    this.engine = 'wireframe',
    this.wireframeIntervalMs = 800,
    this.segmentFlushMs = 10000,
    this.maxSegmentBytes = 262144,
    this.redactionEnabled = true,
    this.sensitiveKeys = const [],
    this.captureBody = false,
    this.timelineMaxEvents = 80,
  });

  final bool enabled;
  final JayTraceReplayMode mode;
  final double sampleRate;
  final JayTraceReplayPrivacy privacy;
  final int maxEvents;
  final Duration maxDuration;
  final int maxScreenshotBytes;
  final bool? maskText;
  final bool? maskInputs;
  final Duration? flushInterval;

  /// "wireframe" (default) serializes the render tree to vector primitives;
  /// "screenshot" keeps the legacy screenshot-only path (new capture inert).
  final String engine;
  final int wireframeIntervalMs;
  final int segmentFlushMs;
  final int maxSegmentBytes;

  /// When false, sensitive-key redaction of metadata and captured bodies is
  /// skipped entirely (opt-out; default true). Mirrors RedactOptions.enabled.
  final bool redactionEnabled;

  /// Extra key tokens merged into the built-in sensitive keyset used by
  /// [_isSensitiveKey]. Matched case-insensitively against key path segments.
  final List<String> sensitiveKeys;

  /// Request/response body capture for [JayTraceFlutterReplay.traceNetwork].
  /// Off by default. Pass `true` for the 8192-char default cap, or an `int`
  /// maxBytes to override the cap. Mirrors browser-sdk `captureBody`.
  final Object? captureBody;

  /// Rolling cap for the console-timeline buffer (`jaytrace.timeline.v1`).
  /// Mirrors browser-sdk `maxEvents` (default 80).
  final int timelineMaxEvents;

  JayTraceFlutterReplayOptions copyWith({
    bool? enabled,
    JayTraceReplayMode? mode,
    double? sampleRate,
    JayTraceReplayPrivacy? privacy,
    String? engine,
  }) {
    return JayTraceFlutterReplayOptions(
      enabled: enabled ?? this.enabled,
      mode: mode ?? this.mode,
      sampleRate: sampleRate ?? this.sampleRate,
      privacy: privacy ?? this.privacy,
      maxEvents: maxEvents,
      maxDuration: maxDuration,
      maxScreenshotBytes: maxScreenshotBytes,
      maskText: maskText,
      maskInputs: maskInputs,
      flushInterval: flushInterval,
      engine: engine ?? this.engine,
      wireframeIntervalMs: wireframeIntervalMs,
      segmentFlushMs: segmentFlushMs,
      maxSegmentBytes: maxSegmentBytes,
      redactionEnabled: redactionEnabled,
      sensitiveKeys: sensitiveKeys,
      captureBody: captureBody,
      timelineMaxEvents: timelineMaxEvents,
    );
  }
}

/// Implemented by the wireframe coordinator (flutter/rendering-dependent) and
/// wired into [JayTraceFlutterReplay] from the widgets layer, keeping this file
/// free of flutter imports so it runs under `dart run`.
abstract class JayTraceWireframeHook {
  void capture({int? x, int? y});
  Future<void> flushOnError();
  void resume();
  void pause();
  void dispose();
}

class JayTraceScreenshotFrame {
  const JayTraceScreenshotFrame({
    required this.image,
    this.mediaType = 'image/png',
    this.width,
    this.height,
  });

  final String image;
  final String mediaType;
  final int? width;
  final int? height;
}

class JayTraceNetworkEvent {
  const JayTraceNetworkEvent({
    required this.method,
    required this.url,
    this.status,
    this.duration,
    this.error,
  });

  final String method;
  final Uri url;
  final int? status;
  final Duration? duration;
  final String? error;
}

class JayTraceFlutterOptions {
  const JayTraceFlutterOptions({
    required this.apiKey,
    required this.endpoint,
    required this.traceId,
    required this.sender,
    this.sessionId,
    this.traceparent,
    this.traceOrigins,
    this.release,
    this.environment,
    this.metadata,
    this.replay = const JayTraceFlutterReplayOptions(),
    this.screenshot,
    this.now,
  });

  final String apiKey;
  final Uri endpoint;
  final String traceId;
  final String? sessionId;
  final String? traceparent;
  final List<String>? traceOrigins;
  final String? release;
  final String? environment;
  final Map<String, Object?>? metadata;
  final JayTraceReplaySender sender;
  final JayTraceFlutterReplayOptions replay;
  final JayTraceScreenshotProvider? screenshot;
  final DateTime Function()? now;
}

class JayTraceFlutterClient {
  const JayTraceFlutterClient({
    required this.traceId,
    required this.traceparent,
    required this.sessionId,
    this.fixedSessionId,
    this.traceOrigins,
    required this.replay,
  });

  final String traceId;
  final String traceparent;
  final String sessionId;

  /// The caller-supplied session id, or null when the session is auto-managed
  /// and allowed to rotate (see [jayTraceTouchSession]).
  final String? fixedSessionId;
  final List<String>? traceOrigins;
  final JayTraceFlutterReplay? replay;

  Map<String, String> headers([Map<String, String>? headers]) {
    return {
      ...?headers,
      // Emit a fresh child span per call: keep the parent traceId and flags but
      // mint a new spanId so each outbound request is its own span (mirrors
      // core createChildTraceparent).
      'traceparent': _childTraceparent(),
      // Surface the active session id; a headers() call is session activity.
      'x-jaytrace-session': fixedSessionId ?? jayTraceTouchSession(),
    };
  }

  String _childTraceparent() {
    final parts = traceparent.split('-');
    if (parts.length == 4 && parts[1].length == 32 && parts[2].length == 16) {
      return '00-${parts[1]}-${_hex(8)}-${parts[3]}';
    }
    return traceparent;
  }

  Future<T> traceNetwork<T>({
    required String method,
    required Uri url,
    required Future<T> Function(Map<String, String> headers) run,
    int? Function(T result)? status,
    Map<String, String>? headers,
    String? requestBody,
    String? Function(T result)? responseBody,
  }) {
    final shouldTrace = _shouldTrace(url, traceOrigins);
    final nextHeaders = shouldTrace ? this.headers(headers) : {...?headers};
    final networkReplay = replay;
    if (networkReplay == null || !shouldTrace) {
      return run(nextHeaders);
    }
    return networkReplay.traceNetwork(
      method: method,
      url: url,
      status: status,
      requestBody: requestBody,
      responseBody: responseBody,
      run: () => run(nextHeaders),
    );
  }

  void setUser(Map<String, Object?>? user) {
    replay?.setUser(user);
  }

  void addAction(String name, {String? detail}) {
    replay?.recordAction(name, detail: detail);
  }

  void addInput(String target) {
    replay?.recordInput(target);
  }

  void addScroll(String target, {double? offset}) {
    replay?.recordScroll(target, offset: offset);
  }

  void addPerformance(String name, Duration duration, {String? detail}) {
    replay?.recordPerformance(name, duration, detail: detail);
  }

  void recordView(String name) {
    replay?.recordView(name);
  }

  void log(String level, String message, [Map<String, Object?>? context]) {
    replay?.log(level, message, context);
  }

  void dispose() {
    replay?.dispose();
  }
}

JayTraceFlutterClient initJayTraceFlutter({
  required String apiKey,
  required Uri endpoint,
  required JayTraceReplaySender sender,
  String? traceId,
  String? sessionId,
  String? traceparent,
  List<String>? traceOrigins,
  String? release,
  String? environment,
  Map<String, Object?>? metadata,
  JayTraceFlutterReplayOptions replay =
      const JayTraceFlutterReplayOptions(enabled: true),
  JayTraceScreenshotProvider? screenshot,
  DateTime Function()? now,
}) {
  final parsed = _traceparent(traceparent, traceId);
  final resolvedSessionId = sessionId ?? jayTraceTouchSession();
  final replayClient = JayTraceFlutterReplay.init(
    JayTraceFlutterOptions(
      apiKey: apiKey,
      endpoint: endpoint,
      traceId: parsed.traceId,
      // Explicit-only: when the caller omits sessionId, document creation
      // touches the rotating session instead of freezing an id here.
      sessionId: sessionId,
      traceparent: parsed.value,
      traceOrigins: traceOrigins,
      release: release,
      environment: environment,
      metadata: metadata,
      replay: replay,
      screenshot: screenshot,
      sender: sender,
      now: now,
    ),
  );
  return JayTraceFlutterClient(
    traceId: parsed.traceId,
    traceparent: parsed.value,
    sessionId: resolvedSessionId,
    fixedSessionId: sessionId,
    traceOrigins: traceOrigins,
    replay: replayClient,
  );
}

class JayTraceFlutterReplay {
  JayTraceFlutterReplay._(this._options)
      : _startedAt = (_options.now ?? DateTime.now).call().toUtc() {
    _metadata.addAll(_safeMetadata({
      'release': _options.release,
      'environment': _options.environment,
      ...?_options.metadata,
      'replay.screenshot': _options.screenshot == null ? 'missing' : 'enabled',
    }));
    _timeline = JayTraceTimelineBuffer(
      traceId: _options.traceId,
      sessionId: _options.sessionId ?? jayTraceTouchSession(),
      service: 'flutter',
      traceparent: _options.traceparent,
      now: _now,
      post: _post,
      maskData: _maskDataMap,
      maxEvents: _options.replay.timelineMaxEvents,
    );
  }

  final JayTraceFlutterOptions _options;
  final DateTime _startedAt;
  final List<_ReplayEvent> _events = [];
  final List<_ReplayFrame> _frames = [];
  final List<Future<void>> _pendingFrames = [];
  final Map<String, Object?> _metadata = {};

  /// Console-timeline buffer emitting `jaytrace.timeline.v1` documents in
  /// parallel with the replay stream (web parity).
  late final JayTraceTimelineBuffer _timeline;

  /// One-view-per-name, session-capped element exposure dedup (mirrors the web
  /// captureViews rules: dedupe by name, hard-cap at 100).
  final Set<String> _viewedNames = <String>{};
  static const int _maxViews = 100;

  Timer? _flushTimer;

  /// Wireframe capture coordinator, injected by the widgets layer when
  /// `engine == "wireframe"`. Null under the pure-Dart / screenshot paths.
  JayTraceWireframeHook? wireframe;

  JayTraceFlutterReplayOptions get replayOptions => _options.replay;
  JayTraceReplayMode get replayMode => _options.replay.mode;
  String get engine => _options.replay.engine;
  bool get maskText => _maskText;

  static JayTraceFlutterReplay? init(JayTraceFlutterOptions options) {
    if (!options.replay.enabled ||
        options.replay.mode == JayTraceReplayMode.off ||
        !_sampleRate(options.replay.sampleRate)) {
      return null;
    }
    final replay = JayTraceFlutterReplay._(options);
    replay._startFlushTimer();
    return replay;
  }

  void recordRoute(String name) {
    final safeName = _safe(name, mask: _maskText);
    _metadata['view.name'] = safeName;
    _captureFrame(_add('route', 'route $safeName'));
    wireframe?.capture();
    _timeline.addText('navigation', 'route $safeName');
  }

  void recordRouteEnd(String name, Duration duration) {
    final safeName = _safe(name, mask: _maskText);
    _add('route', 'route_end $safeName durationMs=${duration.inMilliseconds}');
    _timeline.addText('navigation', 'route_end $safeName',
        durationMs: duration.inMilliseconds);
  }

  void setUser(Map<String, Object?>? user) {
    _metadata.removeWhere((key, value) => key.startsWith('user.'));
    _timeline.setUser(user);
    if (user == null) {
      return;
    }
    for (final entry in _safeMetadata(user).entries) {
      _metadata['user.${entry.key}'] = entry.value;
    }
  }

  void recordTap(String target, {double? x, double? y}) {
    final point = x != null && y != null
        ? _ReplayPoint(x.round(), y.round())
        : null;
    final pointText = point != null ? ' x=${point.x} y=${point.y}' : '';
    final safeTarget = _safe(target, mask: _maskText);
    _captureFrame(
      _add('gesture', 'tap $safeTarget$pointText'),
      point: point,
    );
    wireframe?.capture(x: point?.x, y: point?.y);
    _timeline.addText('click', 'click $safeTarget$pointText');
  }

  /// Records an element-exposure `view` event to both the replay stream and the
  /// console timeline. Dedupes by (masked) name and caps at 100 per session,
  /// matching the web captureViews rules.
  void recordView(String name) {
    if (_viewedNames.length >= _maxViews) {
      return;
    }
    final safeName = _safe(name, mask: _maskText);
    if (!_viewedNames.add(safeName)) {
      return;
    }
    _captureFrame(_add('view', safeName));
    _timeline.addText('view', safeName);
  }

  static const Set<String> _logLevels = <String>{
    'debug',
    'info',
    'warn',
    'error',
  };

  /// Records a developer-supplied structured log entry to both the console
  /// timeline and the replay stream (web/RN parity for
  /// `log(level, message, context)`). [level] must be one of
  /// debug|info|warn|error — any other value falls back to "info". [context] is
  /// masked via [_maskDataMap] (inside the timeline buffer) before attach. An
  /// `error` level is NOT a flush trigger — only thrown exceptions drive the
  /// error flush — and the whole call is isolated so host logging never throws
  /// back into the caller.
  void log(String level, String message, [Map<String, Object?>? context]) {
    try {
      final severity = _logLevels.contains(level) ? level : 'info';
      final text = 'log $message';
      _timeline.addText(
        'log',
        text,
        severity: severity,
        data: context == null || context.isEmpty ? null : context,
      );
      _add('log', text);
    } catch (_) {
      // isolation: host logging must never surface into the caller.
    }
  }

  void recordAction(String name, {String? detail}) {
    final suffix = detail == null ? '' : ' ${_safe(detail, mask: true)}';
    _captureFrame(
        _add('gesture', 'action ${_safe(name, mask: _maskText)}$suffix'));
  }

  void recordInput(String target) {
    _captureFrame(
        _add('input', 'input ${_safe(target, mask: _maskText)} value=redacted'));
  }

  void recordScroll(String target, {double? offset}) {
    final suffix = offset != null ? ' offset=${offset.round()}' : '';
    _captureFrame(
        _add('scroll', 'scroll ${_safe(target, mask: _maskText)}$suffix'));
  }

  void recordPerformance(String name, Duration duration, {String? detail}) {
    final suffix = detail == null ? '' : ' ${_safe(detail, mask: true)}';
    _captureFrame(_add('gesture',
        'performance ${_safe(name, mask: _maskText)} durationMs=${duration.inMilliseconds}$suffix'));
  }

  Future<void> recordNetwork(
    JayTraceNetworkEvent event, {
    Map<String, Object?>? bodyData,
  }) async {
    _captureFrame(_add('network', _networkLine(event)));
    final failure = _isNetworkFailure(event);
    _timeline.addText(
      'fetch',
      _timelineFetchText(event),
      severity: failure ? 'error' : 'info',
      data: bodyData == null || bodyData.isEmpty ? null : bodyData,
      durationMs: event.duration?.inMilliseconds,
    );
    if (failure &&
        (_options.replay.mode == JayTraceReplayMode.onError ||
            _options.replay.mode == JayTraceReplayMode.always)) {
      await flush('error');
      await _timeline.flush('error');
    }
  }

  Future<T> traceNetwork<T>({
    required String method,
    required Uri url,
    required Future<T> Function() run,
    int? Function(T result)? status,
    String? requestBody,
    String? Function(T result)? responseBody,
  }) async {
    final startedAt = _now();
    final bodyData = <String, Object?>{};
    if (requestBody != null) {
      _recordNetworkBody('request', method, url, requestBody);
      if (_captureBodyEnabled) {
        bodyData['requestBody'] = _captureBodyValue(requestBody);
      }
    }
    try {
      final result = await run();
      int? statusCode;
      try {
        statusCode = status?.call(result);
      } catch (_) {
        // isolation: a throwing status extractor is SDK-adjacent bookkeeping —
        // it must never convert the user's successful result into a failure.
        statusCode = null;
      }
      if (responseBody != null) {
        String body;
        try {
          body = responseBody(result) ?? '';
        } catch (_) {
          // isolation: a throwing body extractor is bookkeeping — surface it as
          // an unreadable body, never as a failure of the user's request.
          body = '[unsupported]';
        }
        if (body.isNotEmpty) {
          _recordNetworkBody('response', method, url, body);
          if (_captureBodyEnabled) {
            bodyData['responseBody'] = _captureBodyValue(body);
          }
        }
      }
      unawaited(recordNetwork(
        JayTraceNetworkEvent(
          method: method,
          url: url,
          status: statusCode,
          duration: _now().difference(startedAt),
        ),
        bodyData: bodyData,
      ));
      return result;
    } catch (error) {
      unawaited(recordNetwork(
        JayTraceNetworkEvent(
          method: method,
          url: url,
          duration: _now().difference(startedAt),
          error: error.toString(),
        ),
        bodyData: bodyData,
      ));
      rethrow;
    }
  }

  Future<void> recordError(Object error, {StackTrace? stackTrace}) async {
    final stack = stackTrace == null
        ? ''
        : ' stack=${_safe(stackTrace.toString(), mask: false)}';
    final text = 'error ${_safe(error.toString(), mask: false)}$stack';
    _timeline.addError(text);
    final screenshot = await _screenshot();
    if (screenshot == null || !_addFrame('error', text, screenshot)) {
      _add('error', text);
    }
    await wireframe?.flushOnError();
    if (_options.replay.mode == JayTraceReplayMode.onError ||
        _options.replay.mode == JayTraceReplayMode.always) {
      await flush('error');
      await _timeline.flush('error');
    }
  }

  /// Flushes the console-timeline buffer independently of the replay buffer
  /// (used by lifecycle inactive/paused/detached transitions).
  Future<void> flushTimeline(String reason) async {
    await _timeline.flush(reason);
  }

  Future<void> flush(String reason) async {
    if (_events.isEmpty) {
      return;
    }
    await _waitForFrames();
    if (await _post(reason, snapshot())) {
      _clear();
    }
  }

  /// POSTs `{apiKey, reason, document}` via the configured sender. Returns true
  /// on success, false (swallowed) on sender failure so callers keep buffered
  /// state. Shared by the v1 flush and the v2 wireframe segment path.
  Future<bool> _post(String reason, Map<String, Object?> document) async {
    try {
      await _options.sender(
        _options.endpoint,
        {
          'content-type': 'application/json',
          if (_options.traceparent != null)
            'traceparent': _options.traceparent!,
        },
        jsonEncode({
          'apiKey': _options.apiKey,
          'reason': reason,
          'document': document,
        }),
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Assembles and sends a `jaytrace.replay.v2` wireframe segment document.
  /// Identity/metadata live here so the wireframe coordinator (flutter layer)
  /// stays decoupled from trace ids and the sender.
  Future<void> sendWireframeSegment({
    required int seq,
    required DateTime startedAt,
    required DateTime endedAt,
    required List<Map<String, Object?>> frames,
    required String reason,
    Map<String, Object?>? extraMeta,
  }) async {
    final metadata = <String, Object?>{
      ..._metadata,
      ...?(extraMeta == null ? null : _safeMetadata(extraMeta)),
    };
    await _post(reason, {
      'schema': 'jaytrace.replay.v2',
      'engine': 'wireframe',
      'platform': 'flutter',
      'traceId': _options.traceId,
      'sessionId': _options.sessionId ?? jayTraceTouchSession(),
      if (_options.traceparent != null) 'traceparent': _options.traceparent,
      'seq': seq,
      'startedAt': startedAt.toUtc().toIso8601String(),
      'endedAt': endedAt.toUtc().toIso8601String(),
      if (metadata.isNotEmpty) 'metadata': metadata,
      'wireframeFrames': frames,
    });
  }

  void dispose() {
    _flushTimer?.cancel();
    _flushTimer = null;
    wireframe?.dispose();
    wireframe = null;
  }

  Map<String, Object?> snapshot() {
    return {
      'schema': 'jaytrace.replay.v1',
      'platform': 'flutter',
      'traceId': _options.traceId,
      'sessionId': _options.sessionId ?? jayTraceTouchSession(),
      if (_options.traceparent != null) 'traceparent': _options.traceparent,
      if (_metadata.isNotEmpty) 'metadata': Map<String, Object?>.from(_metadata),
      'mode': _modeName(_options.replay.mode),
      'startedAt': _startedAt.toIso8601String(),
      'endedAt': _now().toUtc().toIso8601String(),
      'events': _events.map((event) => event.line).toList(),
      if (_frames.isNotEmpty)
        'frames': _frames.map((frame) => frame.json).toList(),
    };
  }

  _ReplayEvent _add(String kind, String text) {
    final event = _ReplayEvent(_elapsed(), kind, text);
    _events.add(event);
    _trim();
    return event;
  }

  bool _addFrame(String kind, String text, JayTraceScreenshotFrame screenshot) {
    if (!_validScreenshot(screenshot)) {
      return false;
    }
    final event = _ReplayEvent(_elapsed(), kind, text);
    _events.add(event);
    _frames.add(_ReplayFrame(event, screenshot));
    _trim();
    return true;
  }

  Future<void> _captureFrame(_ReplayEvent event, {_ReplayPoint? point}) async {
    // Belt-and-suspenders: the wireframe engine is pixel-free by contract, so
    // never invoke the screenshot provider under it even if one is attached.
    if (engine == 'wireframe') {
      return;
    }
    final pending = () async {
      try {
        final screenshot = await _options.screenshot?.call();
        if (screenshot == null || !_validScreenshot(screenshot)) {
          return;
        }
        _frames.add(_ReplayFrame(event, screenshot, point));
        _trim();
      } catch (_) {
        return;
      }
    }();
    _pendingFrames.add(pending);
    await pending;
  }

  Future<JayTraceScreenshotFrame?> _screenshot() async {
    if (engine == 'wireframe') {
      return null;
    }
    try {
      final screenshot = await _options.screenshot?.call();
      return screenshot != null && _validScreenshot(screenshot)
          ? screenshot
          : null;
    } catch (_) {
      return null;
    }
  }

  bool _validScreenshot(JayTraceScreenshotFrame screenshot) {
    if (!RegExp(r'^data:image/[a-z0-9.+-]+;base64,', caseSensitive: false)
        .hasMatch(screenshot.image)) {
      return false;
    }
    final data = screenshot.image.split(',').last;
    return _base64ByteLength(data) <= _options.replay.maxScreenshotBytes;
  }

  Future<void> _waitForFrames() async {
    while (_pendingFrames.isNotEmpty) {
      final pending = List<Future<void>>.from(_pendingFrames);
      _pendingFrames.clear();
      await Future.wait(pending);
    }
  }

  void _trim() {
    while (_events.length > _options.replay.maxEvents) {
      _events.removeAt(0);
    }
    while (_frames.length > _options.replay.maxEvents) {
      _frames.removeAt(0);
    }

    final cutoff = _now().subtract(_options.replay.maxDuration);
    while (_events.isNotEmpty &&
        _events.first.absoluteTime(_startedAt).isBefore(cutoff)) {
      _events.removeAt(0);
    }
    while (_frames.isNotEmpty &&
        _frames.first.event.absoluteTime(_startedAt).isBefore(cutoff)) {
      _frames.removeAt(0);
    }
  }

  String _elapsed() {
    final ms = _now().difference(_startedAt).inMilliseconds;
    return '${(ms / 1000).toStringAsFixed(3)}s';
  }

  DateTime _now() {
    return (_options.now ?? DateTime.now).call().toUtc();
  }

  void _startFlushTimer() {
    final interval = _options.replay.flushInterval;
    if (interval == null || interval <= Duration.zero) {
      return;
    }
    _flushTimer = Timer.periodic(interval, (_) {
      unawaited(flush('manual'));
    });
  }

  void _clear() {
    _events.clear();
    _frames.clear();
  }

  bool get _maskText =>
      _options.replay.maskText ??
      _options.replay.privacy == JayTraceReplayPrivacy.maskAll;

  String _safe(String value, {required bool mask}) {
    final trimmed = value.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (mask && trimmed.isNotEmpty) {
      return 'redacted';
    }
    return trimmed.length <= 120 ? trimmed : trimmed.substring(0, 120);
  }

  String _networkLine(JayTraceNetworkEvent event) {
    final status = event.status != null ? ' status=${event.status}' : '';
    final duration = event.duration != null
        ? ' durationMs=${event.duration!.inMilliseconds}'
        : '';
    final error = event.error != null
        ? ' error=${_safe(event.error!, mask: _maskText)}'
        : '';
    return '${event.method.toUpperCase()} ${_safe(event.url.toString(), mask: _maskText)}$status$duration$error';
  }

  bool _isNetworkFailure(JayTraceNetworkEvent event) {
    return event.error != null ||
        (event.status != null && event.status! >= 500);
  }

  /// `fetch <METHOD> <url> status=<n> durationMs=<n>` (or `... failed ...
  /// error=<name>`) — mirrors the browser-sdk fetch timeline line.
  String _timelineFetchText(JayTraceNetworkEvent event) {
    final method = event.method.toUpperCase();
    final url = _safe(event.url.toString(), mask: _maskText);
    final duration = event.duration != null
        ? ' durationMs=${event.duration!.inMilliseconds}'
        : '';
    if (event.error != null) {
      return 'fetch $method $url failed$duration '
          'error=${_safe(event.error!, mask: _maskText)}';
    }
    final status = event.status != null ? ' status=${event.status}' : '';
    return 'fetch $method $url$status$duration';
  }

  /// Parses a captured body for structured attach on a timeline `fetch` event:
  /// truncates to the cap, then decodes JSON objects/arrays when possible so the
  /// console renders structured `data`; otherwise keeps the (capped) string.
  /// Sensitive-key masking is applied later by the timeline buffer.
  Object? _captureBodyValue(String body) {
    var out = body;
    if (out.length > _captureBodyMaxBytes) {
      out = '${out.substring(0, _captureBodyMaxBytes)}[truncated]';
    }
    try {
      final decoded = jsonDecode(out);
      if (decoded is Map || decoded is List) {
        return decoded;
      }
    } catch (_) {
      // not JSON — fall through to the raw (capped) string.
    }
    return out;
  }

  /// Recursively masks sensitive keys/strings in a structured timeline payload,
  /// reusing [_isSensitiveKey] and [_redactBodyString]. No-op when redaction is
  /// disabled.
  Map<String, Object?> _maskDataMap(Map<String, Object?> data) {
    if (!_options.replay.redactionEnabled) {
      return data;
    }
    return _maskValue(data) as Map<String, Object?>;
  }

  Object? _maskValue(Object? value) {
    if (value is Map) {
      final out = <String, Object?>{};
      value.forEach((key, item) {
        final name = key.toString();
        out[name] = _isSensitiveKey(name) ? 'redacted' : _maskValue(item);
      });
      return out;
    }
    if (value is List) {
      return value.map(_maskValue).toList();
    }
    if (value is String) {
      return _redactBodyString(value);
    }
    return value;
  }

  bool get _captureBodyEnabled {
    final value = _options.replay.captureBody;
    return value == true || (value is int && value > 0);
  }

  int get _captureBodyMaxBytes {
    final value = _options.replay.captureBody;
    return value is int && value > 0 ? value : 8192;
  }

  /// Records a captured request/response body as a dedicated `network-body`
  /// event line. The v1 replay schema stores events as opaque strings with no
  /// per-event body field, so bodies are appended as their own line (each
  /// capped at 1KB) rather than mutating the network event or the schema.
  void _recordNetworkBody(
      String direction, String method, Uri url, String body) {
    if (!_captureBodyEnabled) {
      return;
    }
    final captured = _captureBodyText(body, _captureBodyMaxBytes);
    _captureFrame(_add('network', _networkBodyLine(direction, method, url, captured)));
  }

  String _captureBodyText(String text, int maxBytes) {
    var out = text;
    if (out.length > maxBytes) {
      out = '${out.substring(0, maxBytes)}[truncated]';
    }
    if (_options.replay.redactionEnabled) {
      out = _redactBodyString(out);
    }
    return out;
  }

  String _networkBodyLine(
      String direction, String method, Uri url, String body) {
    final safeUrl = _safe(url.toString(), mask: _maskText);
    var collapsed = body.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (collapsed.length > 1024) {
      collapsed = collapsed.substring(0, 1024);
    }
    return 'network-body $direction ${method.toUpperCase()} $safeUrl $collapsed';
  }

  /// Ports core redaction.redactString: masks `key=value` assignments for
  /// sensitive keys and bare `Bearer <token>` values inside a freeform body.
  String _redactBodyString(String value) {
    return value
        .replaceAllMapped(_sensitiveAssignmentRe,
            (match) => '${match.group(1)}=redacted')
        .replaceAll(_bearerRe, 'Bearer redacted');
  }

  Map<String, Object?> _safeMetadata(Map<String, Object?> metadata) {
    final redact = _options.replay.redactionEnabled;
    final result = <String, Object?>{};
    for (final entry in metadata.entries) {
      final value = entry.value;
      if (value == null || value is String || value is num || value is bool) {
        result[entry.key] =
            (redact && _isSensitiveKey(entry.key)) ? 'redacted' : value;
      }
    }
    return result;
  }

  bool _isSensitiveKey(String key) {
    final sensitive = <String>{
      'apikey',
      'api',
      'key',
      'authorization',
      'auth',
      'cookie',
      'password',
      'passwd',
      'secret',
      'token',
      ..._options.replay.sensitiveKeys.map((k) => k.toLowerCase()),
    };
    return key
        .toLowerCase()
        .split(RegExp(r'[_\.\s-]+'))
        .any(sensitive.contains);
  }
}

final RegExp _sensitiveAssignmentRe = RegExp(
  r'''\b(password|passwd|token|authorization|cookie|set-cookie|apiKey|api_key|x-api-key|secret)\b\s*[:=]\s*("[^"]*"|'[^']*'|Bearer\s+[^\s,;]+|[^\s,;]+)''',
  caseSensitive: false,
);

final RegExp _bearerRe = RegExp(r'\bBearer\s+[A-Za-z0-9._~+/=-]+');

int _base64ByteLength(String value) {
  final padding = value.endsWith('==')
      ? 2
      : value.endsWith('=')
          ? 1
          : 0;
  return ((value.length * 3) ~/ 4) - padding;
}

Future<T?> runJayTraceGuarded<T>(
  JayTraceFlutterReplay? replay,
  FutureOr<T> Function() body, {
  void Function(Object error, StackTrace stackTrace)? onError,
}) {
  return runZonedGuarded<Future<T?>>(
        () async => body(),
        (error, stackTrace) {
          unawaited(replay?.recordError(error, stackTrace: stackTrace));
          onError?.call(error, stackTrace);
        },
      ) ??
      Future<T?>.value();
}

bool _sampleRate(double rate) {
  final clamped = rate.clamp(0, 100).toDouble();
  return clamped >= 100 || Random().nextDouble() * 100 < clamped;
}

bool _shouldTrace(Uri url, List<String>? traceOrigins) {
  if (traceOrigins == null || traceOrigins.isEmpty) {
    return true;
  }
  final origin =
      '${url.scheme}://${url.host}${url.hasPort ? ':${url.port}' : ''}';
  return traceOrigins
      .map((value) => value.replaceFirst(RegExp(r'/$'), ''))
      .contains(origin);
}

class _ReplayFrame {
  const _ReplayFrame(this.event, this.screenshot, [this.point]);

  final _ReplayEvent event;
  final JayTraceScreenshotFrame screenshot;
  final _ReplayPoint? point;

  Map<String, Object?> get json => {
        'at': event.at,
        'kind': event.kind,
        'text': event.text,
        'type': 'image',
        'image': screenshot.image,
        'mediaType': screenshot.mediaType,
        if (screenshot.width != null) 'width': screenshot.width,
        if (screenshot.height != null) 'height': screenshot.height,
        if (point != null) 'x': point!.x,
        if (point != null) 'y': point!.y,
      };
}

class _ReplayPoint {
  const _ReplayPoint(this.x, this.y);

  final int x;
  final int y;
}

class _ReplayEvent {
  const _ReplayEvent(this.at, this.kind, this.text);

  final String at;
  final String kind;
  final String text;

  String get line => '$at $kind $text';

  DateTime absoluteTime(DateTime startedAt) {
    final seconds = double.tryParse(at.replaceAll('s', '')) ?? 0;
    return startedAt.add(Duration(milliseconds: (seconds * 1000).round()));
  }
}

String _modeName(JayTraceReplayMode mode) {
  switch (mode) {
    case JayTraceReplayMode.always:
      return 'always';
    case JayTraceReplayMode.onError:
      return 'on-error';
    case JayTraceReplayMode.off:
      return 'off';
  }
}

_Traceparent _traceparent(String? value, String? traceId) {
  if (value != null) {
    final parts = value.split('-');
    if (parts.length == 4 && parts[1].length == 32 && parts[2].length == 16) {
      return _Traceparent(parts[1], value);
    }
  }
  final id = traceId ?? _hex(16);
  return _Traceparent(id, '00-$id-${_hex(8)}-01');
}

String _hex(int bytes) {
  final random = Random.secure();
  return List<int>.generate(bytes, (_) => random.nextInt(256))
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
}

// Datadog-style sessionization (mirrors packages/core/src/session.ts): a new
// session starts after 15 minutes of inactivity or 4 hours since it began. The
// id reuses the existing 16-byte hex generator.
const int _sessionTimeoutMs = 15 * 60 * 1000;
const int _sessionMaxDurationMs = 4 * 60 * 60 * 1000;

class _JayTraceSession {
  _JayTraceSession(this.id, this.startedAtMs, this.lastActivityAtMs);

  final String id;
  final int startedAtMs;
  int lastActivityAtMs;
}

_JayTraceSession? _jayTraceSession;

/// Records activity and returns the active session id, rotating an expired one.
/// [nowMs] is injectable for tests. Public (no leading underscore) so
/// test/self_check.dart can reach it — Dart library privacy would otherwise
/// hide a `_`-prefixed top-level function from the test library.
String jayTraceTouchSession({int Function()? nowMs}) {
  final at = nowMs != null ? nowMs() : DateTime.now().millisecondsSinceEpoch;
  final current = _jayTraceSession;
  if (current == null ||
      at - current.lastActivityAtMs > _sessionTimeoutMs ||
      at - current.startedAtMs > _sessionMaxDurationMs) {
    // ponytail: in-memory only, persist via shared_preferences if cross-restart sessions matter
    final fresh = _JayTraceSession(_hex(16), at, at);
    _jayTraceSession = fresh;
    return fresh.id;
  }
  current.lastActivityAtMs = at;
  return current.id;
}

class _Traceparent {
  const _Traceparent(this.traceId, this.value);

  final String traceId;
  final String value;
}
