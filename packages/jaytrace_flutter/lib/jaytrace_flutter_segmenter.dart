/// Pure-Dart port of packages/replay-core/src/segmenter.ts.
/// dart:core only — no flutter import, must compile under `dart run`.
library jaytrace_flutter_segmenter;

import 'dart:convert';
import 'dart:math';

/// Result of [JayTraceReplaySegmenter.add]: "buffered" | "flush" | "session-ended".
typedef JayTraceSegmenterAddResult = String;

class JayTraceReplaySegmenter {
  JayTraceReplaySegmenter({
    required this.flushMs,
    required this.maxBytes,
    required this.maxSessionMs,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now {
    _sessionStartedAt = _now();
    _segmentStartedAt = _sessionStartedAt;
  }

  final int flushMs;
  final int maxBytes;
  final int maxSessionMs;
  final DateTime Function() _now;
  late final DateTime _sessionStartedAt;
  late DateTime _segmentStartedAt;
  final List<Object?> _events = [];
  int _bytes = 0;
  int _nextSeq = 0;
  bool _ended = false;

  int get seq => _nextSeq;

  JayTraceSegmenterAddResult add(Object? frame, int byteEstimate) {
    if (_ended) {
      return 'session-ended';
    }

    final current = _now();
    if (_events.isEmpty) {
      _segmentStartedAt = current;
    }
    _events.add(frame);
    _bytes += byteEstimate;

    // ponytail: push the frame before checking maxSessionMs so the frame
    // that trips session end is still part of the drained tail, matching
    // segmenter.ts's push-then-check order (not silently dropped).
    if (current.difference(_sessionStartedAt).inMilliseconds >= maxSessionMs) {
      _ended = true;
      return 'session-ended';
    }

    if (_bytes >= maxBytes ||
        current.difference(_segmentStartedAt).inMilliseconds >= flushMs) {
      return 'flush';
    }
    return 'buffered';
  }

  ({int seq, List<Object?> items, DateTime startedAt, DateTime endedAt})?
      drain() {
    if (_events.isEmpty) {
      return null;
    }
    final drained = (
      seq: _nextSeq,
      items: List<Object?>.of(_events),
      startedAt: _segmentStartedAt,
      endedAt: _now(),
    );
    _nextSeq += 1;
    _events.clear();
    _bytes = 0;
    _segmentStartedAt = _now();
    return drained;
  }
}

/// Ports decideReplaySampling from segmenter.ts (rate>=1 always true,
/// rate<=0 always false, else random()<rate) PLUS the Flutter-side legacy
/// rule: rate>1 is treated as a percent (rate/100) before the decision.
/// In the TS stack this normalization lives in replay-web's `normalize`
/// layer, not in `decideReplaySampling` itself; there is no separate
/// normalize layer on the Dart side, so it is folded in here.
bool decideJayTraceReplaySampling(double sampleRate,
    {double Function()? random}) {
  final normalized = sampleRate > 1 ? sampleRate / 100 : sampleRate;
  if (normalized >= 1) return true;
  if (normalized <= 0) return false;
  final rand = random ?? _defaultRandom;
  return rand() < normalized;
}

double _defaultRandom() => Random().nextDouble();

class JayTraceErrorTailBuffer {
  JayTraceErrorTailBuffer({required this.maxEvents, this.maxBytes});

  final int maxEvents;

  /// Optional running byte budget (ports segmenter.ts ErrorTailBuffer.maxBytes).
  /// Null leaves the buffer bounded by [maxEvents] only.
  final int? maxBytes;

  final List<_TailItem> _items = [];
  int _bytes = 0;

  /// Appends an event, tracking a per-item byte estimate and a running sum.
  /// [byteEstimate] lets callers pass a size they already computed (e.g. the
  /// wireframe coordinator's frame JSON length); when omitted it is derived
  /// from the event. Ports segmenter.ts's push-then-evict-oldest-first order.
  void add(Object? e, [int? byteEstimate]) {
    final bytes = byteEstimate ?? _estimateBytes(e);
    _items.add(_TailItem(e, bytes));
    _bytes += bytes;
    // Evict oldest-first past either cap, but never the last remaining item: a
    // single oversized event is kept as-is since the client cannot split it.
    while (_items.length > 1 &&
        (_items.length > maxEvents ||
            (maxBytes != null && _bytes > maxBytes!))) {
      final evicted = _items.removeAt(0);
      _bytes -= evicted.bytes;
    }
  }

  List<Object?> drainTail() {
    final tail = _items.map((item) => item.event).toList();
    _items.clear();
    _bytes = 0;
    return tail;
  }
}

class _TailItem {
  const _TailItem(this.event, this.bytes);

  final Object? event;
  final int bytes;
}

int _estimateBytes(Object? event) {
  try {
    return jsonEncode(event).length;
  } catch (_) {
    return 64;
  }
}
