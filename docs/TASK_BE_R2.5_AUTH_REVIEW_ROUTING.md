# BE-R2.5 Auth Review — Finding Routing

**From:** second independent review of `apps/backend/src/auth/`
**Baseline reviewed:** `1cd0788` (branch `krisha/be-r2.5-auth-review`)
**Full detail:** `TASK_BE_R2.5_AUTH_REVIEW_SECOND.md` · **PRE report:** `BE-R2.5-AUTH-REVIEW-PRE-report.pdf`
**POST report:** `BE-R2.5-AUTH-REVIEW-POST-report.pdf`
**Date:** 27 Sep 2026

Remediation status. All code-remediable findings are closed and verified by execution; F11 remains
open on a product decision, and N11 remains open pending a ruling. See "Fixed in this branch" for
commits and "Still needs a person" for the four non-code blockers.

> **ID note:** the first review already used F1–F8. Findings raised during *remediation* are numbered
> **F9, F10, F11** to avoid colliding with those.

---

## Status at a glance

| ID | Sev | Finding | Owner | State |
|----|-----|---------|-------|-------|
| F1 | HIGH | No `sessions.revoked_at` check at WebSocket connect | Backend | **Fixed** (`b85295a`) |
| N1 | HIGH | Three unguarded destructive scripts | — | **Fixed** (`a51e03d`), hardened again in `a8494fa` |
| F4 | MED | `token_lookup` nullable and non-unique in DB | BE-R2.1 | **Fixed** (`b85295a`, migration 013) — **not applied** |
| F10 | MED | `dashboard_admins.email` non-unique behind `LIMIT 1` login | BE-R2.1 | **Fixed** (`b85295a`, migration 013) — **not applied** |
| N2 | MED | `DASHBOARD_JWT_SECRET` configured, read by zero code | Samson | **Fixed** (`4705ea9`) — option (a) |
| N3 | MED | No refresh rotation, no reuse detection | Samson | **Fixed** (`b85295a`) — **breaking** |
| N4 | MED | OTP rate limits key on phone, not IP | Samson | **Fixed** (`b85295a`) — per-instance only |
| N5 | MED | OTP codes stored as unsalted SHA-256 | Backend | **Fixed** (`b85295a`) |
| F9 | MED | `NODE_ENV` denylist: only `"production"` was blocked | Backend | **Fixed** (`a8494fa`) |
| N6 | MED | `validateRefreshToken`/`revokeSession` untestable | — | **Fixed** (`d2d4571`) |
| N12 | MED | DB transport security delegated to URL string | — | **Fixed** (`a51e03d`) |
| N7 | LOW | `verify-refresh.ts` omits the expiry branch | Backend | **Fixed** (`b85295a`) |
| N8 | LOW | `routes/admin.ts` dead code, login has no rate limit | Backend | **Fixed** (`b85295a`) — route still unmounted |
| N10 | LOW | Test scripts log tokens, never clean up | Backend | **Fixed** (`b85295a`, `d2d4571`) |
| N11 | LOW | OTP attempt semantics differ from PRD reading | Samson | **Open — needs ruling**, deliberately unchanged |
| F11 | LOW | `POST /reports/file` accepts a `reason` field and discards it | Product | **Open — needs ruling** |
| F12 | HIGH | Database password hardcoded in two tracked scripts | Backend | **Removed from HEAD** (`47cb126`) — **password still in history, rotation mandatory** |

---

# The remainder of this document is the original review's write-up, preserved verbatim.

**It describes each finding as it stood at `1cd0788`, before remediation, and its "Ask" lines are
the questions that were put to each owner at the time.** They are kept because the reasoning behind
each finding is the durable part, and because a reviewer checking whether a fix actually addresses
the original problem needs the original problem statement, not a summary written after the fact.

**For current disposition, read "Status at a glance", "Fixed in this branch", "Rulings still
outstanding" and "Still needs a person" above.** Where the two disagree, the tables are correct and
the sections below are historical. Two specific stale claims to ignore: F1 is described as
"unowned and still open" and is now fixed, and N2's "Ask" offers a choice that has since been made as
option (a).

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

### F1 (HIGH) — no `sessions.revoked_at` check at WebSocket connect — **fixed in `b85295a`**

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
| N1 gap / F9 | `a8494fa` | The guard's `NODE_ENV === 'production'` check was a denylist, so `staging`, `prod`, `Production` and an unset value all passed. Replaced with `config/safe-env.ts`, an allowlist accepting only `development` and `test`. Two tests that previously asserted staging and prod were **allowed** — recorded in the PRE report as an accepted gap — are now inverted to assert refusal. |
| N2 | `4705ea9` | `issueAdminToken`/`verifyAdminToken` now sign and verify with `DASHBOARD_JWT_SECRET` and fail closed when it is absent or under 32 bytes. Option (a) of the decision below. |
| N3 | `b85295a` | Rotation implemented: a rotated token mints a replacement in the same `token_family_id`, and presenting an already-rotated token revokes the whole family. The claim is a conditional `UPDATE` that runs **before** the replacement is issued and whose `rowCount` picks the winner, so concurrent requests cannot both succeed. **BREAKING: `POST /onboarding/refresh` now returns `refreshToken`.** |
| N4 | `b85295a` | Per-IP limits added alongside the per-phone limits: send 3/min per phone and 10/min per IP; verify 5/min per phone and 20/min per IP. |
| N5 | `b85295a` | OTP codes stored as `HMAC-SHA256(OTP_HMAC_SECRET, code)`, replacing unsalted `sha256(code)`. Fails closed when the secret is absent or under 32 bytes. Existing rows are left alone deliberately: `OTP_TTL` is 5 minutes and a correct HMAC cannot be recomputed from a truncated digest. |
| N6 | `d2d4571` | `validateRefreshToken` and `revokeSession` accept an optional injected Drizzle handle instead of hardcoding `getDb()`. |
| F1 | `b85295a` | Socket.io now verifies the exact device and queries `sessions.revoked_at` at connect. Closes the window where a socket authenticated before a force-logout kept receiving messages for up to an hour. |
| F4 / F10 | `b85295a` | `db/migrations/013_sessions_refresh_rotation.sql` adds the rotation columns, backfills legacy rows into per-device families, and enforces `token_lookup NOT NULL UNIQUE` and `dashboard_admins.email UNIQUE`. Both preflights **raise with the conflict count rather than deleting rows** — choosing which session or administrator survives is an operator's decision. |
| N7 | `b85295a` | `verify-refresh.ts` now calls the real `validateRefreshToken` instead of reimplementing the algorithm against a `Map`, and covers the `expiresAt` branch it was silently skipping. |
| N8 | `b85295a` | Rate limits on `POST /admin/login` by IP and by email. The router stays unmounted, so there is no live surface to limit — this means mounting it later is not the moment unlimited guessing becomes possible. |
| N9 | `d2d4571` | `e2e-test.ts` and `legal-gate-test.ts` use `CURRENT_LEGAL_VERSION` instead of a hardcoded literal; refresh-token prefixes no longer logged. |
| N10 | `b85295a` | `integration-test.ts` hard-deletes every session row it creates in a `finally` block, and no longer logs a token prefix. |
| N12 | `a51e03d` | `db/pool.ts` decides transport in code: remote targets must declare `sslmode`, `disable`/`prefer`/`allow` are refused, `DATABASE_CA_CERT` enables certificate verification, and startup asserts the socket is actually encrypted via `pg_stat_ssl`. |
| F11 | `4ae2507` | Not fixed — recorded. The `reason` parameter is now underscore-prefixed so the drop is explicit at the call site rather than looking live, and the limitation is documented in the route. |
| F12 | `47cb126` | `scripts/check-columns.cjs` and `scripts/db-state.cjs` each carried the same hardcoded connection string, including the plaintext postgres password for `ukmsgzvkvcsbhtlmvswr`. Both now read `DATABASE_URL` and exit non-zero when it is unset. **Damage limitation only** — the password entered the repository in `068d6b7` and `49cdfcd`, before the baseline, and remains in git history. Rotation at the provider is mandatory and is not optional. |
| lint | `4ae2507` | `eslint src` went from 37 errors to 0. Mostly unread `catch` bindings, but also dead code in `blocks.ts`, a `Function` type in `debug.ts`, and the F11 documentation above. |

N1 and N12 are **mitigations, not full remediations.** N1 reduces the blast radius of a mistake rather
than rewriting the migrations, and N12's certificate verification only engages once
`DATABASE_CA_CERT` is set — until then the connection is encrypted but the peer is unauthenticated,
and the code warns about that on every boot.

N4 is a **partial** remediation: the limiter is the existing in-process `Map`, so the effective cap
scales with instance count. A correct fix needs a shared store such as Redis.

---

## Still needs a person

1. **A disposable non-production database, and authority to apply migration 013 to it.** Every
   available connection string points at a live shared Supabase project. The DB-backed suites insert
   and delete rows and the migration alters auth tables. Nothing about database behaviour in the POST
   report is backed by execution.
2. **The second human reviewer.** Mandatory on this card; an agent cannot supply it.
3. **PRD v1.2 and TAD v1.0.** Never supplied. The TAD 7.4 key-isolation and TAD 9.5 socket-revocation
   citations that N2 and F1 were written against are second-hand.
4. **Credential rotation.** Four credential sets across two Supabase projects have now been pasted in
   plaintext. The two pastes naming project ref `ukmsgzvkvcsbhtlmvswr` carry different database
   passwords; that must be reconciled before rotating, or the wrong one gets rotated and the live one
   stays. `GLOBAL_SALT` needs the same care — it hashes every contact number, so changing it
   invalidates every `contact_hashes` row, and `verify_salt.cjs` exists to catch exactly that.

   **The same project's postgres password is also in git history**, committed in `068d6b7` and
   `49cdfcd` and only removed from HEAD by `47cb126`. Whatever else is decided, that password is
   burned. Anyone with read access to the repository has it, and rewriting history does not help if the
   repository has been cloned, forked or pushed anywhere.
5. **`pnpm-lock.yaml` is out of sync with `apps/web/package.json`.** `--frozen-lockfile` fails. Owner
   is whoever maintains CI.

The four URLs supplied during review will not start the service as written: three omit `sslmode`, and
none set `DASHBOARD_JWT_SECRET` or `OTP_HMAC_SECRET`. That is the remediated code behaving correctly —
a remote host with no declared `sslmode` is refused rather than defaulted, and both secrets fail closed.

---

## Rulings still outstanding

### N3 — closed as option (a), needs confirmation
Rotation with family revocation is now implemented. This was a schema change and the card has been
moved on the strength of the standard-pattern argument rather than a recorded decision. If the ruling
is actually "do not rotate," revert `b85295a`; the client-side change in the same commit assumes
rotation is permanent.

### N11 — deliberately unchanged, do not "fix"
The PRD's "max 3 attempts" plus "30-second lockout after 3 failures" reads as three *more* attempts
after each lockout. `attempts` is monotonic, so after the third failure the user is locked out of that
OTP row permanently and must request a new code, which is itself subject to the 30-second resend
cooldown. This is **strictly stricter** than the spec reading. Resetting the counter on lockout expiry
would *reduce* security and would interact badly with N4. The consent audit trail is also a legal
artefact, so silently loosening it is the more dangerous error. Confirm the behaviour is intended so
it stops being re-raised each review.

### F11 — product decision, not a code fix
`POST /reports/file` accepts a `reason` field that the `reports` table cannot store. Adding the column
needs a ruling on what reporter-supplied text is retained, for how long, whether it is personal data in
a moderation context, and whether it is ever surfaced to the reported party.

---

## Recommended order

All thirteen baseline findings are closed. What remains, in the order it should be picked up:

1. **Provision a disposable database and run the DB-backed suites.** This is the only outstanding item
   that could still invalidate a fix. The N3 SQL predicates, the F4 and F10 UNIQUE constraints and the
   N10 cleanup are all asserted by reading code, not by execution.
2. **Apply migration 013 to that database** and confirm the two preflights behave as intended on data
   that already contains rows.
3. **Second reviewer signs** — sections 4, 5, 6, 7 and 8 of the POST report.
4. **Rotate the exposed credentials** — independent of everything above and not waiting on anyone.
5. **N3 confirmation ruling** — the client contract change is already merged; confirm rotation is
   permanent before the dashboard ships against it.
6. **N11 and F11 rulings** — both are decisions, and re-raising them each review costs more than making
   them once.
7. **`GLOBAL_SALT` reconciliation**, then `DATABASE_CA_CERT` and the two new secrets in the secret
   manager.
