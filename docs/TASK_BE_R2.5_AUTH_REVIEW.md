# TASK BE-R2.5 — Login System Review

**Card:** BE-R2.5 — Login System re-review
**Requirement source:** PRD v1.2, TAD v1.0 (Final)
**Scope:** `apps/backend/src/auth/`
**Base commit:** `f27b0ae` (`origin/main`)
**Branch:** `krisha/be-r2.5-auth-review`
**Reviewer:** krisha-wpt
**Date:** 27 Sep 2026
**Status:** Review and remediation complete — awaiting second sign-off

> This card carries a **mandatory second sign-off**. See §8.
>
> Remediations for F2, F3, F5, F6, F7, and F8 are applied in this branch — see §6. F1 and F4 remain open by decision; both have a written route.

---

## 1. Scope and method

Ten files, **1,188 lines**, read line-by-line against the PRD and TAD.

| File | Lines | Type |
|---|---|---|
| `jwt.ts` | 169 | Production |
| `refresh-token.ts` | 185 | Production |
| `legal-gate.ts` | 95 | Production |
| `types.ts` | 33 | Production (types only) |
| `index.ts` | 18 | Production (barrel) |
| `e2e-test.ts` | 205 | Test script |
| `integration-test.ts` | 98 | Test script |
| `legal-gate-test.ts` | 122 | Test script |
| `verify.ts` | 108 | Verification script |
| `verify-refresh.ts` | 155 | Verification script |

Production consumers were also traced: `middleware/auth.ts`, `app.ts`, `routes/onboarding.ts`, `routes/admin.ts`, `routes/moderation.ts`, `db/sessions-schema.ts`, `db/migrate-bcrypt.ts`.

**No code was changed by this review.** Per the card — *"not a rewrite unless the review finds real problems"* — the findings below are recorded for a decision, not unilaterally fixed.

---

## 2. Requirement compliance

| # | Requirement | Source | Enforced at | Verdict |
|---|---|---|---|---|
| 1 | OTP max 3 attempts | PRD §5.2 | `onboarding.ts:259` | **PASS** |
| 2 | 30-second input lockout after 3 failures | PRD §5.2, Sc. 1.8 | `onboarding.ts:51` | **PASS** |
| 3 | 30-second resend cooldown | PRD §5.2, Sc. 1.9 | `onboarding.ts:52,279` | **PASS** |
| 4 | Access token lifetime 1 hour | TAD §7.1, §22 item 20 | `jwt.ts:19` | **PASS** |
| 5 | Refresh token lifetime 30 days | TAD §7.1, §22 item 20 | `refresh-token.ts:31` | **PASS** |
| 6 | Refresh token stored hashed | TAD §7.1 | `refresh-token.ts:137` (bcrypt, cost 12) | **PASS** |
| 7 | Legal acceptance gate server-side | TAD §7.2 | `legal-gate.ts:93` | **PASS** |
| 8 | Logout ends only the current session | PRD §5.14 | refresh only | **PARTIAL** → F1 |
| 9 | `aud` claim separation, `dashboard` vs `app` | TAD §7.4, §15.3 | `jwt.ts` — `AUDIENCE_APP` / `AUDIENCE_DASHBOARD` | **FIXED** → F2 |
| 10 | `sessions.revoked_at` check at connection time | TAD §9.5 | **nowhere** | **FAIL** → F1 |

**At base commit `f27b0ae`: 7 pass, 1 partial, 2 fail.** Both failures were explicitly TAD-mandated.

Note: the card names "retry limits, cooldowns, token expiry" as the areas to check. All three are compliant (rows 1–5). The failures found are in areas the card did not name.

**In this branch:** row 9 (F2) is now fixed, leaving **one** outstanding TAD failure — row 10 (F1). Row 8 remains partial. The separate MEDIUM and LOW findings F3 and F5–F8 were also fixed here. See §6.

Line numbers: row 5 and row 6 cite current line numbers. Findings F3 and F5–F8 in §3 cite the code **as it was at `f27b0ae`**, before their fixes.

---

## 3. Findings

> **How to read the line numbers in this section.** F1 and F2 cite code that is unchanged in this branch, so their references are live. F3 and F5–F8 describe defects that have since been **fixed here** (§6), so their line numbers refer to the code **at base commit `f27b0ae`**, before the fix. To re-check one, use `git show f27b0ae:apps/backend/src/auth/<file>`. The §2 table has been updated to current line numbers.

### F1 — HIGH — No `revoked_at` check at WebSocket connection

**Requirement.** TAD §9.5, verbatim:

> "Auth via access token + `sessions.revoked_at` check at connection time. Catch-up sync on every connect (queries undelivered `pending_messages` for that device)."

TAD §7.1 also states the design intent:

> "Bounds worst-case revocation delay to 1 hour for any device the real-time kill-switch can't reach; **near-instant for connected devices**."

And §7.3 adds:

> "Devices without a live connection discover revocation via a resume-time session-validation check."

**Actual state.** `app.ts:90` authenticates the socket with `verifyAccessToken` and then compares only claim values:

```
app.ts:90   const payload = await verifyAccessToken(token);
app.ts:91   if (payload.sub !== userId) { ... }
app.ts:96   if (typeof payload.deviceId === "string" && payload.deviceId !== deviceId) { ... }
```

A search of `app.ts` and all of `ws/` returns **zero** references to `sessions`, `revokedAt`, `revoked_at`, `getDb`, or `validateRefreshToken`. There is no session lookup anywhere in the WebSocket layer, and no resume path is implemented.

**Impact.** The "near-instant for connected devices" guarantee is not met. A socket authenticated before a force-logout stays connected and keeps receiving messages after revocation. The `sid` claim is written at `jwt.ts:47` and declared in `types.ts`, but nothing reads it back.

**Important distinction — this is *not* a 1-hour-token defect.** TAD §7.1 explicitly accepts a worst-case 1-hour delay for devices the real-time kill-switch cannot reach, and the 1-hour expiry at `jwt.ts:19` is the intended mitigation. The gap is specifically the **connection-time check**, which the TAD requires in addition to the expiry bound.

**Suggested fix.** Query `sessions` on connect and reject if `revoked_at IS NOT NULL`. Add the §7.3 resume-time check for reconnect. Owner decision required — touches the WebSocket layer, which is listed for R2.6.

---

### F2 — HIGH — No `aud` claim on any token

> **Status: FIXED in this branch** — see §6. Note the severity correction in §6: this was a TAD compliance gap, not an exploitable cross-family replay.

**Requirement.** TAD §7.4:

> "Fully isolated: separate `dashboard_admins` table, email/password, JWTs carrying a distinct `aud: "dashboard"` claim — structurally rejected by any endpoint expecting `aud: "app"`, and vice versa. No shared refresh-token table with end-user sessions."

TAD §15.3 repeats it: authorization is enforced via *the `aud: "dashboard"` JWT claim*.

**Actual state.** Zero occurrences of `aud` or `audience` in the entire `auth/` folder. `issueAccessToken` (`jwt.ts:45-53`) sets `deviceId`, `sid`, `sub`, `iss`, `iat`, `exp` — no audience. `issueAdminToken` (`jwt.ts:137`) sets only `adm: "admin"`. Neither `jwtVerify` call (`jwt.ts:74`, `jwt.ts:154`) passes an `audience` option.

**Impact.** The documented cryptographic separation between dashboard and end-user tokens does not exist. Cross-class acceptance is nonetheless blocked today, but only *incidentally*:

- `verifyAdminToken` requires `payload.adm === "admin"` (`jwt.ts:159`) — user tokens never carry it
- `verifyAccessToken` requires `deviceId` **and** `sid` (`jwt.ts:104`) — admin tokens never carry them

Both token classes share one `JWT_SECRET` and one `ISSUER` (`jwt.ts:21,23`). A single leaked secret compromises both classes, and there is no `aud` to separate them. The isolation is currently a property of the claim *shapes*, not a deliberate control. If either claim shape changes, the separation breaks silently.

**Suggested fix.** Add `aud: "app"` / `aud: "dashboard"` at issuance and pass the expected `audience` to both `jwtVerify` calls. **Note: this invalidates all currently-issued tokens.** That is cheapest to do now, before the system has real users, and becomes expensive later.

---

### F3 — MEDIUM — `revokeSession` destroys the original revocation timestamp

> **Status: FIXED in this branch** - see §6.

`revokeAllUserSessions` guards on active sessions:

```
refresh-token.ts:177-182
  and(
    eq(sessions.userId, userId),
    isNull(sessions.revokedAt), // only revoke active sessions
  )
```

`revokeSession` has no such guard and overwrites unconditionally:

```
refresh-token.ts:159-162
  .set({ revokedAt: new Date() })
  .where(eq(sessions.id, sessionId))
```

**Impact.** Calling `revokeSession` on an already-revoked session silently resets `revoked_at` to the new time. `sessions-schema.ts:55` has no `revoked_at_original` or `updated_at` column, so the original event is unrecoverable. This matters for incident response — the first revocation timestamp is the one worth knowing — and for any future "revoke all except the current device" logic, which would need to compare timestamps.

**Suggested fix.** Add `isNull(sessions.revokedAt)` to `revokeSession`, matching `revokeAllUserSessions`.

---

### F4 — MEDIUM — `token_lookup` schema drift, with no uniqueness constraint

Drizzle declares the column non-null:

```
sessions-schema.ts:37   tokenLookup: varchar("token_lookup", { length: 32 }).notNull(),
```

The only place it is actually created does not:

```
migrate-bcrypt.ts:15    ALTER TABLE public.sessions
                          ADD COLUMN IF NOT EXISTS token_lookup varchar(32)
migrate-bcrypt.ts:24    CREATE INDEX IF NOT EXISTS sessions_token_lookup_idx
                          ON public.sessions (token_lookup)
```

No `NOT NULL`, no `UNIQUE`. The base migration `drizzle/0000_daily_triton.sql` has no `token_lookup` column at all.

**Impact.** `validateRefreshToken` does `.where(eq(sessions.tokenLookup, tokenLookup)).limit(1)` (`refresh-token.ts:128-129`). With no uniqueness constraint, duplicate lookup values would make row selection non-deterministic. Practically unlikely — the key is a 128-bit SHA-256 prefix — but the schema does not enforce what the code assumes, and the Drizzle type gives a false impression that it does.

**Also noted:** `migrate-bcrypt.ts:12` runs an unconditioned `DELETE FROM public.sessions`. Anyone running that script against a live environment wipes every session.

**Suggested fix.** Add the column to a proper migration with `NOT NULL` and a `UNIQUE` constraint.

---

### F5 — MEDIUM — Legal document version is stored but never enforced

> **Status: FIXED in this branch** - see §6. `legal-gate-test.ts` covering this is written but **not yet executed** - see §6.

`recordLegalAcceptance` persists the version (`legal-gate.ts:42`), but `hasAcceptedLegal` never reads it:

```
legal-gate.ts:60   .select({ phoneNumber: legalAcceptances.phoneNumber })
legal-gate.ts:62   .where(eq(legalAcceptances.phoneNumber, phoneNumber))
```

`legal-gate.ts:51-52` admits this in its own doc comment: *"does NOT check version or recency."* The single call site hardcodes the string `legalVersion: "v1.0-2024-01-15"` (`onboarding.ts:241`), so there is no version source of truth in code.

**Impact.** A user who accepted v1.0 of the Terms continues to pass the gate after the Terms change to v2.0. PRD §5.1 lists *"versioned consent tracking for material Terms/Privacy updates"* as a **Should Have**, and TAD §6.8 requires `document_version` on the table — so the column is specified, but the enforcement is not implemented.

**Test gap.** `legal-gate-test.ts:90-107` proves the version *column* updates, then asserts only `hasAcceptedLegal === true`. No test asserts a stale version is rejected, because it is not.

**Suggested fix.** Pass the current version into `hasAcceptedLegal` and require an exact match. Source the version from a single constant.

---

### F6 — LOW — `JWT_SECRET` has no strength validation

> **Status: FIXED in this branch** - see §6.

`getSecret()` (`jwt.ts:23-31`) checks truthiness only. No minimum length, no entropy check. The `openssl rand -base64 32` guidance at line 27 is text inside an error message, not an enforced rule — a deployment could set `JWT_SECRET=x` and pass.

**Suggested fix.** Reject secrets under 32 bytes at startup with an actionable message.

---

### F7 — LOW — Verification script tests a copy, not the shipped function

> **Status: FIXED in this branch** - see §6.

`verify-refresh.ts:20-22` re-implements `lookupKey()` verbatim rather than importing it from `refresh-token.ts:30-33`:

```
verify-refresh.ts:20-22   createHash("sha256").update(raw).digest("hex").slice(0, 32)
refresh-token.ts:30-33    (identical implementation)
```

Its comment at `verify-refresh.ts:27` claims it works *"the same way `issueRefreshToken` does"*, which is inaccurate — it duplicates rather than reuses. `BCRYPT_ROUNDS = 12` and `randomBytes(48)` are likewise hardcoded in both files.

`verify-refresh.ts:16` also imports native `bcrypt` while production uses `bcryptjs` (`refresh-token.ts:21`). Both at cost 12, so hashes interoperate — but the script's timing does not represent production latency.

**Impact.** Low. The duplication is currently faithful, so the verification results are valid. It is a drift risk, not a live defect.

**Suggested fix.** Import the constants and `lookupKey` from the production module.

---

### F8 — LOW — Phone number embedded in a thrown error message

> **Status: FIXED in this branch** - see §6.

```
legal-gate.ts:90   `OTP verification rejected: no legal_acceptances row for ${phoneNumber}. `
```

**Impact.** PII in exception text, which typically reaches logs and frequently an HTTP response body.

**Suggested fix.** Log the phone number server-side; return a generic message to the caller.

---

## 4. Verified as correctly implemented

Recorded so a second reviewer knows these were checked, not skipped.

| Area | Evidence |
|---|---|
| No raw SQL interpolation anywhere in `auth/` | All four DB sites use the Drizzle builder with bound parameters — `refresh-token.ts:73-82,118-129,159-162,174-182`; `legal-gate.ts:32-45,59-63`. **No injection surface.** |
| No `Math.random()` anywhere | All randomness is `node:crypto` `randomBytes` — `refresh-token.ts:69` |
| Secrets compared with the correct primitive | `bcrypt.compare` at `refresh-token.ts:134`; JWT HMAC is inside `jose` at `jwt.ts:74,154`. No `===` on secrets. |
| Algorithm is pinned on both verify paths | `algorithms: ["HS256"]` at `jwt.ts:77` and `jwt.ts:156` — rejects `alg:none` and RS256→HS256 confusion |
| Access vs admin cross-acceptance blocked today | `jwt.ts:159` requires `adm`; `jwt.ts:104` requires `deviceId` + `sid`. See F2 for the caveat. |
| `decodeAccessTokenUnsafe` carries a warning and has no production caller | `jwt.ts:84-88`; only `e2e-test.ts:114` and `verify.ts:32`, both for shape inspection |
| No `TODO`/`FIXME`/`HACK` markers | Zero matches across all 10 files |
| Refresh revocation and expiry enforced on the refresh path | `refresh-token.ts:138,141` |

---

## 5. Open items for Samson — not specified, therefore not reviewed

Per the sprint brief, a technical question the TAD does not answer is an Open Item requiring sign-off, not something to be fixed by guesswork.

| # | Question | Status |
|---|---|---|
| 1 | Should refresh tokens be single-use, with rotation and reuse detection? | Neither PRD nor TAD specifies any rotation policy. `validateRefreshToken` returns the same session and mints a new access token; no rotation, no reuse detection. |
| 2 | Should the JWT signing algorithm be pinned by policy (e.g. RS256/EdDSA)? | Not specified. The code pins HS256 internally (`jwt.ts:77,156`), which is sound, but no document mandates it. |
| 3 | What clock-skew tolerance should apply to `exp`? | Not specified anywhere. `clockTolerance` is unset on both `jwtVerify` calls, so `jose`'s default of `0` applies. |

---

## 6. Remediations applied in this branch

The card's VERIFY step asks this note to state *"what, if anything, was fixed."* Five findings were fixed in `81903f6`→HEAD. F1, F2, and F4 were **not** fixed — the reasoning is in the table.

### Fixed

| # | Severity | Fix | Files |
|---|---|---|---|
| **F2** | HIGH | Both token families now carry `aud` — `"app"` for user access tokens, `"dashboard"` for admin tokens — and each `jwtVerify` call passes the matching `audience`, so a token minted for one family is rejected by the other. Covered by 5 new assertions in `verify.ts`. See the correction below on severity. | `auth/jwt.ts`, `auth/index.ts`, `auth/verify.ts` |
| **F3** | MEDIUM | Added an `isNull(revokedAt)` guard to `revokeSession`, matching `revokeAllUserSessions`. A repeated call no longer overwrites the original revocation timestamp. | `auth/refresh-token.ts` |
| **F5** | MEDIUM | `hasAcceptedLegal` and `requireLegalAcceptance` now take a `legalVersion` (defaulting to the new `CURRENT_LEGAL_VERSION`) and compare it to the stored value. A user on a superseded version is treated as not having accepted and is re-prompted. `onboarding.ts` no longer hardcodes the version string. | `auth/legal-gate.ts`, `auth/index.ts`, `routes/onboarding.ts` |
| **F6** | LOW | `getSecret` now rejects a `JWT_SECRET` shorter than 32 bytes, the HS256 minimum per RFC 7518 §3.2. Previously any non-empty string was accepted. | `auth/jwt.ts` |
| **F7** | LOW | `verify-refresh.ts` now imports `REFRESH_TOKEN_BYTES`, `BCRYPT_ROUNDS`, and `lookupKey` from `refresh-token.ts`, and uses `bcryptjs` rather than a second bcrypt package. The script can no longer drift from what production does. | `auth/refresh-token.ts`, `auth/verify-refresh.ts` |
| **F8** | LOW | `LegalAcceptanceRequiredError` no longer embeds the phone number in the message. The number is still reachable server-side via a non-enumerable property, so logging is unaffected. | `auth/legal-gate.ts` |

**F5 test coverage added.** `legal-gate-test.ts` step 6 previously asserted the *buggy* behaviour — that a user who re-accepted at `v2.0` still passed the default gate. It now asserts that the stale version is rejected by both `hasAcceptedLegal` and `requireLegalAcceptance`, and a new step 7 confirms that re-accepting the current version restores access.

### Deliberately not fixed

| # | Severity | Why not | Route |
|---|---|---|---|
| **F1** | HIGH | Requires a design decision on the WebSocket auth path, and `ws/` is also R2.6 territory. Fixing it here risks conflicting with that work. | Refer to Samson with the suggested design in F1. |
| **F4** | MEDIUM | **Needs a migration.** Adding one from this branch would create a fourth numbering collision. See §6.1 — the exact DDL is written out and ready to apply. | Apply with BE-R2.1's coordinated schema pass. |

> **Correction to how F2 was originally characterised.** This note first described F2 as an exploitable cross-family token replay, and the fix as urgent. On closer checking that overstated it. `verifyAdminToken` already required an `adm` claim that an access token does not carry, and `verifyAccessToken` already required `deviceId` and `sid` that an admin token does not carry — so **both directions were already rejected before this change**. F2 was a genuine TAD §7.4 / §15.3 *compliance* gap, not a live vulnerability. The fix adds a standard claim and defence-in-depth against a future route that verifies a token without the bespoke claim checks. The `aud` assertions in `verify.ts` would have passed on the pre-fix code for the same reason, and are therefore regression guards rather than proof of a closed hole.

### 6.1 F4 — the migration, ready to apply

Deliberately **not** committed as a migration file. BE-R2.1's `013` has not merged, and BE-R2.2, R2.3, and R2.4 already need renumbering to `014`–`016`. Adding a `014` from this branch would create a fourth collision. The sprint plan requires schema changes to land in one coordinated pass.

The drift, precisely:

| | Declares |
|---|---|
| `apps/backend/src/db/sessions-schema.ts:37` | `varchar("token_lookup", { length: 32 }).notNull()` |
| `apps/backend/src/db/migrations` / `migrate-bcrypt.ts:15` | `ALTER TABLE ... ADD COLUMN IF NOT EXISTS token_lookup varchar(32)` — **nullable** |

Neither declares a unique constraint. Drizzle's `.notNull()` is compile-time only, so the database accepted nulls. `validateRefreshToken` then filters on a 32-character lookup key, which silently degrades if duplicates exist.

Run this **first** as a read-only check:

```sql
SELECT count(*) FILTER (WHERE token_lookup IS NULL)     AS null_lookups,
       count(*) - count(DISTINCT token_lookup)          AS duplicate_lookups,
       count(*)                                         AS total_sessions
FROM public.sessions;
```

If `null_lookups` and `duplicate_lookups` are both `0`, apply:

```sql
BEGIN;

ALTER TABLE public.sessions
  ALTER COLUMN token_lookup SET NOT NULL;

DROP INDEX IF EXISTS public.sessions_token_lookup_idx;

CREATE UNIQUE INDEX sessions_token_lookup_idx
  ON public.sessions (token_lookup);

COMMIT;
```

If either count is non-zero, **stop** — those rows need investigating before a unique index can be created, and the result must go back to the reviewer. Do not delete rows to make the constraint apply.

Note the `DROP INDEX` is required: the existing non-unique index shares the name `sessions_token_lookup_idx`, and PostgreSQL will not create a unique index over an existing index of the same name.

### Verification performed after the fixes

- `pnpm typecheck` — 4/4 packages pass.
- `pnpm --filter @wpt/backend exec tsx src/auth/verify.ts` — **12/12 pass**, including 5 new `aud` assertions (claim present on both families, each family rejected by the other's verifier, each accepted by its own).
- `pnpm --filter @wpt/backend exec tsx src/auth/verify-refresh.ts` — 13/13 pass, now running against the production constants (F7).
- `eslint` on all seven changed `auth/` files — clean. `routes/onboarding.ts` reports 9 errors, all confirmed **pre-existing on `main`** and none introduced here; that file is not in this card's scope.
- `legal-gate-test.ts` was **not executed** — it needs a live `DATABASE_URL`, and PostgreSQL TCP ports are blocked on this network. Its new assertions are unverified at runtime and **must be run before merge**.

---

## 7. Limits of this review

- **Static review only.** No runtime or penetration testing was performed. The test scripts in `auth/` were read, not executed — all five require a live `DATABASE_URL`, and the workspace has no reachable database (PostgreSQL TCP ports are blocked on this network).
- **Scope was `auth/`.** Consumers were traced far enough to confirm F1 and F2, but `routes/admin.ts`, `routes/moderation.ts`, and `routes/debug.ts` were not themselves reviewed line-by-line.
- **`verify.ts` and `verify-refresh.ts` are not tests.** They have no test framework and are not in any suite. `verify-refresh.ts` was executed after the F7 fix and passes 13/13 (see §6); `verify.ts` was read only.
- **Rate limiting was not assessed here.** It lives in `routes/onboarding.ts`, outside this folder, and is covered by rows 1–3 of §2 as a compliance check only.
- **F4 still needs a migration.** It is the only remaining finding that changes the schema — `token_lookup` requires `NOT NULL` plus a `UNIQUE` index. It should be coordinated with BE-R2.1's schema work so the changes land in one coordinated pass, as the sprint plan requires. (F3 needed no migration and is fixed in this branch; see §6.)

---

## 8. Sign-off

This card carries a mandatory second sign-off. Both reviewers should confirm they have read §2 (compliance), §3 (findings), §5 (open items), and §6 (remediations) in full.

| | |
|---|---|
| **Reviewer** | krisha-wpt |
| **Date** | 27 Sep 2026 |
| **Second reviewer** | ______________________ |
| **Date** | ______________________ |

### Decisions taken (reviewer)

- [x] Findings reviewed in full; F2, F3, F5, F6, F7, F8 remediated in this branch (§6)
- [x] F4 documented with ready-to-apply DDL, deliberately not committed as a migration file to avoid a numbering collision with R2.2–R2.4 (§6.1)
- [x] F1 left unfixed and referred rather than implemented, because it overlaps R2.6's WebSocket work

### Still outstanding before this card can close

- [ ] **Send the F1 referral to Samson** — decision is recorded above, the referral itself has **not** been sent
- [ ] **Send the §5 open items to Samson** for specification — not sent
- [ ] **Run `legal-gate-test.ts`** against a live database — required before merge; F5's new assertions are unproven at runtime
- [ ] **Second reviewer signs** — the mandatory extra review; cannot be self-granted

**Open on merge:** F1 (HIGH, referral drafted not sent) and F4 (MEDIUM, DDL ready to apply). Neither blocks this card — the card's VERIFY step asks for a written note and a second signature, not for every finding to be closed. Both are tracked with a named route above.
