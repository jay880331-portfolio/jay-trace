/// Wireframe capture engine: serializes the render tree to vector primitives
/// (rect/text/image) and drives segment upload. Imports flutter/rendering, so
/// this file must NOT be imported by jaytrace_flutter.dart (which stays pure
/// Dart for `dart run test/self_check.dart`). Wiring happens from the widgets
/// layer via the JayTraceWireframeHook interface.
library jaytrace_flutter_wireframe;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

import 'jaytrace_flutter.dart';
import 'jaytrace_flutter_segmenter.dart';

const int _maxNodes = 1000;
const int _maxDepth = 40;
const int _maxFrameBytes = 32 * 1024;
const int _maxSessionMs = 1800000;

/// Walks the render tree from [root] (default `WidgetsBinding.instance.rootElement`)
/// and returns JSON-serializable wireframe nodes in paint order (parent→child).
/// Only on-screen, attached, sized RenderBoxes are emitted. When [maskText] is
/// true, text nodes carry only the character count (no `text`).
List<Map<String, Object?>> captureJayTraceWireframe({
  Element? root,
  required bool maskText,
}) {
  final element = root ?? WidgetsBinding.instance.rootElement;
  final renderObject = element?.renderObject;
  if (renderObject == null) {
    return const [];
  }
  final screen = Offset.zero & _viewportSize();
  final nodes = <Map<String, Object?>>[];
  _walk(renderObject, screen, maskText, nodes, 0);
  return nodes;
}

Size _viewportSize() {
  final view = WidgetsBinding.instance.platformDispatcher.implicitView;
  if (view == null) {
    return Size.zero;
  }
  return MediaQueryData.fromView(view).size;
}

void _walk(
  RenderObject object,
  Rect screen,
  bool maskText,
  List<Map<String, Object?>> nodes,
  int depth,
) {
  // `depth` counts nesting of *emitted* primitives, not raw render objects: a
  // bare MaterialApp already stacks 30+ proxy/render layers before any content,
  // so a raw cap of 40 would never reach a button's label. The 1000-node cap
  // bounds total traversal work.
  if (depth > _maxDepth || nodes.length >= _maxNodes) {
    return;
  }
  var emitted = false;
  if (object is RenderBox && object.attached && object.hasSize) {
    final size = object.size;
    // Text nodes can legitimately have zero width (e.g. an empty string) but
    // still carry a meaningful `chars` count and vertical footprint — only
    // gate width>0 for non-text boxes (rects/images truly have no footprint
    // at zero width).
    if (size.height > 0 && (size.width > 0 || object is RenderParagraph)) {
      Offset? origin;
      try {
        origin = object.localToGlobal(Offset.zero);
      } catch (_) {
        // Not composited yet (no ancestor transform) — skip emitting this
        // box's node (position would be a phantom at 0,0) but keep walking
        // children in case they resolve independently.
        origin = null;
      }
      if (origin != null) {
        final rect = origin & size;
        if (screen.isEmpty || rect.overlaps(screen)) {
          final node = _nodeFor(object, rect, maskText);
          if (node != null) {
            nodes.add(node);
            emitted = true;
          }
        }
      }
    }
  }
  final childDepth = emitted ? depth + 1 : depth;
  object.visitChildren((child) => _walk(child, screen, maskText, nodes, childDepth));
}

Map<String, Object?>? _nodeFor(RenderBox box, Rect rect, bool maskText) {
  final base = <String, Object?>{
    'x': rect.left.round(),
    'y': rect.top.round(),
    'w': rect.width.round(),
    'h': rect.height.round(),
  };

  if (box is RenderParagraph) {
    final span = box.text;
    final text = span.toPlainText();
    final style = span.style;
    return {
      'type': 'text',
      ...base,
      'chars': text.characters.length,
      if (style?.fontSize != null) 'fontSize': style!.fontSize!.round(),
      if (style?.color != null) 'color': _hex(style!.color!),
      if (!maskText) 'text': text,
    };
  }

  if (box is RenderImage) {
    return {'type': 'image', ...base};
  }

  if (box is RenderDecoratedBox) {
    final decoration = box.decoration;
    if (decoration is BoxDecoration) {
      final radius = _radiusOf(decoration.borderRadius);
      return {
        'type': 'rect',
        ...base,
        if (decoration.color != null) 'bg': _hex(decoration.color!),
        if (radius != null && radius > 0) 'radius': radius,
      };
    }
    return null;
  }

  // Material elevation boxes (buttons, cards, Scaffold background) paint a solid
  // rounded fill — the visible primitive users see. RenderDecoratedBox alone
  // misses them, so treat physical model/shape as rect nodes too.
  if (box is RenderPhysicalModel) {
    final radius = _radiusOf(box.borderRadius);
    return {
      'type': 'rect',
      ...base,
      'bg': _hex(box.color),
      if (radius != null && radius > 0) 'radius': radius,
    };
  }
  if (box is RenderPhysicalShape) {
    return {'type': 'rect', ...base, 'bg': _hex(box.color)};
  }

  return null;
}

double? _radiusOf(BorderRadiusGeometry? borderRadius) {
  if (borderRadius == null) {
    return null;
  }
  return borderRadius.resolve(TextDirection.ltr).topLeft.x;
}

String _hex(Color color) =>
    '#${(color.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}';

class _CapturedFrame {
  const _CapturedFrame(this.at, this.frame);

  final DateTime at;
  final Map<String, Object?> frame; // viewport/pointer/nodes, no atMs yet
}

/// Coordinates periodic + event-driven wireframe capture and segment upload.
/// Created by the widgets layer when `engine == "wireframe"`; wired into the
/// replay through [JayTraceWireframeHook].
class JayTraceWireframeCoordinator implements JayTraceWireframeHook {
  JayTraceWireframeCoordinator({
    required JayTraceFlutterReplay replay,
    DateTime Function()? now,
    Element? Function()? rootProvider,
  })  : _replay = replay,
        _now = now ?? DateTime.now,
        _rootProvider = rootProvider {
    final options = replay.replayOptions;
    _continuous = replay.replayMode == JayTraceReplayMode.always &&
        decideJayTraceReplaySampling(options.sampleRate);
    if (_continuous) {
      _segmenter = JayTraceReplaySegmenter(
        flushMs: options.segmentFlushMs,
        maxBytes: options.maxSegmentBytes,
        maxSessionMs: _maxSessionMs,
        now: _now,
      );
    } else {
      _tail = JayTraceErrorTailBuffer(
        maxEvents: options.maxEvents,
        // Stay within the collector's ~1MB per-request budget with headroom.
        maxBytes: 786432,
      );
    }
  }

  final JayTraceFlutterReplay _replay;
  final DateTime Function() _now;
  final Element? Function()? _rootProvider;

  late final bool _continuous;
  JayTraceReplaySegmenter? _segmenter;
  JayTraceErrorTailBuffer? _tail;

  /// After this many consecutive dedup-identical periodic captures, stop the
  /// timer instead of forcing scheduleFrame() + a full tree walk on every
  /// idle tick. The spec frames the idle window as 5 minutes of wall clock,
  /// but consecutive-identical-frame count is the right mechanism here: it's
  /// driven by actual paint content (not affected by a custom
  /// wireframeIntervalMs) and it's what dedup already tracks. 6 is short
  /// (~5s at the 800ms default) on purpose — a static screen should stop
  /// forcing frames quickly, and any real change (route/tap) resumes
  /// full-rate capture immediately via capture() below.
  static const int _idlePauseAfterIdentical = 6;

  Timer? _timer;

  /// Segment-scoped emit-dedup hash: a captured frame equal to it is already
  /// represented in the current (not-yet-drained) segment and is skipped. Reset
  /// to null on every drain so the next segment keeps its opening frame.
  int? _lastHash;

  /// Idle-detection hash: tracks consecutive identical *content* independently
  /// of segment boundaries (survives drains), so a static screen still
  /// auto-pauses the periodic timer even after a segment flush resets
  /// [_lastHash].
  int? _idleHash;
  int _consecutiveIdentical = 0;
  bool _frameDropped = false;
  bool _resumed = false;
  bool _disposed = false;

  @override
  void resume() {
    if (_disposed || _timer != null) {
      return;
    }
    _resumed = true;
    _consecutiveIdentical = 0;
    _startTimer();
  }

  void _startTimer() {
    if (_disposed || _timer != null) {
      return;
    }
    final intervalMs = _replay.replayOptions.wireframeIntervalMs;
    if (intervalMs > 0) {
      _timer = Timer.periodic(Duration(milliseconds: intervalMs), (_) => capture());
    }
  }

  @override
  void pause() {
    _resumed = false;
    _timer?.cancel();
    _timer = null;
  }

  @override
  void capture({int? x, int? y}) {
    if (_disposed) {
      return;
    }
    if (_resumed && _timer == null) {
      // Timer was idle-auto-paused (see _noteIdenticalCapture); a real
      // signal (route change or tap — the only other callers of capture())
      // means the screen isn't idle anymore, so resume periodic capture.
      _startTimer();
    }
    SchedulerBinding.instance.addPostFrameCallback((_) => _runCapture(x, y));
    // Kick a frame so the post-frame callback fires even when the tree is idle.
    SchedulerBinding.instance.scheduleFrame();
  }

  void _noteIdenticalCapture() {
    if (_timer == null) {
      return; // already stopped (idle-paused or lifecycle-paused)
    }
    _consecutiveIdentical++;
    if (_consecutiveIdentical >= _idlePauseAfterIdentical) {
      _timer?.cancel();
      _timer = null;
      _consecutiveIdentical = 0;
    }
  }

  void _runCapture(int? x, int? y) {
    if (_disposed) {
      return;
    }
    List<Map<String, Object?>> nodes;
    try {
      nodes = captureJayTraceWireframe(
        root: _rootProvider?.call(),
        maskText: _replay.maskText,
      );
    } catch (_) {
      return;
    }
    if (nodes.isEmpty) {
      return;
    }
    final hash = jsonEncode(nodes).hashCode;

    // Idle detection is segment-independent: count consecutive identical
    // content against the persistent [_idleHash] so a static screen auto-pauses
    // the timer even though [_lastHash] is reset on every drain.
    if (hash == _idleHash) {
      _noteIdenticalCapture();
    } else {
      _idleHash = hash;
      _consecutiveIdentical = 0;
    }

    // Emit dedup is segment-scoped: skip a frame already represented in the
    // current segment. After a drain [_lastHash] is null, so the first frame of
    // the new segment is always emitted (never lost as a cross-segment dup).
    if (hash == _lastHash) {
      return;
    }

    final size = _viewportSize();
    final frame = <String, Object?>{
      'viewport': {'width': size.width.round(), 'height': size.height.round()},
      if (x != null && y != null) 'pointer': {'x': x, 'y': y, 'kind': 'tap'},
      'nodes': nodes,
    };
    final byteEstimate = jsonEncode(frame).length;
    if (byteEstimate > _maxFrameBytes) {
      _frameDropped = true; // surfaced in segment metadata
      return;
    }
    _lastHash = hash;

    final captured = _CapturedFrame(_now(), frame);
    if (_continuous) {
      final result = _segmenter!.add(captured, byteEstimate);
      if (result == 'flush' || result == 'session-ended') {
        unawaited(_drainSegmenter('segment'));
      }
    } else {
      _tail!.add(captured, byteEstimate);
    }
  }

  Future<void> _drainSegmenter(String reason) async {
    final drained = _segmenter!.drain();
    if (drained == null) {
      return;
    }
    // Reset dedup hash after draining so the next segment's first frame is
    // never skipped as a duplicate of the segment we just drained — otherwise a
    // static screen loses its opening frame on every new segment.
    _lastHash = null;
    await _send(
      seq: drained.seq,
      startedAt: drained.startedAt,
      endedAt: drained.endedAt,
      captured: drained.items,
      reason: reason,
    );
  }

  @override
  Future<void> flushOnError() async {
    if (_disposed) {
      return;
    }
    if (_continuous) {
      await _drainSegmenter('error');
      return;
    }
    final tail = _tail!.drainTail();
    if (tail.isEmpty) {
      return;
    }
    // Same dedup reset as the segment path: the next capture after an error
    // flush must not be deduped against the tail we just drained.
    _lastHash = null;
    final startedAt = (tail.first as _CapturedFrame).at;
    final endedAt = (tail.last as _CapturedFrame).at;
    await _send(
      seq: 0,
      startedAt: startedAt,
      endedAt: endedAt,
      captured: tail,
      reason: 'error',
      extraMeta: const {'replay.reason': 'error', 'replay.sampled': false},
    );
  }

  Future<void> _send({
    required int seq,
    required DateTime startedAt,
    required DateTime endedAt,
    required List<Object?> captured,
    required String reason,
    Map<String, Object?>? extraMeta,
  }) async {
    final frames = <Map<String, Object?>>[];
    for (final item in captured) {
      final c = item as _CapturedFrame;
      final atMs = c.at.difference(startedAt).inMilliseconds;
      frames.add({'atMs': atMs < 0 ? 0 : atMs, ...c.frame});
    }
    final meta = <String, Object?>{
      'replay.sampled': _continuous,
      if (_frameDropped) 'replay.frame.dropped': true,
      ...?extraMeta,
    };
    await _replay.sendWireframeSegment(
      seq: seq,
      startedAt: startedAt,
      endedAt: endedAt,
      frames: frames,
      reason: reason,
      extraMeta: meta,
    );
    // Per-segment: the flag must only describe frames that were dropped
    // while building THIS drained segment, not stick for the rest of the
    // session once any one frame anywhere exceeded the size cap.
    _frameDropped = false;
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
  }

  /// Test/diagnostic: whether the periodic timer is active.
  bool get isRunning => _resumed && _timer != null;
}
