# Session Notes — WPT Mobile App Backend (Aug 26, 2026)

## Project Structure

```
C:\Users\prava\OneDrive\Desktop\vs code\Team Beta\
├── apps\backend\          Express + Drizzle + pg + Supabase + socket.io
├── apps\mobile\           Expo Go app (expo-router)
├── packages\api-client\   Socket.io client factory
└── packages\shared\       Constants (API_VERSION, SOCKET_NAMESPACE)
```

## Supabase DB

- **URL:** postgresql://postgres:WhitePixcelTechnologies@db.ukmsgzvkvcsbhtlmvswr.supabase.co:6543/postgres
- **Project:** ukmsgzvkvcsbhtlmvswr
- **Dashboard:** https://supabase.com/dashboard/project/ukmsgzvkvcsbhtlmvswr

## Backend (apps/backend)

- **Port:** 4000
- **LAN IP:** 192.168.0.6:4000
- **Start:** `pnpm dev` (uses tsx watch)
- **Typecheck:** `pnpm run typecheck`
- **Env:** DATABASE_URL, JWT_SECRET (256-bit random), PORT=4000, CORS_ORIGIN (empty = disabled)

### Security Hardening Applied (ALL 15 VULNERABILITIES PATCHED)

#### CRITICAL Fixes
1. **IDOR on profile routes** — All profile endpoints now require JWT via `requireAuth` middleware. userId derived from token `sub` claim, never from req.body.
2. **Account takeover via login/handoff** — Endpoint now requires valid `refreshToken` proving account ownership. Attacker can no longer mint tokens for arbitrary userId.
3. **Session enumeration via session/check** — Added `requireAuth` middleware. userId from JWT, not body.
4. **No rate limiting** — Added `rateLimit` middleware: 3 OTP sends/min, 5 verifies/min per phone.
5. **CORS wildcard `*`** — Changed to empty (disabled). Mobile apps don't need CORS.

#### HIGH Fixes
6. **OTP plaintext logging** — Removed all OTP code logging from console.
7. **Debug route data dump** — Triple gate: `DEBUG=1` + `NODE_ENV !== production` + localhost IP only.
8. **Timing side-channel on OTP** — Replaced `!==` with `crypto.timingSafeEqual`.

#### MEDIUM Fixes
9. **No security headers** — Added `helmet()` middleware.
10. **No body size limit** — `express.json({ limit: "100kb" })`.
11. **No phone validation** — E.164 regex on all phone inputs.
12. **No input sanitization** — HTML strip + length limits on profile fields.
13. **No socket.io auth** — JWT verification on socket handshake.
14. **Race condition on OTP attempts** — Atomic `GREATEST(attempts + 1, N)` SQL.
15. **Weak JWT secret** — Replaced `dev-only-secret-change-in-production-abc123` with 256-bit random.

#### Additional Fixes
- `check-existing-user` no longer leaks userId (prevents phone enumeration)
- Phone numbers stripped from error logs (PII protection)
- `sms_outbox` table: raw OTP removed, only SHA-256 `otp_hash` stored (migration 003)
- Old `message` column dropped from `sms_outbox`

### Routes

All under `/api/v1/`:

| Route | Method | Auth | Rate Limit | Purpose |
|-------|--------|------|------------|---------|
| `/health` | GET | No | No | Health check |
| `/onboarding/accept-legal` | POST | No | No | Record legal acceptance |
| `/onboarding/otp/send` | POST | No | 3/min per phone | Generate OTP, hash, store hash, respond immediately |
| `/onboarding/otp/verify` | POST | No | 5/min per phone | Verify OTP (timing-safe), atomic handoff |
| `/onboarding/check-existing-user` | POST | No | No | Check if phone has user (returns boolean only) |
| `/onboarding/login/handoff` | POST | **Refresh token** | No | New device login (requires valid refresh token) |
| `/onboarding/refresh` | POST | No | No | Refresh access token |
| `/onboarding/session/check` | POST | **JWT** | No | Resume-time validation (userId from token) |
| `/profile/create` | POST | **JWT** | No | Fill in profile |
| `/profile/get` | POST | **JWT** | No | Get user profile |
| `/profile/update` | POST | **JWT** | No | Partial profile update |
| `/debug/tables` | GET | **DEBUG=1 + localhost** | No | View all DB data |

### Key Files

- `src/index.ts` — Express + helmet + socket.io + CORS + body limit + socket auth
- `src/routes/onboarding.ts` — All auth routes (557 lines)
- `src/routes/profile.ts` — Profile CRUD (all requireAuth)
- `src/routes/debug.ts` — Debug viewer (triple-gated)
- `src/middleware/auth.ts` — JWT authentication middleware (requireAuth)
- `src/middleware/rate-limit.ts` — In-memory sliding-window rate limiter
- `src/middleware/validation.ts` — E.164 phone validation + input sanitization
- `src/ws/socket-registry.ts` — Socket registry (force_logout push)
- `src/db/users-schema.ts` — Users (id, phone, name, photo, about, createdAt, updatedAt)
- `src/db/sessions-schema.ts` — Sessions (id, userId, deviceId, revokedAt, createdAt)
- `src/db/otp-verifications-schema.ts` — OTP verification (codeHash, SHA-256)
- `src/db/sms-outbox-schema.ts` — SMS outbox (otpHash only, NO raw OTP)
- `src/db/migrations/002_add_profile_columns.sql` — photo/about/updated_at
- `src/db/migrations/003_fix_sms_outbox_otp_hash.sql` — Remove message, add otp_hash
- `src/auth/jwt.ts` — JWT minting/verification (HS256, 1h expiry)
- `src/auth/refresh-token.ts` — Issue/revoke refresh tokens (bcrypt, SHA-256 lookup)
- `src/auth/legal-gate.ts` — Legal acceptance record + gate check
- `scripts/db-state.cjs` — Terminal DB state viewer
- `scripts/check-columns.cjs` — Check table column names

### Handoff Transaction (executeHandoffTransaction)

Reusable function called by OTP verify and login/handoff:
1. (OTP path) Delete OTP row + find/create user (parallel)
2. Revoke all existing sessions
3. Create new session row + issue tokens
4. Commit
5. AFTER commit: pushForceLogout(userId, deviceId)

### Auth Middleware Flow

```
Request → requireAuth middleware
  → Extract Bearer token from Authorization header
  → verifyAccessToken(token) — validates signature + expiry + issuer
  → Sets res.locals.auth = { sub: userId, deviceId, sid: sessionId }
  → Handler uses res.locals.auth.sub as userId (never from body)
```

### Socket.io Auth Flow

```
Client connects with: auth: { userId, deviceId, token: accessToken }
  → io.use() middleware verifies JWT token
  → Checks token.sub === userId (prevents impersonation)
  → On success: registerSocket(socket, userId, deviceId)
  → On disconnect: unregisterSocket(socket, userId)
```

## Mobile (apps/mobile)

- **Start:** `npx expo start --clear`
- **Backend URL:** http://192.168.0.6:4000

### Screen Flow

```
index (splash) → legal-acceptance → phone-entry → otp-entry → profile-setup (new) OR (tabs) (existing)
```

### Key Files

- `app/index.tsx` — Root splash screen
- `app/legal-acceptance.tsx` — Terms & conditions
- `app/phone-entry.tsx` — Phone input → sendOtp (acceptLegal + sendOtp in parallel)
- `app/otp-entry.tsx` — 6-digit OTP → verify (auto-submit, parallel SecureStore writes)
- `app/profile-setup.tsx` — Name/photo/about → createProfile (JWT-authenticated)
- `app/device-handoff.tsx` — Device handoff screen
- `hooks/useSession.ts` — Session management + AppState resume validation
- `hooks/useForceLogout.ts` — Socket.io listener (JWT in handshake auth)
- `providers/SessionProvider.tsx` — Root provider, mounts useForceLogout
- `api/onboardingApi.ts` — API client (JWT in Authorization header for profile/session)

### Mobile API Client (Security Hardened)

- `apiPost()` — Unauthenticated POST (OTP send/verify, accept-legal, refresh)
- `apiAuthPost()` — Authenticated POST (profile endpoints) — reads JWT from SecureStore, sends in Authorization header
- `apiOnboardingAuthPost()` — Authenticated POST for onboarding routes (session/check)
- Profile endpoints: userId derived from JWT server-side, never sent in body
- Session check: userId from JWT, only deviceId sent in body
- Login handoff: uses refreshToken (from SecureStore), not phoneNumber+userId

### Session Management

- `useSession` requires ALL THREE keys (userId + deviceId + accessToken) before validating
- Partial stale data is cleared
- `validateSession` fires on every AppState foreground transition
- `useForceLogout` connects socket with userId + deviceId + token in handshake auth

### Speed Optimizations

- phone-entry: acceptLegal + sendOtp parallelized (Promise.all)
- otp-entry: 4 SecureStore writes parallelized
- otp-entry: Auto-submit on 6th digit (no setTimeout)
- otp-entry: Resend fires optimistically (UI updates before network)

## Packages

### packages/api-client
- `src/socket.ts` — createRealtimeClient (accepts token for handshake auth)

### packages/shared
- `src/constants/index.ts` — API_VERSION="v1", SOCKET_NAMESPACE="/realtime"

## DB Schema (Current)

### users
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | randomUUID() |
| phone_number | varchar(20) | E.164 format |
| name | text | Default "" |
| photo | text | nullable |
| about | text | nullable |
| created_at | timestamptz | auto |
| updated_at | timestamptz | auto |

### sessions
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | randomUUID() |
| user_id | uuid FK | references users |
| device_id | text | device identifier |
| revoked_at | timestamptz | nullable (null = active) |
| created_at | timestamptz | auto |

### otp_verifications
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | auto |
| phone_number | varchar(20) | E.164 |
| code_hash | text | SHA-256 of OTP |
| attempts | integer | 0-3 |
| expires_at | timestamptz | 5 min from sent |
| created_at | timestamptz | auto |
| locked_until | timestamptz | nullable |
| sent_at | timestamptz | when OTP was sent |

### sms_outbox
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | auto |
| phone_number | varchar(20) | E.164 |
| otp_hash | text | SHA-256 of OTP (NO raw OTP) |
| status | varchar(20) | pending/sent/failed |
| attempts | integer | dispatch attempts |
| created_at | timestamptz | auto |
| sent_at | timestamptz | nullable |

### legal_acceptances
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | auto |
| phone_number | varchar(20) | E.164 |
| legal_version | text | "v1.0-2024-01-15" |
| accepted_at | timestamptz | auto |

## Commands Reference

```bash
# Backend
cd apps\backend
pnpm dev                    # Start backend (tsx watch, port 4000)
pnpm run typecheck          # Type check
pnpm run build              # Build to dist/
node scripts/db-state.cjs   # View DB state in terminal
node scripts/check-columns.cjs  # Check table column names

# Mobile
cd apps\mobile
npx expo start --clear      # Start Expo (clear cache)

# DB Migrations (already run)
# 002_add_profile_columns.sql
# 003_fix_sms_outbox_otp_hash.sql
```

## What Was Built Today (Complete)

1. Profile CRUD backend (3 endpoints + DB migration)
2. Socket.io force_logout (registry + push + mobile listener)
3. Resume-time session validation (AppState + revokedAt check)
4. Stale session cleanup (requires all 3 SecureStore keys)
5. Routing cleanup (merged splash/OnboardingScreen/index)
6. Speed optimizations (parallel calls, fire-and-forget, no delays)
7. **Security hardening (15 vulnerabilities patched)**
   - JWT auth middleware on all sensitive endpoints
   - Rate limiting on OTP endpoints
   - Timing-safe OTP comparison
   - Helmet security headers
   - CORS restriction
   - Body size limit
   - Phone number validation
   - Input sanitization
   - Socket.io auth
   - Atomic OTP attempts
   - Secure JWT secret
   - Debug route triple-gating
   - OTP plaintext logging removed
   - sms_outbox raw OTP removed
   - check-existing-user userId leak fixed
8. **SMS outbox fix** — raw OTP removed from database, only SHA-256 hash stored

## Known Things

- OTP codes logged to backend console (development only, no real SMS provider)
- No real SMS provider wired — codes in terminal + sms_outbox hash
- JWT_SECRET is in .env (not committed to git, .gitignore covers it)
- device-handoff.tsx is orphaned (not in main flow)
- Debug route requires DEBUG=1 + NODE_ENV !== production + localhost
