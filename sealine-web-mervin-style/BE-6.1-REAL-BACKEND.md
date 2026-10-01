# BE-6.1 Real Backend Integration

This Web implementation follows the supplied BE-6.1 integration text.

## Configuration

Create `apps/web/.env.local`:

```env
NEXT_PUBLIC_API_BASE_URL=https://YOUR-BACKEND-HOST
```

Use the backend origin only. Do not append `/api/v1`.

## Runtime flow

1. Generate a 32-byte base64url linking token.
2. Connect to Socket.IO namespace `/linking` using path `/realtime` and WebSocket transport.
3. Register `{ token, identityPublicKey, signingPublicKey }`.
4. Display the raw token in the QR code.
5. Wait for pushed `accountLinked` — no polling.
6. Save the returned Web session values and open the authenticated root socket.
7. Handle `force_logout` by clearing the Web session and returning to QR/login.
8. Handle `linkExpired` by generating a new token/socket only when linking has not completed.
9. If the linking socket disconnects before expiry, re-register the same token.
10. Refresh through `/api/v1/onboarding/refresh`.
11. Log off through `/api/v1/linking/logoff` using the Web access token.

## Important

The supplied BE-6.1 text says the exact public-key types must match the authoritative TAD/shared contract. The current standalone ZIP does not contain that TAD key implementation, so public-key generation is isolated in `packages/crypto/src/index.ts` and must be replaced with the project's authoritative key implementation if the backend validates a stricter key encoding.

The supplied BE-6.1 document also states that the backend behavior was tested, while the real Web application had not yet been run against it. Therefore live acceptance testing is still required.
