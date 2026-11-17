import 'package:flutter/foundation.dart';

Future<void> jayTraceHttpSenderImpl(
  Uri endpoint,
  Map<String, String> headers,
  String body,
) async {
  // ponytail: web은 dart:io가 없어 기본 sender를 제공하지 않는다.
  // runJayTrace(sender: ...)로 커스텀 sender를 넘겨야 한다.
  debugPrint(
    '[jaytrace] web builds have no default sender; pass '
    'runJayTrace(sender: ...) or configure one',
  );
  assert(false, '[jaytrace] web builds need an explicit sender');
}
