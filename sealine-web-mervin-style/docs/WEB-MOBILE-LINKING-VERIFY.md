# Web ↔ Mobile Physical QR Verification

## Test 1 — Web starts

1. Run the mock server:
   `pnpm --filter @wpt/mock-server dev`
2. Run Web:
   `pnpm --filter @wpt/web dev`
3. On the PC, find LAN IPv4 with `ipconfig`.
4. Open `http://<LAN-IP>:3000` from the PC browser.
5. Confirm a QR is displayed.

Expected:
- QR displays only after registration succeeds.
- Countdown is 60 seconds.
- QR changes after expiry.

## Test 2 — Physical phone

1. Put phone and PC on the same Wi-Fi.
2. Run the Flutter mobile app on the physical phone.
3. Scan the Web QR.
4. Mobile must show:

   **Link this account?**

5. Tap:

   **Link this account**

Expected Web result:

**Welcome to Sealine 👋**

Then the Web opens `/chats`.

## Test 3 — Expired QR

1. Leave the QR untouched for more than 60 seconds.
2. Confirm Web creates a new QR.
3. A phone must not be able to approve the old QR.

Expected error:
`Linking token expired. Refresh the QR code.`

## Test 4 — Reuse

Approve one QR once.

Attempt to approve the same QR again.

Expected:
`This linking token has already been used.`

## Test 5 — Push semantics

The `/scan` acknowledgement contains only:

```json
{
  "accepted": true,
  "channelId": "..."
}
```

Access/refresh tokens are sent separately over the Web channel as:

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

This is intentional: the simulated phone scan does not return tokens in the scan response.

## Test 6 — Force logout

After linking, use the Web developer control:

`Force logout`

Expected:
- session tokens are cleared
- Web returns to the QR screen
- no stale session remains

## Test 7 — Phone offline/online

Use the developer controls to send phone offline/online events.

Expected:
- Web remains usable
- status changes only
- no blocking "syncing" screen is introduced
