# Sealine Web — LAN QR Linking Build

This package is built for the real development flow:

**Web QR → physical phone scans → phone shows “Link this account?” → approve → server pushes tokens → Web shows “Welcome to Sealine”.**

## Important: no fixed IP address

The Web is configured with `API_BASE_URL=auto://lan`.

The browser automatically uses the **same hostname/IP that you used to open the Web page** and port `8787` for the linking server. Do not put your current IP into source code or `.env.local`.

If you move the PC and phone to another Wi-Fi network, run the startup script again. It detects the new PC LAN address automatically.

## Requirements

- Windows 10/11
- Node.js 20+
- pnpm 10+
- Flutter 3+
- Android phone
- PC and phone on the same Wi-Fi/LAN

## First run

From the project root:

```powershell
pnpm install
```

Run the API tests:

```powershell
pnpm --filter @wpt/api-client test
```

## Start the Web + linking server

The easiest Windows flow is two PowerShell windows.

### Terminal 1 — linking server

```powershell
$env:LINKING_SERVER_PORT="8787"
pnpm --filter @wpt/mock-server dev
```

Leave it running.

### Terminal 2 — Web

```powershell
$env:API_BASE_URL="auto://lan"
$env:LINKING_SERVER_PORT="8787"
pnpm --filter @wpt/web dev -- --hostname 0.0.0.0
```

Or use the helper script in a PowerShell window:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-web.ps1
```

The script prints the current LAN address, for example:

```text
PC LAN address: 10.34.45.129
Web:            http://10.34.45.129:3000
Linking server: http://10.34.45.129:8787
```

Open the **Web address printed by the script**. Do not hard-code that IP anywhere.

## Physical phone test

1. Connect the phone and PC to the same Wi-Fi.
2. Open the Web using the PC LAN address, e.g. `http://10.34.45.129:3000`.
3. The Web generates a QR.
4. Run the Flutter linking demo or your Sealine mobile scanner.
5. Scan the QR.
6. The phone displays **Link this account?**.
7. Tap **Link this account**.
8. The phone sends the approval to port `8787`.
9. The server pushes access/refresh tokens to the Web over the WebSocket channel.
10. The Web navigates to `/chats` and displays **Welcome to Sealine**.

## Flutter reference scanner

```powershell
cd apps\mobile_linking_demo
flutter pub get
flutter run
```

For Android HTTP LAN development, Android may require cleartext traffic for `http://192.168.x.x`. Add this to your demo app's `<application>` element:

```xml
android:usesCleartextTraffic="true"
```

The demo already includes the Internet permission addition in `android/AndroidManifest.additions.xml`.

## Network changes

Example:

```text
Wi-Fi A
PC = 10.34.45.129
Web = http://10.34.45.129:3000

change Wi-Fi

Wi-Fi B
PC = 192.168.1.25
Web = http://192.168.1.25:3000
```

No source-code change is needed. Run the helper script again and open the newly printed Web address. The QR automatically uses the current hostname/IP.

## Build verification

```powershell
pnpm --filter @wpt/api-client test
pnpm --filter web build
```

Expected API tests: **6 passed**.

## Architecture

```text
apps/web
   │
   ▼
@wpt/api-client
   │
   ▼
LAN mock linking server :8787
   ▲                         │
   │                         │ WebSocket push
   │                         ▼
Flutter phone          Web /chats
   │
   └── POST /v1/linking/scan
```

The Web screen contains no mock-linking business logic. The API contract lives in `packages/shared`, the client in `packages/api-client`, and the development server in `packages/mock-server`.

## Phone camera QR behavior

The QR contains a real LAN URL such as `http://PC-LAN-IP:8787/link?token=...`.
If the phone's normal camera/browser opens that URL, the mock linking server now serves the Sealine confirmation page with **Link this account** and **Cancel** buttons. Approving the page calls the scan endpoint and the Web receives the pushed tokens. The Flutter linking demo can also scan the same URL directly.
