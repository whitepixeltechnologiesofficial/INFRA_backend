How migrations work

Files run in name order: 000, 002, 003, 004, 004b, 005 …

Every migration must be safe to run twice (use IF NOT EXISTS / IF EXISTS).

A new migration takes the next free number on main.

Check that the whole database builds from empty:
pnpm --filter @wpt/backend exec node scripts/db-rebuild-check.mjs

Reserved numbers (Sprint 3.5)

020: not used

021, 022: Team Alpha, card A3 (DB-2.6, DB-2.1)

023: Team Charlie, card C3 (BE-5.7 group fan-out)

024: Team Alpha, card A4 (test tables to their own schema)
