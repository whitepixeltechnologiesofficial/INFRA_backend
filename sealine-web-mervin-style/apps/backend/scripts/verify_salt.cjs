const fs = require('fs');
const crypto = require('crypto');
const { parsePhoneNumber } = require('C:/Users/prava/OneDrive/Desktop/vs code/Team Beta/node_modules/libphonenumber-js');

// Simulate backend boot: load .env into process.env exactly as node loads it
for (const line of fs.readFileSync('C:/Users/prava/OneDrive/Desktop/vs code/Team Beta/apps/backend/.env', 'utf8').split('\n')) {
  const m = line.trim().match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
const normalize = (p, cc) => { try { const x = parsePhoneNumber(p, cc); return x && x.isValid() ? x.format('E.164') : null; } catch { return null; } };
const phoneHash = (n) => {
  const salt = process.env.GLOBAL_SALT || process.env.CONTACT_HASH_SALT;
  if (!salt) throw new Error('GLOBAL_SALT or CONTACT_HASH_SALT required');
  return crypto.createHash('sha256').update(salt + n).digest('hex');
};

const ok = [];
const bad = [];
const t = (id, label, pass, detail) => (pass ? ok : bad).push(`  ${pass ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? '  [' + detail + ']' : ''}`);

// 1. salt present in env
t('S1', 'GLOBAL_SALT present in .env', !!process.env.GLOBAL_SALT, process.env.GLOBAL_SALT ? `set (${process.env.GLOBAL_SALT.length} hex chars)` : 'MISSING');
// 2. phoneHash no longer throws
let hNoThrow = false; try { phoneHash('+919876543210'); hNoThrow = true; } catch {}
t('S2', 'phoneHash() produces a hash (no throw)', hNoThrow);
// 3. format invariance (DB-2.3 edge case test)
const hA = phoneHash(normalize('9876543210', 'IN'));
const hB = phoneHash(normalize('+91 98765 43210'));
const hC = phoneHash(normalize('+919876543210'));
t('S3', 'format invariance (9876543210 / +91 98765 43210 / +919876543210)', hA === hB && hB === hC, `all=${hA.slice(0,12)}...`);
// 4. SHA-256 shape
t('S4', 'hashes are 64 lowercase hex (SHA-256)', /^[0-9a-f]{64}$/.test(hA), hA.length + ' chars');
// 5. determinism
t('S5', 'deterministic (twice = same)', phoneHash('+919876543210') === hC);
// 6. distinct numbers -> distinct hashes
const hOne = phoneHash(normalize('+14155550123'));
const hTwo = phoneHash(normalize('+919876543210'));
t('S6', 'distinct numbers yield distinct hashes', hOne !== hTwo);
// 7. matches live contact_hashes contract (rebuilt rows reproducible)
const { Client } = require('C:/Users/prava/OneDrive/Desktop/vs code/Team Beta/node_modules/pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query(`SELECT ch.phone_hash, u.phone_number FROM public.contact_hashes ch JOIN public.users u ON u.id=ch.user_id`);
  let allCurrent = true;
  for (const row of r.rows) {
    const e164 = normalize(row.phone_number, 'IN');
    const recomputed = e164 && phoneHash(e164);
    if (recomputed !== row.phone_hash) allCurrent = false;
  }
  t('S7', 'all contact_hashes rows reproducible under current GLOBAL_SALT', allCurrent && r.rows.length > 0, r.rows.length + ' rows');
  await c.end();
  console.log(ok.join('\n'));
  if (bad.length) { console.log(bad.join('\n')); process.exit(1); } else console.log('\nALL SALT CHECKS PASSED — .env GLOBAL_SALT is live and consistent.');
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });