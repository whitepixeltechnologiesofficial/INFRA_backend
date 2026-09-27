import { strict as assert } from "node:assert";
import { createPool } from "./pool.js";
import { assertDestructiveAllowed } from "./guard.js";

const REMOTE = "postgresql://u:p@db.abcdefg.supabase.com:6543/postgres";
const LOCAL = "postgresql://u:p@localhost:5432/postgres";

let pass = 0;
let fail = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (err) {
    console.log(`  FAIL  ${name} -> ${(err as Error).message}`);
    fail++;
  }
}

function throws(name: string, fn: () => void, expect: RegExp) {
  try {
    fn();
    console.log(`  FAIL  ${name} -> did not throw`);
    fail++;
  } catch (err) {
    const msg = (err as Error).message;
    if (expect.test(msg)) {
      console.log(`  PASS  ${name}`);
      pass++;
    } else {
      console.log(`  FAIL  ${name} -> wrong error: ${msg.slice(0, 90)}`);
      fail++;
    }
  }
}

console.log("\ncreatePool transport decisions");

process.env.DATABASE_URL = REMOTE;
delete process.env.DATABASE_CA_CERT;

throws("remote without sslmode is REFUSED", () => createPool({ connectionString: REMOTE }),
  /declares no sslmode/);

throws("remote with sslmode=disable is REFUSED",
  () => createPool({ connectionString: REMOTE + "?sslmode=disable" }), /not a recognised value/);

throws("remote with sslmode=prefer is REFUSED (allows plaintext fallback)",
  () => createPool({ connectionString: REMOTE + "?sslmode=prefer" }), /permits a plaintext fallback/);

throws("remote with sslmode=nonsense is REFUSED",
  () => createPool({ connectionString: REMOTE + "?sslmode=tlsplease" }), /not a recognised value/);

throws("missing DATABASE_URL is REFUSED", () => createPool({ connectionString: undefined }),
  /DATABASE_URL is not set/);

throws("malformed URL is REFUSED", () => createPool({ connectionString: "not-a-url" }),
  /not a valid URL/);

check("remote WITH sslmode=require is accepted (warns, no CA)", () => {
  const pool = createPool({ connectionString: REMOTE + "?sslmode=require" });
  assert.equal(typeof pool.query, "function");
  void pool.end();
});

check("localhost WITHOUT sslmode is accepted (plaintext allowed locally)", () => {
  const pool = createPool({ connectionString: LOCAL });
  assert.equal(typeof pool.query, "function");
  void pool.end();
});

check("127.0.0.1 WITHOUT sslmode is accepted", () => {
  const pool = createPool({ connectionString: LOCAL.replace("localhost", "127.0.0.1") });
  assert.equal(typeof pool.query, "function");
  void pool.end();
});

console.log("\nassertDestructiveAllowed gates");

const SCRIPT = "test-script";
const STMTS = ["DROP TABLE public.sessions CASCADE"];

process.env.DATABASE_URL = LOCAL;
process.env.NODE_ENV = "development";

delete process.env.ALLOW_DESTRUCTIVE_DB;
delete process.env.ALLOW_DESTRUCTIVE_DB_REMOTE;
throws("refuses without ALLOW_DESTRUCTIVE_DB", () => assertDestructiveAllowed(SCRIPT, STMTS),
  /destructive database scripts are opt-in/);

process.env.ALLOW_DESTRUCTIVE_DB = "true";
check("allows local target with single opt-in", () => assertDestructiveAllowed(SCRIPT, STMTS));

process.env.DATABASE_URL = REMOTE + "?sslmode=require";
delete process.env.ALLOW_DESTRUCTIVE_DB_REMOTE;
throws("refuses REMOTE target with only one opt-in", () => assertDestructiveAllowed(SCRIPT, STMTS),
  /target is REMOTE/);

throws("remote refusal message redacts the password", () => assertDestructiveAllowed(SCRIPT, STMTS),
  /\*\*\*:\*\*\*/);

throws("remote refusal lists the destructive statements",
  () => assertDestructiveAllowed(SCRIPT, STMTS), /DROP TABLE public\.sessions/);

process.env.ALLOW_DESTRUCTIVE_DB_REMOTE = "true";
check("allows remote target with BOTH opt-ins", () => assertDestructiveAllowed(SCRIPT, STMTS));

process.env.NODE_ENV = "production";
throws("production is refused even with both opt-ins",
  () => assertDestructiveAllowed(SCRIPT, STMTS), /must never run against production/);

process.env.NODE_ENV = "staging";
check("NODE_ENV=staging is NOT blocked as production (exact-match gap confirmed)", () => {
  assertDestructiveAllowed(SCRIPT, STMTS);
});

process.env.NODE_ENV = "prod";
check("NODE_ENV=prod is NOT blocked as production (documents the exact-match gap)", () => {
  assertDestructiveAllowed(SCRIPT, STMTS);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
