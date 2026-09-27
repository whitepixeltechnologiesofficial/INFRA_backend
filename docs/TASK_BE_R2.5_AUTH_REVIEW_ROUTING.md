# BE-R2.5 Auth Review — Finding Routing

**From:** second independent review of `apps/backend/src/auth/`
**Baseline reviewed:** `1cd0788` (branch `krisha/be-r2.5-auth-review`)
**Full detail:** `TASK_BE_R2.5_AUTH_REVIEW_SECOND.md` · **PRE report:** `BE-R2.5-AUTH-REVIEW-PRE-report.pdf`
**Date:** 27 Sep 2026

Routing only. No finding below has been actioned except where a commit is named.

---

## Status at a glance

| ID | Sev | Finding | Owner | State |
|----|-----|---------|-------|-------|
| F1 | HIGH | No `sessions.revoked_at` check at WebSocket connect | Backend | **Open, inherited, unowned** |
| N1 | HIGH | Three unguarded destructive scripts | — | **Fixed** (`a51e03d`) |
| F4 | MED | `token_lookup` nullable and non-unique in DB | BE-R2.1 | Open |
| N2 | MED | `DASHBOARD_JWT_SECRET` configured, read by zero code | Samson | Open — needs decision |
| N3 | MED | No refresh rotation, no reuse detection | Samson | Open — **needs ruling** |
| N4 | MED | OTP rate limits key on phone, not IP | Samson | Open |
| N5 | MED | OTP codes stored as unsalted SHA-256 | Backend | Open |
| N6 | MED | `validateRefreshToken`/`revokeSession` untestable | — | **Fixed** (`d2d4571`) |
| N12 | MED | DB transport security delegated to URL string | — | **Fixed** (`a51e03d`) |
| N7 | LOW | `verify-refresh.ts` omits the expiry branch | Backend | Open |
| N8 | LOW | `routes/admin.ts` dead code, login has no rate limit | Backend | Open |
| N10 | LOW | Test scripts log tokens, never clean up | Backend | Open |
| N11 | LOW | OTP attempt semantics differ from PRD reading | Samson | Open — **needs ruling** |

---

## BE-R2.1 — schema owner

### F4 (MEDIUM) — `token_lookup` is nullable and non-unique in the database

`sessions-schema.ts:37` declares `notNull()`, but `db/migrate-bcrypt.ts:15` creates the column with
`ADD COLUMN IF NOT EXISTS token_lookup varchar(32)` — no `NOT NULL`, no `UNIQUE`. Drizzle's `notNull()`
is compile-time only, so the type says one thing and the database does the opposite.

`validateRefreshToken` filters on a 32-char lookup key with `limit(1)`. Without a uniqueness constraint
row selection is non-deterministic if duplicates ever exist. At 128 bits that is practically unlikely,
so this is not urgent — but the schema does not enforce what the code assumes, and the code assumes it
in the one place that matters most.

**Ask:** a migration adding `NOT NULL` and a unique index on `token_lookup`, coordinated with any other
column change so BE-R2.1 does not collide on numbering. Deferred from this card deliberately for that
reason.

**Also for BE-R2.1 awareness:** `migrate-bcrypt.ts` runs `DELETE FROM public.sessions` and is now gated
(`a51e03d`), but it is still a script whose only correct target is a throwaway database.

---

## Samson — architecture decisions

Three of these need a ruling rather than a patch. The code is behaving as written; the question is
whether what it does is what was meant.

### N3 (MEDIUM) — no refresh rotation, no reuse detection — **ruling needed**

Verified empirically against the real function, not inferred: 5 refreshes with one token produced
**0 writes to `sessions` and 5 accepts**. `refresh-token.ts:114-151` returns the same session and mints
a new access token; nothing mutates the row.

A stolen refresh token is therefore silent for its full 30-day life. There is no reuse signal, so
theft is undetectable and unrevocable without revoking the legitimate user too.

This is unspecified in both PRD and TAD, which is exactly why it needs a decision rather than a fix.
It was Open Item #1 in the first review and is still unsent.

**Decision needed:** should refresh tokens rotate with reuse detection (the standard pattern —
rotate on every refresh, and on presenting an already-rotated token, revoke the whole session family)?
If yes, this is a schema change plus a service-side change and needs a card. If no, record the
accepted risk explicitly so it is not rediscovered as a finding next review.

### N2 (MEDIUM) — `DASHBOARD_JWT_SECRET` is configured but read by zero code — **decision needed**

The key is live in the backend env: present, 45 bytes, distinct from `JWT_SECRET`. A full-tree search
returns no reader in any `.ts` file, and it is not declared in `.env.example`. Both admin token
functions call `getSecret()`, which reads `JWT_SECRET` (`jwt.ts:163`, `jwt.ts:186`).

So today a user token and a dashboard-admin token are signed with the same key. `aud` gives logical
separation, not key separation: one `JWT_SECRET` leak forges both. TAD 7.4 requires the admin signing
path to be fully isolated, and it is not isolated at the key level.

Rotating the unused key changes nothing. The uncomfortable part is that the intuitive next step —
point the admin functions at `DASHBOARD_JWT_SECRET` — is a small, obviously-correct change, which
means it will eventually be made by someone in a hurry.

**Decision needed:** either (a) wire `issueAdminToken`/`verifyAdminToken` to `DASHBOARD_JWT_SECRET` and
fail closed if it is unset, or (b) delete the key from every env and amend TAD 7.4 to state that
separation is by `aud` only. Option (a) is the stronger control; option (b) is honest about what the
system does. What should not happen is leaving it as it is.

### N4 (MEDIUM) — OTP rate limits key on phone number, not IP

`onboarding.ts:93-98` — `normalizedPhoneKey` returns `prefix:phone` for both `/otp/send` and
`/otp/verify`. There is no IP cap on either route, and `rate-limit.ts:18` is an in-process `Map`.

Three compounding problems:

1. **Sustained lockout DoS.** `attempts` is never reset, so at `attempts >= 3` every subsequent wrong
   guess re-sets `lockedUntil = now + 30s` (`onboarding.ts:412-417`). Anyone who knows a phone number
   can guess wrong three times, wait out 30 seconds, and repeat indefinitely. The victim cannot
   complete verification for as long as the attacker cycles. The lockout check at `onboarding.ts:378`
   runs *before* the code comparison, so a **correct** code is also blocked.
2. **Per-instance state.** N instances allow N times the limit, and any deploy or restart resets every
   counter.
3. **Not a PRD violation** — this is a design weakness the PRD does not appear to address, which is
   why it is a design question rather than a conformance failure.

**Ask:** decide whether to add a per-IP cap and move counters to shared storage. Both are needed for
the limit to mean anything across instances.

### N11 (LOW) — OTP attempt semantics — **ruling needed, do not "fix"**

The PRD's "max 3 attempts" plus "30-second lockout after 3 failures" reads as three *more* attempts
after each lockout. `attempts` is monotonic, so after the third failure the user is locked out of that
OTP row permanently and must request a new code, which is itself subject to the 30-second resend
cooldown.

This is **strictly stricter** than the spec reading, not weaker. Resetting the counter on lockout
expiry would *reduce* security, and would also interact badly with N4.

**Ask:** confirm the current behaviour is intended, so it stops being re-raised as a bug each review.
If a reset is wanted, it needs to be a deliberate decision with N4 considered, not a drive-by fix.

---

## Backend

### F1 (HIGH) — no `sessions.revoked_at` check at WebSocket connect — **inherited, still open**

`app.ts:79-104` authenticates the socket with `verifyAccessToken` and compares claim values only. A
search across `app.ts` and all of `ws/` returns zero references to `sessions`, `revokedAt`,
`revoked_at`, `getDb` or `validateRefreshToken`. There is no resume path.

A socket authenticated before a force-logout stays connected and keeps receiving messages.

TAD 7.1 accepts a one-hour worst-case bound for unreachable devices, and the 1h access-token expiry is
the intended mitigation — but TAD 9.5 requires the connection-time check **in addition**. Confirmed
still open; the first review did not raise it. This is the highest-severity open item on the card and
it currently has no owner.

**Ask:** add a `revoked_at` check at connect, and decide whether an existing socket should be closed
on force-logout or left to expire.

### N5 (MEDIUM) — OTP codes stored as unsalted SHA-256

`onboarding.ts:68-70` — `hashOtpCode` is `sha256(code)` over a 6-digit code. `sms_outbox.otpHash`
stores the same value.

That is a 1,000,000-value unsalted space, reversible by brute force in microseconds. Any secondary
read — a backup, a replica, a log, an injection bug in a *different* route, an over-broad admin query
— leaks a live OTP without requiring an auth vulnerability at all.

The refresh-token path already gets this right (bcrypt-12 plus a deterministic lookup key), so there
is a working precedent in the same module.

**Ask:** move to `HMAC-SHA256(server_secret, code)`, which keeps the deterministic lookup the schema
needs, or bcrypt if the lookup is reworked.

### N7 (LOW) — the shipped "full flow" refresh test omits the expiry branch

`verify-refresh.ts:117-148` builds a `Map` and re-implements lookup → bcrypt → `revokedAt`. It never
calls `validateRefreshToken` and has **no `expiresAt` branch**.

The card's named edge case therefore has zero coverage, sitting behind assertions that read as
coverage. Same class as the first review's F7 one level up: F7 fixed constant drift, not the fact
that the real function is never executed.

**Note:** the injected-handle fix in `d2d4571` (N6) is what makes this test writable. It is now
possible to call the real `validateRefreshToken` against a real or stubbed database.

### N8 (LOW) — `routes/admin.ts` is dead code and its login has no rate limit

Never imported or mounted — a search for `adminRoutes` / `routes/admin` / `admin.js` returns nothing,
and `app.ts` mounts seven routers, none of them admin. `POST /admin/login` is a bcrypt-12 check with
no rate limiting and no lockout.

Latent rather than live: the moment it is mounted, this is unlimited online password guessing against
`dashboard_admins`. Worth noting that `moderation.ts` **is** mounted and correctly gated by
`requireAdmin` → `verifyAdminToken`, but with `admin.ts` unmounted the only admin-token producer is
`debug.ts:122` — localhost- and `DEBUG=1`-gated — so `/moderation/*` is unreachable in any real
deployment. Net effect: the `aud` separation fixed in F2 has no live producer/consumer pair yet. It
gains one the moment the dashboard is wired up, and N2 applies then.

**Ask:** either mount it behind rate limiting or delete it, and decide the intended producer for
admin tokens now that N2 is open.

### N10 (LOW) — test scripts log tokens and never clean up

`verify-refresh.ts:36` prints a full raw refresh token; `integration-test.ts:37` prints the first 20
characters. `e2e-test.ts` and `integration-test.ts` insert into `users`, `devices`, `contact_hashes`,
`sessions`, `legal_acceptances` and `otp_verifications` and never delete any of it;
`integration-test.ts:82` revokes a session and calls that cleanup.

Throwaway values, so no live leak — but the scripts' own stated principle is that the raw token is
never exposed, and printing it models the opposite. Repeated runs accumulate permanently. Test
numbers are `+1555` (a reserved fictional range) so this is pollution rather than a safety issue, but
it should not be pointed at a shared environment.

---

## Fixed in this branch

| ID | Commit | Change |
|----|--------|--------|
| N1 | `a51e03d` | `fix-sessions-table.ts`, `migrate-legal-acceptances.ts` and `migrate-bcrypt.ts` now pass through `db/guard.ts`, which refuses under `NODE_ENV=production`, requires `ALLOW_DESTRUCTIVE_DB`, and requires a second `ALLOW_DESTRUCTIVE_DB_REMOTE` acknowledgement for any non-local target, printing the redacted URL and the exact statements that will run. |
| N6 | `d2d4571` | `validateRefreshToken` and `revokeSession` accept an optional injected Drizzle handle instead of hardcoding `getDb()`. |
| N9 | `d2d4571` | `e2e-test.ts` and `legal-gate-test.ts` use `CURRENT_LEGAL_VERSION` instead of a hardcoded literal. |
| N12 | `a51e03d` | `db/pool.ts` decides transport in code: remote targets must declare `sslmode`, `disable`/`prefer`/`allow` are refused, `DATABASE_CA_CERT` enables certificate verification, and startup asserts the socket is actually encrypted via `pg_stat_ssl`. |

N1 and N12 are **mitigations, not full remediations.** N1 reduces the blast radius of a mistake rather
than rewriting the migrations, and N12's certificate verification only engages once
`DATABASE_CA_CERT` is set — until then the connection is encrypted but the peer is unauthenticated,
and the code warns about that on every boot.

---

## Blockers that are not finding-specific

1. **DB-backed tests have never been executed.** `e2e-test.ts`, `integration-test.ts` and
   `legal-gate-test.ts` were read, not run. The F5 legal-version gate is correct on inspection and has
   never been executed at runtime.
2. **PRD v1.2 and TAD v1.0 are not in the repository.** Every requirement citation in both review notes
   is second-hand.
3. **Second reviewer has not signed.** Mandatory on this card and cannot be self-granted.
4. **Credentials exposed in review.** Three credential sets across two Supabase projects were pasted
   in plaintext. All require rotation, and the two pastes naming the same project ref carry different
   database passwords — that ambiguity must be resolved before rotating, or the wrong one gets
   rotated and the live one stays.
5. **`pnpm-lock.yaml` is out of sync with `apps/web/package.json`.** `--frozen-lockfile` fails. Owner
   is whoever maintains CI.
6. **`DATABASE_URL` currently points at a shared project.** The destructive scripts are now gated, but
   the DB-backed tests should still run against a dedicated non-production database.

---

## Recommended order

1. **F1** — highest severity, currently unowned, and a security control the TAD explicitly requires.
2. **N3 ruling** — longest-standing open item, still unsent from the first review, and a schema change
   if the answer is yes, so it needs lead time.
3. **N2 decision** — small code change with a security upside, and the risk is that it gets made
   casually before the decision is recorded.
4. **Rotate the exposed credentials** — independent of all of the above and not waiting on anyone.
5. **N4, N5, then the LOW items** as capacity allows.
6. **F4** via BE-R2.1's coordinated migration pass, not standalone.
