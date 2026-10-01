# Sealine Mobile QR Linking Demo

This folder contains the scanner/approval screen used to verify the physical-phone flow.

It is intentionally small so the same code can be copied into the existing Sealine Flutter app.

## Existing Sealine app

Add the `mobile_scanner` dependency, copy the QR parsing and approval logic from `lib/main.dart`, and keep the QR contract:

```json
{
  "version": 1,
  "type": "sealine_web_link",
  "token": "...",
  "wsUrl": "ws://CURRENT-PC-HOST:8787"
}
```

When the user taps **Link this account**, POST to:

`http://CURRENT-PC-HOST:8787/v1/linking/scan`

with `{ "token": "...", "deviceId": "physical-phone" }`.

The response is only an acknowledgement. Tokens are pushed to Web over its WebSocket channel.

## Android LAN development

Because the development server uses HTTP on the local network, add `android:usesCleartextTraffic="true"` to the Android `<application>` element for development. Keep this development-only; production should use HTTPS/WSS.
