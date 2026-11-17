library jaytrace_flutter_widgets;

import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';
import 'package:jaytrace_flutter/jaytrace_flutter.dart';

import 'jaytrace_flutter_sender.dart';
import 'jaytrace_flutter_wireframe.dart';

export 'jaytrace_flutter_sender.dart' show jayTraceHttpSender;

const int _defaultMaxScreenshotBytes = 320000;

class JayTraceFlutterErrorHandlers {
  const JayTraceFlutterErrorHandlers._(
    this._previousFlutter,
    this._previousPlatform,
    this._installed,
  );

  final FlutterExceptionHandler? _previousFlutter;
  final ui.ErrorCallback? _previousPlatform;
  final bool _installed;

  void uninstall() {
    if (!_installed) {
      return;
    }
    FlutterError.onError = _previousFlutter;
    ui.PlatformDispatcher.instance.onError = _previousPlatform;
  }
}

class JayTraceFlutterWidgetsClient {
  const JayTraceFlutterWidgetsClient({
    required this.client,
    required this.errorHandlers,
    required this.lifecycleObserver,
  });

  final JayTraceFlutterClient client;
  final JayTraceFlutterErrorHandlers errorHandlers;
  final JayTraceLifecycleObserver lifecycleObserver;

  JayTraceFlutterReplay? get replay => client.replay;
  String get traceId => client.traceId;
  String get traceparent => client.traceparent;
  String get sessionId => client.sessionId;

  void setUser(Map<String, Object?>? user) {
    client.setUser(user);
  }

  void addAction(String name, {String? detail}) {
    client.addAction(name, detail: detail);
  }

  void addInput(String target) {
    client.addInput(target);
  }

  void addScroll(String target, {double? offset}) {
    client.addScroll(target, offset: offset);
  }

  void addPerformance(String name, Duration duration, {String? detail}) {
    client.addPerformance(name, duration, detail: detail);
  }

  void recordView(String name) {
    client.recordView(name);
  }

  void log(String level, String message, [Map<String, Object?>? context]) {
    client.log(level, message, context);
  }

  Map<String, String> headers([Map<String, String>? headers]) {
    return client.headers(headers);
  }

  Future<T> traceNetwork<T>({
    required String method,
    required Uri url,
    required Future<T> Function(Map<String, String> headers) run,
    int? Function(T result)? status,
    Map<String, String>? headers,
  }) {
    return client.traceNetwork(
      method: method,
      url: url,
      run: run,
      status: status,
      headers: headers,
    );
  }

  void dispose() {
    errorHandlers.uninstall();
    lifecycleObserver.uninstall();
    client.dispose();
  }
}

JayTraceFlutterWidgetsClient initJayTraceFlutterWidgets({
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
  final client = initJayTraceFlutter(
    apiKey: apiKey,
    endpoint: endpoint,
    sender: sender,
    traceId: traceId,
    sessionId: sessionId,
    traceparent: traceparent,
    traceOrigins: traceOrigins,
    release: release,
    environment: environment,
    metadata: metadata,
    replay: replay,
    screenshot: screenshot,
    now: now,
  );
  final activeReplay = client.replay;
  if (activeReplay != null && activeReplay.engine == 'wireframe') {
    // Route/tap triggers capture immediately; the periodic idle timer starts on
    // the first AppLifecycleState.resumed signal (see JayTraceLifecycleObserver).
    // Not started eagerly so a leaked Timer can't outlive a widget test.
    activeReplay.wireframe = JayTraceWireframeCoordinator(
      replay: activeReplay,
      now: now,
    );
  }
  return JayTraceFlutterWidgetsClient(
    client: client,
    errorHandlers: installJayTraceFlutterErrorHandler(client.replay),
    lifecycleObserver: installJayTraceLifecycleObserver(client.replay),
  );
}

class JayTraceLifecycleObserver extends WidgetsBindingObserver {
  JayTraceLifecycleObserver._(this._replay, this._installed);

  final JayTraceFlutterReplay? _replay;
  final bool _installed;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _replay?.wireframe?.resume();
      return;
    }
    if (state == AppLifecycleState.inactive ||
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      _replay?.wireframe?.pause();
      final replay = _replay;
      if (replay != null) {
        unawaited(replay.flush('manual'));
        unawaited(replay.flushTimeline('manual'));
      }
    }
  }

  void uninstall() {
    if (_installed) {
      WidgetsBinding.instance.removeObserver(this);
    }
  }
}

JayTraceLifecycleObserver installJayTraceLifecycleObserver(
  JayTraceFlutterReplay? replay,
) {
  final observer = JayTraceLifecycleObserver._(replay, replay != null);
  if (replay != null) {
    WidgetsBinding.instance.addObserver(observer);
  }
  return observer;
}

JayTraceFlutterErrorHandlers installJayTraceFlutterErrorHandler(
  JayTraceFlutterReplay? replay,
) {
  if (replay == null) {
    return const JayTraceFlutterErrorHandlers._(null, null, false);
  }

  final previousFlutter = FlutterError.onError;
  final previousPlatform = ui.PlatformDispatcher.instance.onError;
  FlutterError.onError = (details) {
    unawaited(replay.recordError(details.exception, stackTrace: details.stack));
    previousFlutter?.call(details);
  };
  ui.PlatformDispatcher.instance.onError = (error, stackTrace) {
    unawaited(replay.recordError(error, stackTrace: stackTrace));
    return previousPlatform?.call(error, stackTrace) ?? false;
  };
  return JayTraceFlutterErrorHandlers._(previousFlutter, previousPlatform, true);
}

JayTraceScreenshotProvider createJayTraceScreenshotProvider(
  GlobalKey boundaryKey, {
  FutureOr<bool> Function()? enabled,
  double pixelRatio = 0.5,
  int? maxBytes,
  Duration timeout = const Duration(seconds: 1),
}) {
  return () async {
    try {
      if (enabled != null && !await _screenshotEnabled(enabled)) {
        return null;
      }

      final context = boundaryKey.currentContext;
      final renderObject = context?.findRenderObject();
      if (renderObject is! RenderRepaintBoundary) {
        return null;
      }

      final image =
          await renderObject.toImage(pixelRatio: pixelRatio).timeout(timeout);
      final bytes = await image
          .toByteData(format: ui.ImageByteFormat.png)
          .timeout(timeout);
      if (bytes == null) {
        return null;
      }

      final data = bytes.buffer.asUint8List();
      if (data.length > (maxBytes ?? _defaultMaxScreenshotBytes)) {
        return null;
      }

      return JayTraceScreenshotFrame(
        image: 'data:image/png;base64,${base64Encode(data)}',
        width: image.width,
        height: image.height,
      );
    } catch (_) {
      return null;
    }
  };
}

Future<bool> _screenshotEnabled(FutureOr<bool> Function() enabled) async {
  try {
    return await enabled();
  } catch (_) {
    return false;
  }
}

class JayTraceReplayScreenshotBoundary extends StatelessWidget {
  const JayTraceReplayScreenshotBoundary({
    required this.boundaryKey,
    required this.child,
    super.key,
  });

  final GlobalKey boundaryKey;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      key: boundaryKey,
      child: child,
    );
  }
}

class JayTraceNavigatorObserver extends NavigatorObserver {
  JayTraceNavigatorObserver(this.replay);

  final JayTraceFlutterReplay? replay;
  final Map<Route<dynamic>, DateTime> _startedAt = <Route<dynamic>, DateTime>{};

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _record(route);
    super.didPush(route, previousRoute);
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    if (oldRoute != null) {
      _close(oldRoute);
    }
    if (newRoute != null) {
      _record(newRoute);
    }
    super.didReplace(newRoute: newRoute, oldRoute: oldRoute);
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _close(route);
    if (previousRoute != null) {
      _record(previousRoute);
    }
    super.didPop(route, previousRoute);
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _close(route);
    super.didRemove(route, previousRoute);
  }

  void _record(Route<dynamic> route) {
    _startedAt[route] = DateTime.now().toUtc();
    replay?.recordRoute(route.settings.name ?? route.runtimeType.toString());
  }

  void _close(Route<dynamic> route) {
    final startedAt = _startedAt.remove(route);
    if (startedAt == null) {
      return;
    }
    replay?.recordRouteEnd(
      route.settings.name ?? route.runtimeType.toString(),
      DateTime.now().toUtc().difference(startedAt),
    );
  }
}

class JayTraceReplayPointerBoundary extends StatelessWidget {
  const JayTraceReplayPointerBoundary({
    required this.replay,
    required this.child,
    this.target = 'screen',
    super.key,
  });

  final JayTraceFlutterReplay? replay;
  final Widget child;

  /// Tap target label. Pass `null` to auto-derive it from the wrapped [child]
  /// (key value, Semantics label, or runtimeType).
  final String? target;

  @override
  Widget build(BuildContext context) {
    return Listener(
      behavior: HitTestBehavior.translucent,
      onPointerDown: (event) {
        replay?.recordTap(
          target ?? jayTraceDeriveTapTarget(child),
          x: event.position.dx,
          y: event.position.dy,
        );
      },
      child: child,
    );
  }
}

/// Best-effort tap target label derived from a wrapped widget when the caller
/// does not supply an explicit target: a ValueKey's value, a Semantics label,
/// or the widget's runtimeType. Only the directly reachable widget is
/// inspected (no full-tree walk) so the result is deterministic and cheap.
String jayTraceDeriveTapTarget(Widget child) {
  final key = child.key;
  if (key is ValueKey) {
    final value = key.value;
    if (value != null) {
      final text = value.toString();
      if (text.isNotEmpty) {
        return text;
      }
    }
  }
  if (child is Semantics) {
    final label = child.properties.label;
    if (label != null && label.isNotEmpty) {
      return label;
    }
  }
  return child.runtimeType.toString();
}

class JayTraceReplayRoot extends StatelessWidget {
  const JayTraceReplayRoot({
    required this.boundaryKey,
    required this.replay,
    required this.child,
    this.target = 'screen',
    super.key,
  });

  final GlobalKey boundaryKey;
  final JayTraceFlutterReplay? replay;
  final Widget child;
  final String target;

  @override
  Widget build(BuildContext context) {
    return JayTraceReplayScreenshotBoundary(
      boundaryKey: boundaryKey,
      child: JayTraceReplayPointerBoundary(
        replay: replay,
        target: target,
        child: child,
      ),
    );
  }
}

class JayTraceReplayTap extends StatelessWidget {
  const JayTraceReplayTap({
    required this.replay,
    required this.child,
    this.target,
    this.onTap,
    super.key,
  });

  final JayTraceFlutterReplay? replay;

  /// Tap target label. When null, it is auto-derived from [child] via
  /// [jayTraceDeriveTapTarget] (key value, Semantics label, or runtimeType).
  final String? target;
  final Widget child;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onTapDown: (details) {
        final position = details.globalPosition;
        replay?.recordTap(
          target ?? jayTraceDeriveTapTarget(child),
          x: position.dx,
          y: position.dy,
        );
      },
      onTap: onTap,
      child: child,
    );
  }
}

/// Records a `view` element-exposure event the first time the wrapped [child]
/// becomes at least 50% visible on screen. Self-contained (no external
/// visibility package): it samples its own RenderBox against the screen bounds
/// after each frame and on scroll notifications, firing [recordView] exactly
/// once via the active [JayTrace] client.
///
/// When [name] is omitted it is derived from [child] via
/// [jayTraceDeriveTapTarget] (ValueKey value > Semantics label > runtimeType).
class JayTraceViewDetector extends StatefulWidget {
  const JayTraceViewDetector({
    required this.child,
    this.name,
    super.key,
  });

  /// Explicit view name. When null, derived from [child].
  final String? name;
  final Widget child;

  @override
  State<JayTraceViewDetector> createState() => _JayTraceViewDetectorState();
}

class _JayTraceViewDetectorState extends State<JayTraceViewDetector> {
  static const double _visibleThreshold = 0.5;
  bool _recorded = false;
  ScrollPosition? _position;

  @override
  void initState() {
    super.initState();
    _scheduleCheck();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Track the enclosing scrollable: its ScrollNotifications bubble past our
    // ancestors (not through a descendant NotificationListener), so we recheck
    // visibility off the position itself.
    final position = Scrollable.maybeOf(context)?.position;
    if (position != _position) {
      _position?.removeListener(_onScroll);
      _position = position;
      _position?.addListener(_onScroll);
    }
  }

  void _onScroll() {
    if (!_recorded) {
      _scheduleCheck();
    }
  }

  void _scheduleCheck() {
    WidgetsBinding.instance.addPostFrameCallback((_) => _check());
  }

  @override
  void dispose() {
    _position?.removeListener(_onScroll);
    super.dispose();
  }

  void _check() {
    if (_recorded || !mounted) {
      return;
    }
    final renderObject = context.findRenderObject();
    if (renderObject is! RenderBox || !renderObject.hasSize) {
      return;
    }
    final size = renderObject.size;
    final area = size.width * size.height;
    if (area <= 0) {
      return;
    }
    final topLeft = renderObject.localToGlobal(Offset.zero);
    final box = topLeft & size;
    final screen = _screenRect();
    if (screen == null) {
      return;
    }
    final overlap = box.intersect(screen);
    final visibleArea = overlap.width <= 0 || overlap.height <= 0
        ? 0.0
        : overlap.width * overlap.height;
    if (visibleArea / area < _visibleThreshold) {
      return;
    }
    _recorded = true;
    final name = widget.name ?? jayTraceDeriveTapTarget(widget.child);
    JayTrace.instance?.replay?.recordView(name);
  }

  Rect? _screenRect() {
    final media = MediaQuery.maybeOf(context);
    if (media != null) {
      return Offset.zero & media.size;
    }
    final view = View.maybeOf(context);
    if (view == null) {
      return null;
    }
    return Offset.zero & (view.physicalSize / view.devicePixelRatio);
  }

  @override
  Widget build(BuildContext context) {
    return NotificationListener<ScrollNotification>(
      onNotification: (_) {
        if (!_recorded) {
          _scheduleCheck();
        }
        return false;
      },
      child: widget.child,
    );
  }
}

ValueChanged<String> jayTraceReplayOnChanged(
  JayTraceFlutterReplay? replay,
  String target, [
  ValueChanged<String>? onChanged,
]) {
  return (value) {
    replay?.recordInput(target);
    onChanged?.call(value);
  };
}

class JayTrace {
  JayTrace._();

  static JayTraceFlutterWidgetsClient? instance;

  /// MaterialApp(navigatorObservers: [JayTrace.observer]) 용.
  /// init 전이면 no-op observer를 반환한다.
  static NavigatorObserver get observer =>
      JayTraceNavigatorObserver(instance?.client.replay);
}

Widget buildJayTraceRoot({
  required JayTraceFlutterWidgetsClient client,
  required GlobalKey boundaryKey,
  required Widget child,
}) {
  final replay = client.client.replay;
  if (replay == null) {
    return child;
  }
  return JayTraceReplayRoot(
    boundaryKey: boundaryKey,
    replay: replay,
    child: child,
  );
}

Future<void> runJayTrace(
  Widget Function() appBuilder, {
  String? apiKey,
  Uri? endpoint,
  JayTraceReplaySender? sender,
  List<String>? traceOrigins,
  String? release,
  String? environment,
  JayTraceFlutterReplayOptions replay =
      const JayTraceFlutterReplayOptions(enabled: true),
}) async {
  const envEndpoint = String.fromEnvironment('JAYTRACE_ENDPOINT');
  const envApiKey = String.fromEnvironment('JAYTRACE_API_KEY');
  const envRelease = String.fromEnvironment('JAYTRACE_RELEASE');
  const envEnvironment = String.fromEnvironment('JAYTRACE_ENVIRONMENT');
  const envTraceOrigins = String.fromEnvironment('JAYTRACE_TRACE_ORIGINS');
  const envReplayMode = String.fromEnvironment('JAYTRACE_REPLAY_MODE');
  const envSampleRate = String.fromEnvironment('JAYTRACE_REPLAY_SAMPLE_RATE');

  final resolvedEndpoint =
      endpoint ?? (envEndpoint.isEmpty ? null : Uri.tryParse(envEndpoint));
  final resolvedApiKey = apiKey ?? (envApiKey.isEmpty ? null : envApiKey);

  // dart-define overrides fill defaults the caller left unset; explicit args win.
  final resolvedReplay = replay.copyWith(
    mode: replay.mode == JayTraceReplayMode.onError
        ? _parseReplayMode(envReplayMode)
        : null,
    sampleRate: replay.sampleRate == 100
        ? (envSampleRate.isEmpty ? null : double.tryParse(envSampleRate))
        : null,
  );

  if (resolvedEndpoint == null || resolvedApiKey == null) {
    debugPrint(
      '[jaytrace] disabled: pass apiKey/endpoint or set '
      '--dart-define=JAYTRACE_API_KEY / JAYTRACE_ENDPOINT',
    );
    runApp(appBuilder());
    return;
  }

  final boundaryKey = GlobalKey();
  final client = initJayTraceFlutterWidgets(
    apiKey: resolvedApiKey,
    endpoint: resolvedEndpoint,
    sender: sender ?? jayTraceHttpSender,
    traceOrigins: traceOrigins ??
        (envTraceOrigins.isEmpty
            ? null
            : envTraceOrigins.split(',').map((s) => s.trim()).toList()),
    release: release ?? (envRelease.isEmpty ? null : envRelease),
    environment:
        environment ?? (envEnvironment.isEmpty ? null : envEnvironment),
    replay: resolvedReplay,
    // Wireframe (default) is a no-pixel, privacy-safe engine: the one-liner must
    // NOT auto-attach a screenshot provider for it (spec: screenshots are an
    // opt-in secondary, never always-on). Only the "screenshot" engine wires the
    // boundary capture.
    screenshot: resolvedReplay.engine == 'screenshot'
        ? createJayTraceScreenshotProvider(boundaryKey)
        : null,
  );
  JayTrace.instance = client;

  await runJayTraceGuarded(client.client.replay, () async {
    runApp(buildJayTraceRoot(
      client: client,
      boundaryKey: boundaryKey,
      child: appBuilder(),
    ));
  });
}

JayTraceReplayMode? _parseReplayMode(String value) {
  switch (value.trim().toLowerCase()) {
    case 'always':
      return JayTraceReplayMode.always;
    case 'on-error':
    case 'onerror':
      return JayTraceReplayMode.onError;
    case 'off':
      return JayTraceReplayMode.off;
    default:
      return null;
  }
}
