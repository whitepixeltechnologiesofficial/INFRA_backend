/**
 * Apply the push_devices table migration to the database.
 * Run: pnpm --filter @wpt/backend exec tsx src/db/apply-push-devices-migration.ts
 */

import pg from "pg";

const { Pool } = pg;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");

  const pool = new Pool({ connectionString: url });

  const sql = `
    CREATE TABLE IF NOT EXISTS "push_devices" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "user_id" varchar(64) NOT NULL,
      "device_id" varchar(64) NOT NULL,
      "token" varchar(200) NOT NULL,
      "platform" varchar(16) NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "push_devices_user_device_unique"
      ON "push_devices" USING btree ("user_id", "device_id");
    CREATE INDEX IF NOT EXISTS "push_devices_user_id_idx"
      ON "push_devices" USING btree ("user_id");
  `;

  await pool.query(sql);
  console.log("push_devices table created successfully.");

  const res = await pool.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'push_devices'
    ORDER BY ordinal_position
  `);

  console.log("\npush_devices table columns:");
  for (const row of res.rows) {
    console.log(`  ${row.column_name} (${row.data_type}) nullable=${row.is_nullable}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
