import 'package:jaytrace_flutter/jaytrace_flutter.dart';

import 'jaytrace_flutter_io_sender.dart'
    if (dart.library.js_interop) 'jaytrace_flutter_noop_sender.dart';

/// 기본 sender. 모바일/데스크톱은 dart:io HttpClient, web은 no-op(커스텀 sender 필요).
///
/// dart:ui/flutter widgets에 의존하지 않는 별도 파일에 둔다 — 순수 dart 환경
/// (`dart run`, self_check.dart)에서도 flutter 바인딩 없이 import할 수 있어야 한다.
const JayTraceReplaySender jayTraceHttpSender = jayTraceHttpSenderImpl;
