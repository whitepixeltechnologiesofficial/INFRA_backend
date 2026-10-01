import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

void main() {
  runApp(const SealineLinkingApp());
}

class SealineLinkingApp extends StatelessWidget {
  const SealineLinkingApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Sealine',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.black),
        useMaterial3: true,
      ),
      home: const LinkAccountPage(),
    );
  }
}

class LinkAccountPage extends StatefulWidget {
  const LinkAccountPage({super.key});

  @override
  State<LinkAccountPage> createState() => _LinkAccountPageState();
}

class _LinkAccountPageState extends State<LinkAccountPage> {
  final MobileScannerController scanner = MobileScannerController();

  Map<String, dynamic>? pendingQr;
  bool linking = false;
  String? error;

  void onScan(BarcodeCapture capture) {
    if (pendingQr != null) return;

    for (final barcode in capture.barcodes) {
      final raw = barcode.rawValue;
      if (raw == null) continue;

      try {
        final uri = Uri.tryParse(raw);
        if (uri != null &&
            (uri.scheme == 'http' || uri.scheme == 'https') &&
            uri.path == '/link' &&
            uri.queryParameters['token'] != null) {
          scanner.stop();
          setState(() {
            pendingQr = {
              'token': uri.queryParameters['token'],
              'serverUrl': '${uri.scheme}://${uri.host}:${uri.hasPort ? uri.port : 80}',
            };
            error = null;
          });
          return;
        }

        // Backward compatibility with the previous JSON QR format.
        final decoded = jsonDecode(raw);
        if (decoded is Map &&
            decoded['type'] == 'sealine_web_link' &&
            decoded['token'] is String &&
            decoded['wsUrl'] is String) {
          scanner.stop();
          final ws = Uri.parse('${decoded['wsUrl']}');
          setState(() {
            pendingQr = {
              'token': decoded['token'],
              'serverUrl': '${ws.scheme == 'wss' ? 'https' : 'http'}://${ws.host}:${ws.hasPort ? ws.port : 80}',
            };
            error = null;
          });
          return;
        }
      } catch (_) {
        // Ignore unrelated QR codes.
      }
    }
  }

  Future<void> approve() async {
    final qr = pendingQr;
    if (qr == null) return;

    setState(() {
      linking = true;
      error = null;
    });

    try {
      final serverUrl = '${qr['serverUrl']}';
      final token = '${qr['token']}';

      // The phone calls the scan endpoint only after the user approves.
      // The endpoint returns only an acknowledgement; access/refresh tokens
      // are pushed separately to the Web's subscribed channel.
      final httpUri = Uri.parse('$serverUrl/v1/linking/scan');

      final client = HttpClient();
      final request = await client.postUrl(httpUri);
      request.headers.contentType = ContentType.json;
      request.add(utf8.encode(jsonEncode({
        'token': token,
        'deviceId': 'physical-phone',
      })));

      final response = await request.close();
      final body = await utf8.decoder.bind(response).join();
      client.close();

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Exception(body); 
      }

      if (!mounted) return;
      setState(() {
        pendingQr = null;
        linking = false;
      });

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Account linked successfully.')),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        linking = false;
        error = 'Unable to link this account. Check that the phone and PC are on the same Wi-Fi.';
      });
    }
  }

  void cancel() {
    setState(() {
      pendingQr = null;
      error = null;
    });
    scanner.start();
  }

  @override
  void dispose() {
    scanner.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final showConfirm = pendingQr != null;

    return Scaffold(
      appBar: AppBar(title: const Text('Sealine')),
      body: showConfirm
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(28),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    const Icon(Icons.devices_other, size: 72),
                    const SizedBox(height: 20),
                    const Text(
                      'Link this account?',
                      style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold),
                    ),
                    const SizedBox(height: 10),
                    const Text(
                      'This will link your Sealine mobile account to the Web session shown on your computer.',
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 28),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton(
                        onPressed: linking ? null : approve,
                        child: Text(linking ? 'Linking…' : 'Link this account'),
                      ),
                    ),
                    const SizedBox(height: 10),
                    SizedBox(
                      width: double.infinity,
                      child: OutlinedButton(
                        onPressed: linking ? null : cancel,
                        child: const Text('Cancel'),
                      ),
                    ),
                    if (error != null) ...[
                      const SizedBox(height: 16),
                      Text(error!, style: const TextStyle(color: Colors.red)),
                    ],
                  ],
                ),
              ),
            )
          : MobileScanner(
              controller: scanner,
              onDetect: onScan,
            ),
    );
  }
}
