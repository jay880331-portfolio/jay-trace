library jaytrace_flutter_timeline;

/// Sends a `{apiKey, reason, document}` POST and reports success. Injected by
/// [JayTraceFlutterReplay] so this file stays free of transport/identity code
/// and runs under `dart run`.
typedef JayTraceTimelinePoster = Future<bool> Function(
  String reason,
  Map<String, Object?> document,
);

/// Masks sensitive keys inside a structured payload. Injected so the buffer
/// reuses the replay's `_isSensitiveKey` / body redaction logic.
typedef JayTraceTimelineMask = Map<String, Object?> Function(
  Map<String, Object?> data,
);

/// A single console-timeline event mirroring core `TimelineEvent`
/// (at/kind/severity/text[/durationMs/data]).
class JayTraceTimelineEvent {
  JayTraceTimelineEvent({
    required this.at,
    required this.kind,
    required this.severity,
    required this.text,
    this.data,
    this.durationMs,
  });

  final String at;
  final String kind;
  final String severity;
  final String text;
  final Map<String, Object?>? data;
  final int? durationMs;

  /// `"<at> <kind> <severity> <text>"` — matches core `formatTimelineLine`.
  String get line => '$at $kind $severity $text'.trim();

  Map<String, Object?> get json => {
        'at': at,
        'kind': kind,
        'severity': severity,
        'text': text,
        if (durationMs != null) 'durationMs': durationMs,
        if (data != null) 'data': data,
      };
}

/// Rolling buffer of console-timeline events. Emits a `jaytrace.timeline.v1`
/// document (string `timeline` + structured `events`) via the injected poster.
class JayTraceTimelineBuffer {
  JayTraceTimelineBuffer({
    required this.traceId,
    required this.sessionId,
    required this.service,
    this.traceparent,
    required DateTime Function() now,
    required JayTraceTimelinePoster post,
    required JayTraceTimelineMask maskData,
    this.maxEvents = 80,
  })  : _now = now,
        _post = post,
        _maskData = maskData,
        _startedAt = now().toUtc();

  final String traceId;
  final String sessionId;
  final String service;
  final String? traceparent;
  final int maxEvents;

  final DateTime Function() _now;
  final JayTraceTimelinePoster _post;
  final JayTraceTimelineMask _maskData;
  final DateTime _startedAt;
  final List<JayTraceTimelineEvent> _events = <JayTraceTimelineEvent>[];

  Map<String, Object?>? _user;
  bool _flushing = false;
  String? _pendingReason;

  void addText(
    String kind,
    String text, {
    String severity = 'info',
    Map<String, Object?>? data,
    int? durationMs,
  }) {
    _events.add(JayTraceTimelineEvent(
      at: _elapsed(),
      kind: kind,
      severity: severity,
      text: text,
      data: data == null ? null : _maskData(data),
      durationMs: durationMs,
    ));
    while (_events.length > maxEvents) {
      _events.removeAt(0);
    }
  }

  void addError(String text) {
    addText('error', text, severity: 'error');
  }

  void setUser(Map<String, Object?>? user) {
    _user = user == null ? null : _maskData(user);
  }

  Map<String, Object?> snapshot() {
    return <String, Object?>{
      'schema': 'jaytrace.timeline.v1',
      'service': service,
      'side': 'front',
      'traceId': traceId,
      'sessionId': sessionId,
      if (traceparent != null) 'traceparent': traceparent,
      'startedAt': _startedAt.toIso8601String(),
      'endedAt': _now().toUtc().toIso8601String(),
      'summary': _summary(),
      'timeline': _events.map((event) => event.line).toList(),
      'events': _events.map((event) => event.json).toList(),
      if (_user != null) 'user': _user,
    };
  }

  /// POSTs the timeline document; clears the buffer only on send success.
  /// Re-entrant flushes merge into a single trailing flush; failures are silent.
  Future<void> flush(String reason) async {
    if (_flushing) {
      _pendingReason = reason;
      return;
    }
    if (_events.isEmpty) {
      return;
    }
    _flushing = true;
    try {
      if (await _post(reason, snapshot())) {
        _events.clear();
      }
    } catch (_) {
      // silent: bookkeeping must never surface into the host app.
    } finally {
      _flushing = false;
      final pending = _pendingReason;
      _pendingReason = null;
      if (pending != null) {
        await flush(pending);
      }
    }
  }

  String _summary() {
    for (final event in _events) {
      if (event.severity == 'fatal' || event.severity == 'error') {
        return event.text;
      }
    }
    return _events.isEmpty ? 'Flutter timeline captured.' : _events.last.text;
  }

  String _elapsed() {
    final ms = _now().difference(_startedAt).inMilliseconds;
    return '${(ms / 1000).toStringAsFixed(3)}s';
  }
}
