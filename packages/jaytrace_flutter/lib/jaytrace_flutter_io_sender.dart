import 'dart:convert';
import 'dart:io';

Future<void> jayTraceHttpSenderImpl(
  Uri endpoint,
  Map<String, String> headers,
  String body,
) async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(endpoint);
    headers.forEach(request.headers.set);
    request.add(utf8.encode(body));
    final response = await request.close();
    await response.drain<void>();
  } finally {
    client.close(force: true);
  }
}
