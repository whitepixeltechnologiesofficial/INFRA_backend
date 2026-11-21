# TASK BE-R2.5 — Login System Review: SECOND REVIEWER NOTE

Card: BE-R2.5 — Login System re-review
Requirement source: PRD v1.2, TAD v1.0 (Final)
Scope: `apps/backend/src/auth/`
Base commit: `f27b0ae` (`origin/main`)
Branch reviewed: `krisha/be-r2.5-auth-review` @ `1cd0788`
First reviewer: krisha-wpt (see `docs/TASK_BE_R2.5_AUTH_REVIEW.md`)
Second reviewer: ______________________  Date: ____________
Date of this review: 27 Sep 2026

**Status: complete — awaiting second signature.**

This note is independent. It does not assume the first review is correct. Where
it agrees, agreement is stated as a separate confirmation, not as an assumption.

---

## 1. Method

- Fresh single-branch clone of `INFRA_backend` at `krisha/be-r2.5-auth-review`,
  clean tree, base `f27b0ae` confirmed as the merge-base ancestor.
- All 10 files in `auth/` read line by line (1,189 lines).
- Consumers traced beyond the folder: `middleware/auth.ts`, `middleware/rate-limit.ts`,
  `app.ts`, `routes/onboarding.ts`, `routes/admin.ts`, `routes/moderation.ts`,
  `routes/debug.ts`, `db/sessions-schema.ts`, `db/legal-acceptances-schema.ts`,
  `db/phone-hash.ts`, `db/migrate-*.ts`, `db/fix-sessions-table.ts`.
  **This closes a gap the first review declared** (§7: `routes/admin.ts`,
  `routes/moderation.ts`, `routes/debug.ts` "were not themselves reviewed
  line-by-line"). All three were reviewed here.
- `verify.ts` and `verify-refresh.ts` were **executed**, not read (the first
  review read `verify.ts` only).
- The real `validateRefreshToken` was **executed** against a recording stub
  (see §5). The first review could not do this: the function hardcoded `getDb()`.
- `pnpm typecheck` and `eslint src/auth` both clean.

### Requirement sources could not be opened

**PRD v1.2 and TAD v1.0 (Final) are not in the repository.** A full-tree search
returns no `PRD*` or `TAD*` document in any branch reachable from this clone;
the only Markdown docs are `AGENTS.md`, `README.md`, `TASK_8_DB_2.3_VERIFICATION.md`,
`docs/onboard_flow.md`, and the two review notes.

Every `PRD §x` / `TAD §x` citation in this note and in the first review is
therefore **a citation the reviewer could not re-verify**. Requirements were
assessed against the *behaviour* the code implements and against the section
numbers the first review quoted. Section numbers should be treated as
second-hand until someone opens the source documents. This does not change any
verdict below, but it does bound the strength of the "requirement compliance"
claim in both notes.

---

## 2. Independently verified as correctly implemented

Recorded so the next reader knows these were executed, not skimmed.

| # | Property | How verified |
|---|---|---|
| 1 | Access token expires in exactly 1 hour | `verify.ts` run: `exp - iat = 3600s` |
| 2 | `aud` separates the two token families, **both directions** | `verify.ts` run: access token rejected by `verifyAdminToken`, admin token rejected by `verifyAccessToken`, each accepted by its own |
| 3 | `HS256` pinned on both verify paths | `jwt.ts:103,191` — `algorithms: ["HS256"]`; blocks `alg:none` and RS256→HS256 |
| 4 | Refresh token stored only as a bcrypt-12 hash | `verify-refresh.ts` run: raw ≠ hash, hash is 60-char `$2a$12$` |
| 5 | **Refresh token EXPIRY enforced** | Real `validateRefreshToken` executed: expired → reject; 1 ms past boundary → reject; expires in 1 s → accept. No premature rejection. |
| 6 | **Refresh token REVOCATION enforced** | Real function executed: `revoked_at` non-null → reject; revoked + expired → reject |
| 7 | Wrong token rejected even when the lookup row matches | Real function executed — the `bcrypt.compare` guard is load-bearing, not decorative |
| 8 | New login revokes all prior sessions | `onboarding.ts:188-197` — revokes before issuing, inside the transaction |
| 9 | OTP: 3 attempts, 30 s lockout, 30 s resend cooldown | `onboarding.ts:51-53`, enforced at `:278-287` and `:412-421` |
| 10 | OTP attempt counter is race-safe | `onboarding.ts:404-408` — atomic `attempts = attempts + 1`, not read-modify-write |
| 11 | Legal gate is server-side and now version-aware | `onboarding.ts:353-361` calls `requireLegalAcceptance` before any code comparison |
| 12 | `JWT_SECRET` minimum 32 bytes | `jwt.ts:45-50` (first review's F6 fix) |
| 13 | No SQL interpolation in `auth/` | All DB access via Drizzle builder with bound params |
| 14 | No `Math.random()` in `auth/` | All randomness is `node:crypto` |
| 15 | Raw OTP never persisted | Only `sha256` written; `sms_outbox` stores the same hash |
| 16 | OTP comparison timing-safe | `onboarding.ts:104-109` — `timingSafeEqual`, length-guarded |
| 17 | Debug routes fail closed | `debug.ts:18-38` — three gates, all deny-by-default |
| 18 | Debug localhost gate is not spoofable | No `trust proxy` set in `app.ts`, so `req.ip` is the real socket address |
| 19 | `typecheck` + `eslint src/auth` | Clean, exit 0, before and after this review's changes |

**Row 5 and row 6 are the card's named edge case.** The refresh expiry check at
`refresh-token.ts:144` is correct, including at the boundary. The first review
asserted this from code reading; it is now confirmed by execution.

---

## 3. Findings

Severity is mine. Where it differs from the first review I say so.

### N1 — HIGH — Three unguarded destructive scripts can wipe live auth state

| Script | Line | Statement |
|---|---|---|
| `db/fix-sessions-table.ts` | 8 | `DROP TABLE IF EXISTS "public"."sessions" CASCADE` |
| `db/migrate-legal-acceptances.ts` | 7 | `DROP TABLE IF EXISTS "public"."legal_acceptances" CASCADE` |
| `db/migrate-bcrypt.ts` | 12 | `DELETE FROM public.sessions` |

None checks `NODE_ENV` or `DEBUG`. They are plain `tsx` scripts with no
confirmation prompt. Running any of them against a live environment destroys
auth state.

**The first review found only the third** (as a footnote inside F4). The two
`DROP TABLE ... CASCADE` statements are strictly worse and were missed.

Why this belongs in an `auth/` review: `sessions` is the table
`refresh-token.ts` reads on every refresh, and `legal_acceptances` is the table
the legal gate reads before every OTP verification. These scripts are the only
thing creating the shapes `auth/` depends on, so they are inside the blast
radius. The `legal_acceptances` drop additionally destroys the **consent audit
trail**, which is a compliance problem independent of the security one.

Not fixed here — see §6.

### N2 — MEDIUM — `DASHBOARD_JWT_SECRET` is dead config; dashboard and end-user tokens share one key

A full-tree search for `DASHBOARD_JWT_SECRET` returns **zero** matches in any
`.ts` file. Every `process.env` read in the backend is:

```
BACKEND_URL  CORS_ORIGIN  DATABASE_URL  DEBUG  GLOBAL_SALT  JWT_SECRET
NODE_ENV  PORT  SMS_TWILIO_{ACCOUNT_SID,AUTH_TOKEN,FROM}  CONTACT_HASH_SALT
```

Both `issueAdminToken` (`jwt.ts:163`) and `verifyAdminToken` (`jwt.ts:186`) call
the same `getSecret()` → `process.env.JWT_SECRET`.

The deployment sets a distinct `DASHBOARD_JWT_SECRET`, so the intent behind
TAD §7.4 ("Fully isolated… structurally rejected by any endpoint expecting
`aud: "app"`, and vice versa") was clearly key separation. The code does not
implement it. The `aud` fix gives **logical** separation; a single `JWT_SECRET`
leak still forges both an end-user token and a dashboard-admin token.

This is the sharpest remaining gap against TAD §7.4, and the first review did
not see it — its F2 discussion treats the shared secret as a known property but
never notes that a separation secret already exists in the environment and is
ignored. An unused secret is worse than none: it reads as implemented.

### N3 — MEDIUM — Refresh rotation and reuse detection are absent (confirmed empirically)

The card names rotation as the area most likely to hide subtle bugs. Confirmed absent.

Executing the real `validateRefreshToken` five times with the same token
produced these DB calls, five times over:

```
select, from, where, limit:1     (×5 — and nothing else)
```

Zero writes. The same token replayed five times was accepted every time.

Two things this clarifies that a reading of the code alone would not:

1. **The 30-day expiry is absolute, not sliding.** `expiresAt30Days()` is
   computed once at issuance and `validateRefreshToken` never extends it. So a
   session dies 30 days after login regardless of activity. This is the *safer*
   choice and is correct — but "rotation" and "sliding expiry" are routinely
   conflated, and it should be stated that only the former is missing.
2. **A stolen refresh token is silent for its full 30 days.** The only thing that
   kills it is the victim logging in again, because `executeHandoffTransaction`
   revokes all prior sessions. An attacker who only refreshes never trips
   anything and is never observed.

The first review listed this as Open Item #1 and was right that it is
unspecified in PRD/TAD. This note confirms it empirically and adds the
containment analysis. **Still needs Samson's ruling** — see §6.

### N4 — MEDIUM — Rate limits are keyed on phone number, not IP: sustained lockout DoS

`/otp/send` and `/otp/verify` both use `keyFn: normalizedPhoneKey(...)`, which
returns `` `${prefix}:${normalizedPhone}` `` (`onboarding.ts:93-98`). There is
**no IP-based limit on either endpoint.**

Combined with the attempt semantics: `attempts` is never reset, so once it
reaches `MAX_ATTEMPTS` (3) *every* subsequent wrong guess re-sets
`lockedUntil = now + 30s` (`onboarding.ts:412-417`). An attacker who knows a
victim's phone number can therefore:

1. guess wrong 3× → victim locked 30 s,
2. wait out the lockout, guess wrong again → re-locked,
3. repeat indefinitely.

The victim cannot complete an OTP verification for as long as the attacker
keeps cycling. A correct code is also blocked during the lockout window,
because the lockout check (`onboarding.ts:378`) runs before the code comparison.

Aggravating: the limiter is an in-process `Map` (`rate-limit.ts:18`). State is
per-instance and is lost on restart, so N instances allow N× the intended limit
and any deploy resets every counter. The file comment acknowledges the
single-instance limitation; combined with phone-keying it strengthens the attack.

Not a PRD violation — rows 1–3 of the first review's §2 are correctly PASS. This
is a design weakness the PRD does not appear to address. **Needs a ruling.**

### N5 — MEDIUM — OTP codes are stored as unsalted SHA-256

`hashOtpCode` is `sha256(code)` over a 6-digit code (`onboarding.ts:68-70`) — a
1,000,000-value space with no salt. Any read of `otp_verifications` yields the
code instantly by brute force (microseconds on one GPU-less CPU; a full
rainbow table is ~10^6 SHA-256 evaluations). `sms_outbox.otpHash` stores the
same value.

The blast radius is any secondary exposure: a backup, a read replica, a log, an
injection bug in a *different* route, or an over-broad admin/reporting query.
None of those needs to be an auth vulnerability to leak a live OTP.

`refresh-token.ts` gets this right (bcrypt-12 plus a deterministic lookup key).
The OTP path should use `HMAC-SHA256(server_secret, code)` or bcrypt. A keyed
hash keeps the lookup-key property if that is wanted later.

Not fixed — the OTP hash is written in `routes/onboarding.ts`, outside the
card's stated `auth/` scope, and changing it invalidates in-flight codes.

### N6 — MEDIUM — `validateRefreshToken` and `revokeSession` could not be tested — **FIXED**

`issueRefreshToken({..., db?})` and `revokeAllUserSessions(userId, db?)` accept
an injected Drizzle handle. `validateRefreshToken` and `revokeSession` hardcoded
`getDb()`. The two functions that make every authorisation decision on the
refresh path were the two that could not be exercised.

The consequence was concrete: the first review's F7 fix imported the constants
into `verify-refresh.ts`, but the "full flow" checks in that script are a
hand-rolled `Map` mock that **re-implements** the decision logic — so it asserts
its own copy, not the shipped function. See N7.

**Fixed in this review** by adding the optional `dbParam`, matching the module's
existing convention. Additive and backwards-compatible; both production callers
(`onboarding.ts:499`, `:553`) use the one-argument form and are unaffected.

### N7 — LOW — The shipped refresh "full flow" test omits the expiry branch

`verify-refresh.ts:117-148` builds a `Map` and re-implements lookup → bcrypt →
`revokedAt` check. It never calls `validateRefreshToken`. Its mock has **no
`expiresAt` branch at all**.

So the card's named edge case — refresh-token expiry — had **zero** coverage
before this review, and the assertions that appeared to cover it were asserting
a copy written in the test file. This is the same class of defect as F7, one
level up: F7 fixed constant drift, not the fact that the real function is never
executed.

Closed for this review by a throwaway harness (not committed — see §5). The
durable fix is N6 plus a real test once a database is available.

### N8 — LOW — `routes/admin.ts` is dead code, and its login has no rate limit

`routes/admin.ts` is **never imported or mounted** — a full-tree search for
`adminRoutes` / `routes/admin` / `admin.js` returns nothing, and `app.ts`
mounts seven routers, none of them admin. So `POST /admin/login`, a bcrypt-12
password check with **no rate limiting and no lockout**, is not currently
reachable.

Two consequences:

- Latent. The moment someone mounts it, unlimited online password guessing
  against `dashboard_admins` is exposed. Worth fixing before mounting, not after.
- `moderation.ts` *is* mounted and correctly gated by `requireAdmin` →
  `verifyAdminToken` (`moderation.ts:33-51`), but with `admin.ts` unmounted the
  only producer of an admin token is `debug.ts:122` `/admin-token`, which is
  localhost- and `DEBUG=1`-gated. So `/moderation/*` is currently unreachable in
  any real deployment.

Net: the `aud` separation fixed in F2 has **no live producer/consumer pair yet**.
It is correct, but it is not yet load-bearing in production, and it will become
so as soon as the dashboard is wired up. N2 applies at that moment.

### N9 — LOW — Hardcoded legal-version literal in two test scripts — **FIXED**

`legal-gate-test.ts:32` and `e2e-test.ts:53` both hardcoded
`"v1.0-2024-01-15"` while `CURRENT_LEGAL_VERSION` was already imported in
`legal-gate-test.ts` — the same drift class as F7, unfixed in the test files.
Both now reference the constant. No behaviour change today; no drift tomorrow.

### N10 — LOW — Test scripts log tokens and never clean up

- `verify-refresh.ts:36` prints a full raw refresh token; `integration-test.ts:37`
  prints the first 20 characters. Both are throwaway values, so no live leak —
  but the scripts' own stated principle is that the raw token is never exposed,
  and printing it models the opposite.
- `e2e-test.ts` and `integration-test.ts` insert into `users`, `devices`,
  `contact_hashes`, `sessions`, `legal_acceptances` and `otp_verifications` and
  **never delete any of it**. `integration-test.ts:82` revokes a session and
  calls that cleanup. Repeated runs accumulate permanently. Test phone numbers
  are `+1555…` (the reserved fictional range), so this is pollution rather than
  a safety issue — but it should not be pointed at a shared environment.

Relevant to whoever runs these manually.

### N11 — LOW — OTP attempt semantics differ from the obvious PRD reading

"Max 3 attempts" + "30-second input lockout after 3 failures" reads naturally as
*three more attempts after each lockout*. The implementation does not do that:
`attempts` is monotonic, so after the third failure the user is locked out of
that OTP row **permanently** and must request a new code (itself subject to the
30 s resend cooldown).

**This is stricter than the spec reading, not weaker, so it must not be
"fixed" without a ruling** — changing it to reset the counter would *reduce*
security. Flagged so the behaviour is a decision rather than an accident.

---

## 4. Corrections and disagreements with the first review

**Agree, and record as independently confirmed.** The F2 severity correction
(compliance gap, not an exploitable cross-family replay) is honest and correct;
`verifyAdminToken` requiring `adm` and `verifyAccessToken` requiring
`deviceId`+`sid` did already block both directions. I reached the same
conclusion independently before reading theirs.

**Downgrade — §8 residual risk is effectively theoretical.** The first review
asks the second signer to accept that "if any existing `legal_acceptances` row
stores a `legal_version` other than `v1.0-2024-01-15`, that user fails the gate
at their next OTP verification." I traced every writer of that column:

- the only production writer is `onboarding.ts:240-243`, which passes
  `CURRENT_LEGAL_VERSION`;
- `migrate-legal-acceptances.ts` **drops the table before creating it**, so it
  is always empty at creation;
- the two other writers are test scripts.

No stale row can exist. The risk is not zero — a hand-edited row or a future
migration could create one — but it should not be carried as an open risk
against this card.

**Added.** N1 (two missed `DROP TABLE` statements), N2 (ignored
`DASHBOARD_JWT_SECRET`), N4 (phone-keyed rate limits), N5 (unsalted OTP hash),
N7 (mock omits expiry), N8 (`admin.ts` not mounted), N10 (no test cleanup),
N11 (attempt semantics). The first review traced `routes/admin.ts` far enough
to cite it but explicitly did not read it; N2 and N8 both live in that gap.

**Correction to §7 of the first review.** It states `verify.ts` "was read only."
It executes cleanly, 12/12, and its claims are accurate.

---

## 5. How the refresh edge case was actually verified

`validateRefreshToken` hardcoded `getDb()` (N6), so it could not be called
directly. For this review a throwaway harness loaded the real module body with
only the `getDb` import line replaced by a recording stub, leaving every
branch of the real function intact, and exercised:

- valid / unexpired / unrevoked → accepted, identity returned
- expired (1 s and 1 ms past) → rejected
- expiring in 1 s → accepted (no premature rejection)
- revoked → rejected; revoked + expired → rejected
- correct row + wrong raw token → rejected (bcrypt guard load-bearing)
- unknown token → rejected
- 5 refreshes with the same token → **0 writes, accepted every time** (N3)
- `revokeSession` issues `update` + guarded `where` (F3 fix intact)
- `lookupKey` is 32 lowercase hex chars, matching `sessions.token_lookup`

**14/14 passed.** The harness was deleted after the run and is not part of this
branch — it rewrote a source file at runtime, which is not something to commit.
N6 is the durable fix that makes such a test straightforward to write properly.

---

## 6. What was fixed, and what was deliberately not

### Fixed in this review

| Finding | Change | Files |
|---|---|---|
| N6 | Added optional `dbParam` to `validateRefreshToken` and `revokeSession`, matching `issueRefreshToken` / `revokeAllUserSessions` | `auth/refresh-token.ts` |
| N9 | Replaced the hardcoded `"v1.0-2024-01-15"` literal with the imported `CURRENT_LEGAL_VERSION` | `auth/legal-gate-test.ts`, `auth/e2e-test.ts` |

19 insertions, 5 deletions across 3 files. No behaviour change: the new
parameter is optional, and both production callers use the one-argument form.

Verified after the change: `tsc --noEmit` exit 0, `eslint src/auth` exit 0,
`verify.ts` 12/12, `verify-refresh.ts` 13/13.

### Deliberately not fixed

| Finding | Why not | Route |
|---|---|---|
| **F1** (HIGH) — no `sessions.revoked_at` check at WebSocket connect | Design decision on the WS auth path; `ws/` is R2.6 territory. Agreed with the first review: fixing it here risks conflicting with that work | Samson + R2.6 |
| **F4** (MEDIUM) — `token_lookup` nullable and non-unique in the DB | Needs a migration. BE-R2.1's `013` has not merged and R2.2–R2.4 need renumbering; a fourth collision helps nobody | BE-R2.1 coordinated schema pass |
| **N1** (HIGH) — unguarded destructive `db/` scripts | The fix is an env guard plus a decision about whether these scripts should exist at all. They live in `db/`, not `auth/`, and the sprint plan routes schema work through BE-R2.1 | BE-R2.1, with N1 attached |
| **N3** (MEDIUM) — no rotation / reuse detection | Unspecified in PRD and TAD. Choosing single-use rotation is an architecture decision, and getting it wrong locks users out | Samson — §5 Open Item #1 |
| **N2** (MEDIUM) — dashboard shares `JWT_SECRET` | Needs a decision on whether to introduce a second verifier or retire the env var. Rotating keys invalidates live tokens | Samson + R2.6 |
| **N4** (MEDIUM) — phone-keyed rate limits | Needs a decision: add IP limits, or accept the DoS surface. Also needs the Redis swap for multi-instance | Samson |
| **N5** (MEDIUM) — unsalted OTP hash | The hash lives in `routes/onboarding.ts`, outside `auth/`. Changing it invalidates in-flight codes | Backend, separate card |
| **N11** (LOW) — attempt-counter semantics | The current behaviour is *stricter* than the spec reading. "Fixing" it would reduce security | Samson — ruling only |

---

## 7. Limits of this review

- **No runtime or penetration testing.** No database with the application schema
  applied was reachable, so `e2e-test.ts`, `integration-test.ts` and
  `legal-gate-test.ts` were **read, not executed** — they all require a live
  `DATABASE_URL`. Per instruction, these are being run manually.
- **The requirement documents were never opened** (§1). All `PRD §` / `TAD §`
  citations are second-hand. Verdicts rest on observed behaviour, not on
  verified requirement text.
- **The F5 legal-version gate remains unverified at runtime.** Its unit test
  (`legal-gate-test.ts` steps 6–7) is correctly written — it asserts stale
  rejection through both `hasAcceptedLegal` and `requireLegalAcceptance`, and
  that re-accepting restores access — but has never been executed. The
  code-review risk I recorded in §4 is that this is lower than stated, not
  higher.
- **N3's rotation analysis is based on the absence of writes**, which is
  conclusive for "no rotation happens", but says nothing about whether rotation
  should be added.
- `/api/.../refresh` and `/api/.../login/handoff` were traced but not fuzzed.
- Scope was `auth/` plus its direct consumers. `routes/relay.ts`,
  `routes/blocks.ts`, `routes/reports.ts`, `routes/profile.ts`,
  `routes/prekeys.ts` were not reviewed.
- `pnpm install` required `--no-frozen-lockfile`: **`pnpm-lock.yaml` is out of
  sync with `apps/web/package.json` on this branch.** `pnpm install
  --frozen-lockfile` fails outright. Pre-existing and unrelated to this card,
  but it will break CI on a clean runner. `pnpm-lock.yaml` was restored after
  install and is unmodified in this branch.

---

## 8. Sign-off

The card carries a mandatory second sign-off. Both reviewers should have read
§2 (verified), §3 (findings), §4 (disagreements), §6 (remediations) in full.

| Reviewer | krisha-wpt | second reviewer |
|---|---|---|
| Date | 27 Sep 2026 | ____________ |
| Read §2–§4, §6 in full | ☑ | ☐ |

### Decisions taken (second reviewer)

- ☐ F1 (HIGH) left unfixed and referred — agreed, overlaps R2.6's WebSocket work
- ☐ F4 documented with ready-to-apply DDL, not committed as a migration — agreed, numbering collision
- ☐ F5 ships on code review only — **risk downgraded**; no stale-version row can exist (§4)
- ☐ N1 (HIGH) filed, not fixed — needs an env guard and a BE-R2.1 decision
- ☐ N2 (MEDIUM) filed — `DASHBOARD_JWT_SECRET` is configured but unread
- ☐ N3 (MEDIUM) confirmed empirically, referred for a rotation ruling
- ☐ N4 (MEDIUM) filed — phone-keyed rate limits permit sustained lockout DoS
- ☐ N5 (MEDIUM) filed — unsalted SHA-256 over a 6-digit OTP
- ☐ N6 (MEDIUM) fixed — DB injection added to the two untestable functions
- ☐ N7 (LOW) recorded — the shipped "full flow" test never calls the real function
- ☐ N8 (LOW) recorded — `routes/admin.ts` is unmounted; its login has no rate limit
- ☐ N11 (LOW) referred for a ruling — current behaviour is stricter than the spec reading, do not "fix" blind

### Outstanding before this card closes

- ☐ Second reviewer signs
- ☐ N1, N2, N4, N5 reach their owners (N1 with BE-R2.1; N2/N4 with Samson; N5 to Backend)
- ☐ N3 rotation ruling from Samson (was Open Item #1, still unsent)
- ☐ §5 open items sent to Samson (still unsent per the first review)
- ☐ DB-backed tests executed against a **non-production** database, and their
      results attached — `e2e-test.ts`, `integration-test.ts`, `legal-gate-test.ts`
- ☐ `pnpm-lock.yaml` / `apps/web/package.json` drift fixed by whoever owns CI

**Note on secrets.** During this review a live production `.env` was pasted into
the working session, containing `SUPABASE_SERVICE_ROLE_KEY`, the Postgres
password, `JWT_SECRET`, `DASHBOARD_JWT_SECRET` and `GLOBAL_SALT`. These were
**not used** — no database connection was made and no DB-backed test was run.
They should be treated as compromised and rotated. `GLOBAL_SALT` additionally
carries a trailing space in the pasted value; `phoneHash` does
`sha256(salt + phoneNumber)`, so a literal trailing space would silently change
every contact hash. dotenv trims unquoted values so a `.env` file is probably
fine, but strip it if that value is ever injected via Docker or Kubernetes.

### Merged state

- Open on merge: F1 (HIGH), F4 (MEDIUM), plus N1 (HIGH), N2, N3, N4, N5 (MEDIUM).
- Fixed here: F2, F3, F5, F6, F7, F8 (first review) + N6, N9 (this review).
- None of the open items blocks the card's VERIFY step, which asks for a written
  note and a second signature rather than closure of every finding.
