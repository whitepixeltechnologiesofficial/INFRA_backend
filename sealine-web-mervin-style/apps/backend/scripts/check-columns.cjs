const { Client } = require("pg");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Refusing to guess a database.");
  process.exit(1);
}
const c = new Client({ connectionString });
(async () => {
  await c.connect();
  const r = await c.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'sms_outbox' ORDER BY ordinal_position"
  );
  console.log("sms_outbox columns:", r.rows.map((x) => x.column_name));

  // Also check otp_verifications
  const r2 = await c.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'otp_verifications' ORDER BY ordinal_position"
  );
  console.log("otp_verifications columns:", r2.rows.map((x) => x.column_name));

  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
