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
- **Env:** DATABASE_URL, JWT_SECRET, PORT=4000, DEBUG=1 (for debug route)

### Routes

All under `/api/v1/`:

| Route | Method | Purpose |
|-------|--------|---------|
| `/health` | GET | Health check |
| `/onboarding/accept-legal` | POST | Record legal acceptance |
| `/onboarding/otp/send` | POST | Generate OTP, hash with SHA-256, store hash, respond immediately, fire-and-forget insert+sms_outbox |
| `/onboarding/otp/verify` | POST | Verify OTP (hash comparison), atomic handoff transaction (delete OTP + find/create user + revoke sessions + create session + issue tokens), push force_logout after commit |
| `/onboarding/check-existing-user` | POST | Check if phone number has existing user |
| `/onboarding/login/handoff` | POST | New device login (atomic handoff transaction) |
| `/onboarding/refresh` | POST | Refresh access token |
| `/onboarding/session/check` | POST | Resume-time validation (checks revokedAt) |
| `/profile/create` | POST | Fill in profile (name, photo, about) |
| `/profile/get` | POST | Get user profile |
| `/profile/update` | POST | Partial profile update |
| `/debug/tables` | GET | View all DB data (requires DEBUG=1) |

### Key Files

- `src/index.ts` — Express + socket.io server, registers all routes + socket registry
- `src/routes/onboarding.ts` — All auth routes (547 lines)
- `src/routes/profile.ts` — Profile CRUD (new today)
- `src/routes/debug.ts` — Debug data viewer (requires DEBUG=1 env)
- `src/ws/socket-registry.ts` — Socket.io registry (tracks userId → sockets, pushes force_logout)
- `src/db/users-schema.ts` — Users table (id, phone, name, photo, about, createdAt, updatedAt)
- `src/db/sessions-schema.ts` — Sessions table (id, userId, deviceId, revokedAt, createdAt)
- `src/db/otp-verifications-schema.ts` — OTP verification rows
- `src/db/sms-outbox-schema.ts` — SMS outbox pattern
- `src/db/migrations/002_add_profile_columns.sql` — ALTER TABLE for photo/about/updated_at
- `src/auth/refresh-token.ts` — Issue/revoke refresh tokens (accepts optional db param for transactions)
- `src/auth/jwt.ts` — JWT access token minting
- `src/auth/legal-gate.ts` — Legal acceptance record + gate check
- `scripts/db-state.cjs` — CLI script to view all DB data

### Handoff Transaction (executeHandoffTransaction)

Reusable function called by both OTP verify and login/handoff:
1. (OTP path) Delete OTP row + find/create user (parallel)
2. Revoke all existing sessions
3. Create new session row
4. Issue JWT access token
5. Commit
6. AFTER commit: pushForceLogout(userId, deviceId)

### Speed Optimizations Applied

- `otp/send`: Respond after delete, insert+sms_outbox fire-and-forget (saves 150-300ms)
- `otp/verify` transaction: Delete OTP + select user parallelized (saves 50-100ms)
- `accept-legal`: Kept synchronous (must complete before OTP verify checks it)

## Mobile (apps/mobile)

- **Start:** `npx expo start --clear` (clear Metro cache)
- **Backend URL:** http://192.168.0.6:4000 (in .env as EXPO_PUBLIC_BACKEND_URL)

### Screen Flow

```
index (splash "ONB") → legal-acceptance → phone-entry → otp-entry → profile-setup (new) OR (tabs) (existing)
```

### Key Files

- `app/index.tsx` — Root splash screen (tap → legal-acceptance)
- `app/legal-acceptance.tsx` — Terms & conditions
- `app/phone-entry.tsx` — Phone number input → send OTP (acceptLegal + sendOtp in parallel via Promise.all)
- `app/otp-entry.tsx` — 6-digit OTP input → verify (auto-submits on 6th digit, SecureStore writes in parallel)
- `app/profile-setup.tsx` — Name/photo/about for new users → POST /profile/create
- `app/device-handoff.tsx` — Device handoff (orphaned, not in main flow)
- `hooks/useSession.ts` — Session management + AppState resume validation (checks revokedAt on foreground)
- `hooks/useForceLogout.ts` — Socket.io force_logout listener (clears session, navigates to phone-entry)
- `providers/SessionProvider.tsx` — Root provider, mounts useForceLogout
- `api/onboardingApi.ts` — API client (all HTTP calls to backend)

### Speed Optimizations Applied

- phone-entry: acceptLegal + sendOtp parallelized with Promise.all
- otp-entry: 4 SecureStore.setItemAsync calls parallelized
- otp-entry: Auto-submit on 6th digit (removed 220ms setTimeout)
- otp-entry: Resend fires optimistically (UI updates before network)

### Session Management

- `useSession` requires ALL THREE keys (userId + deviceId + accessToken) before validating
- Partial stale data is cleared (prevents bypass of onboarding flow)
- `validateSession` fires on every AppState foreground transition (before any other network call)
- `useForceLogout` connects socket with userId + deviceId in handshake auth

## Packages

### packages/api-client
- `src/socket.ts` — createRealtimeClient (accepts userId + deviceId for handshake auth)
- Exports: createRealtimeClient, RealtimeClientConfig

### packages/shared
- `src/constants/index.ts` — API_VERSION="v1", SOCKET_NAMESPACE="/realtime", SOCKET_TRANSPORT_PRIMARY="websocket", SOCKET_TRANSPORT_FALLBACK="polling"

## DB State Viewer

### CLI
```bash
cd apps\backend && node scripts\db-state.cjs
```

### Web (requires DEBUG=1 env)
```bash
$env:DEBUG="1"; pnpm dev
# Then open: http://localhost:4000/api/v1/debug/tables
```

### Supabase Dashboard
https://supabase.com/dashboard/project/ukmsgzvkvcsbhtlmvswr → Table Editor

## What Was Built Today (Complete List)

1. **Profile CRUD backend** — 3 endpoints (create/get/update) + DB migration for photo/about/updated_at columns
2. **Socket.io force_logout** — Socket registry, push after handoff transaction commits, mobile listener
3. **Resume-time session validation** — AppState listener, checks revokedAt on foreground, fixed /session/check endpoint
4. **Stale session cleanup** — Requires all 3 SecureStore keys, clears partial data
5. **Routing cleanup** — Merged splash/OnboardingScreen/index into single root route, deleted orphan files
6. **Speed optimizations** — Parallelized network calls, removed delays, fire-and-forget DB writes

## Known Things

- OTP codes are logged to backend console (no real SMS provider wired)
- mockOnboardingApi.ts is unused (can be deleted)
- device-handoff.tsx is orphaned (not in main flow)
- No real SMS provider — codes appear in terminal + sms_outbox table
- JWT_SECRET is in .env (not committed to git)

## Commands Reference

```bash
# Backend
cd apps\backend
pnpm dev                    # Start backend (tsx watch, port 4000)
pnpm run typecheck          # Type check
pnpm run build              # Build to dist/
node scripts/db-state.cjs   # View DB state in terminal

# Mobile
cd apps\mobile
npx expo start --clear      # Start Expo (clear cache)
npx expo start              # Start Expo (keep cache)

# Database migration (already run)
# apps\backend\src\db\migrations\002_add_profile_columns.sql
```
