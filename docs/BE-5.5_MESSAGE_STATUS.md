# BE-5.5 - Four-State Message Status (Stretch, Draft)

Story is a DRAFT: confirm with Samson before treating as final. Depends on BE-5.4.
Reference: PRD 5.5 / section 8.2-8.5, Tech Arch 9.2-9.4, decisions #2 and #3.

## States

| State     | Indicator   | Set by                                              |
|-----------|-------------|-----------------------------------------------------|
| sent      | green clock | `POST /relay/send` (server accepted + queued)       |
| delivered | grey circle | `POST /relay/ack` from ANY recipient device         |
| read      | blue circle | `POST /relay/status/read` from ANY recipient device |
| failed    | red clock   | `POST /relay/status/failed` from the SENDER         |

Rules: sent < delivered < read; transitions only go up. Exceptions:
`failed -> sent` (sender retries, PRD 8.2) and `failed -> delivered/read` (the
message actually arrived, so the truth wins). Recipient offline is NOT a failure:
the message stays `sent` until the recipient reconnects and acks (Tech Arch 9.3).
After the 30-day queue expiry the status row ages out too and the sender's
indicator stays green (decision #3).

## Why a new table

`pending_messages` rows are hard-deleted once delivered (Tech Arch 6.4), so they
cannot remember delivered/read. `message_status` (migration 019) holds metadata
only - no ciphertext, no recipient device ids - one row per
`(sender_device_id, client_message_id)`, aggregated across the recipient's
devices. Status is only tracked for sends that carry a `clientMessageId`.

## Client contract

Real time: the sender's socket receives `message_status`:
`{ clientMessageId, state, sentAt, deliveredAt, readAt, failedAt, failureReason, updatedAt }`

Catch-up (sender was offline): `POST /relay/status/sync`
`{ clientMessageIds?: uuid[<=200], since?: ISO }` -> `{ statuses: [...], serverTime }`.
Call on every (re)connect, passing the previous `serverTime` as `since`. Ids that
are absent have no server-side status - keep whatever is shown locally.

Read: `POST /relay/status/read` `{ senderDeviceId, clientMessageId }`
(both come from the received message). A non-recipient gets 404.

Failed: `POST /relay/status/failed` `{ clientMessageId, reason? }`, reason in
`RETRIES_EXHAUSTED | NETWORK_ERROR | REJECTED_BY_SERVER`. 404 = the server never
saw the message (red clock is then purely local). 409 = already delivered/read.

Retry: re-sending the same `clientMessageId` returns `duplicate: true` plus the
current `status`, and flips `failed -> sent`. It never re-queues the message.

## Side effect on BE-5.4 (fixed here)

Idempotency used to depend on the `pending_messages` rows still existing. Those
are deleted after delivery, so a late retry would have queued the message a
second time. `/send` now checks `message_status` first.
`/send` inserts queue rows + the `sent` row in one transaction; `/ack` marks
delivered + escalates in one transaction.

## Open questions for Samson

1. Read receipts: Tech Arch 9.4 says read receipts travel as durable E2EE
   `read_receipt` messages through the pending_messages pipeline. That enum value
   does not exist in the DB yet and no client can produce one. This build uses a
   server-visible endpoint instead (the server already sees delivery). If the
   E2EE route is required, `/status/read` becomes the server-side hook for it.
2. Should the server learn read times at all, and where does the user's
   "read receipts off" setting (PRD 23.5) live? Today the client simply does not
   call `/status/read`.
3. Group per-recipient status is BE-5.7; this table is 1:1 (one recipient user).

## Verify

Migrations 018 then 019 in Supabase, then:
`pnpm --filter @wpt/backend exec tsx src/db/message-status-e2e-test.ts`
(creates and deletes throwaway users; run it against a non-production database
if you have one). Expected: `61 passed, 0 failed, 0 skipped`.
