import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { assertTls, createPool } from "./pool.js";
import * as schema from "./schema.js";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _pool: pg.Pool | null = null;

/**
 * Returns a shared Drizzle instance backed by a pg Pool.
 *
 * The pool reads DATABASE_URL from the environment once and reuses
 * connections for the lifetime of the process. Transport security is decided in
 * pool.ts, so a missing or unsafe sslmode fails here rather than at query time.
 * Call assertDbTransport() once at startup to confirm the socket is encrypted.
 */
export function getDb() {
  if (_db) return _db;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  _pool = createPool({ connectionString });
  _db = drizzle(_pool, { schema });
  return _db;
}

/** Confirms the live connection is encrypted. Call during bootstrap. */
export async function assertDbTransport(): Promise<void> {
  if (!_pool) getDb();
  await assertTls(_pool!, process.env.DATABASE_URL!);
}

export { schema };

/** Drizzle database type — use for optional db parameters in auth functions. */
export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * A Drizzle transaction handle opened from an {@link AppDb}.
 *
 * `db.transaction(cb)` hands `cb` a tx that supports every query method the
 * auth helpers use but not `transaction()` itself, so a tx is not assignable to
 * `AppDb`. Callers inside an existing transaction (OTP verify creating a session,
 * for example) previously had to write `db: tx as any`, which disables type
 * checking on a database handle — exactly the place where a typo in a method
 * name should be caught. This alias lets them pass the tx honestly.
 */
export type AppTx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];

/** Either a full database handle or an open transaction over it. */
export type AppDbLike = AppDb | AppTx;

