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
