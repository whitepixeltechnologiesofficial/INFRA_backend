import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

const { Pool } = pg;

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

let _db: AppDb | null = null;

/**
 * Returns a shared Drizzle database instance.
 *
 * The connection pool is created only once and reused
 * for the lifetime of the backend process.
 */
export function getDb(): AppDb {
  if (_db) {
    return _db;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is missing.");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false,
    },
  });

  _db = drizzle(pool, { schema });

  return _db;
}

/**
 * Default database instance.
 *
 * Kept for existing backend code that imports `db`.
 */
export const db = getDb();