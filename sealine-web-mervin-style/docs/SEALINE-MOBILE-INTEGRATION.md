# Add the physical-phone linking flow to the existing Sealine mobile app

Do not create a second production mobile app if your Sealine Flutter app already exists.

The only mobile-side behavior needed is:

## 1. Scan the Web QR

The QR payload is JSON:

```json
{
  "version": 1,
  "type": "sealine_web_link",
  "token": "...",
  "wsUrl": "ws://192.168.x.x:8787"
}
```

When `type == "sealine_web_link"`, keep the token and server address.

## 2. Show the confirmation screen

Display:

**Link this account?**

Buttons:

- **Link this account**
- **Cancel**

Do not approve before the user taps the button.

## 3. Approve

POST to:

```text
http://<QR-host>:8787/v1/linking/scan
```

JSON:

```json
{
  "token": "<scanned-token>",
  "deviceId": "<mobile-device-id>"
}
```

The response only acknowledges the scan:

```json
{
  "accepted": true,
  "channelId": "..."
}
```

The mobile app must not expect access/refresh tokens in this response.

## 4. Web receives the push

The Web is subscribed to:

```text
ws://<PC-LAN-IP>:8787/v1/linking/channel?channelId=<channelId>
```

The server pushes:

```json
{
  "type": "tokens_issued",
  "channelId": "...",
  "sessionId": "...",
  "accessToken": "...",
  "refreshToken": "...",
  "issuedAt": 0
}
```

The Web then displays:

**Welcome to Sealine 👋**

## 5. LAN requirement

Phone and PC must be on the same network.

Windows Firewall must allow the mock server port `8787` for private networks.

If the phone cannot reach the server, first test from the phone browser:

```text
http://<PC-LAN-IP>:8787/health
```

Expected:

```json
{"ok":true,"service":"wpt-linking-mock","port":8787}
```
