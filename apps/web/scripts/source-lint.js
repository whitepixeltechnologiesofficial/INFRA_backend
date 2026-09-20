// @wpt/web "lint" — a real, offline, project-specific static gate over the
// replacement web stack. The builder has no shared ESLint config in the
// monorepo (none is installed), so this checker enforces the WEB-R1 source
// hygiene contract the UI was verified against:
//   - no debugging console.log, no tab-scoped storage, no unload cleanup,
//     no sync-progress UI, no grace-period copy, no legacy stack references;
//   - storage keys + logout call-site invariants;
//   - server/client sources parse cleanly.
// Exits non-zero on any violation. Type correctness is the separate
// `typecheck` script (tsc --noEmit).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const APP = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const errors = [];
const warnOnlyWeaknesses = 0;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js|css|json)$/.test(entry.name)) out.push(full);
  }
}

const allFiles = [];
walk(APP, allFiles);
const isScanTarget = (p) => !p.includes(`${path.sep}scripts${path.sep}`) && !/wptOutbox\.d\.ts$/.test(p);
const clientTarget = (p) => p.includes(`${path.sep}app${path.sep}`) || /wptOutbox\.js$/.test(p);

const read = (p) => fs.readFileSync(p, "utf8");
const targets = allFiles.filter(isScanTarget);
const client = targets.filter(clientTarget);
const clientText = client.map(read).join("\n");
const serverText = targets.filter((p) => p.includes(`${path.sep}server${path.sep}`)).map(read).join("\n");

function flag(file, msg) {
  errors.push(`${path.relative(APP, file) || file}: ${msg}`);
}

// 1. no debugging console.log in the client (server startup logs are fine)
for (const f of client) {
  const text = read(f);
  const m = text.match(/console\.log\s*\(/g);
  if (m) flag(f, `client console.log (${m.length} occurrence(s))`);
}

// 2. no tab-scoped storage (actual usage, not prose)
for (const f of targets) {
  const text = read(f);
  if (/window\.sessionStorage|(?:^|[^\w'"`])sessionStorage\s*\./.test(text)) flag(f, "sessionStorage is forbidden (tab-scoped storage breaks session persistence)");
}

// 3. no sync-progress UI tokens (WEB-R1.5: invisible reconnect)
for (const f of client) {
  const text = read(f);
  for (const token of ["syncChip", "pending-send", "sending…", "retrying…", "syncing", "Syncing", "Syncing…"]) {
    if (text.includes(token)) flag(f, `sync-unit token '${token}' present (reconnect refresh must be invisible)`);
  }
}

// 4. no close/unload cleanup handlers (actual event registration, not prose)
for (const f of client) {
  const text = read(f);
  if (/addEventListener\(\s*['"](beforeunload|pagehide|unload)['"]|on(beforeunload|pagehide|unload)\s*=/.test(text)) flag(f, "close/unload handler present (tab close must never end the session)");
}

// 5. storage keys + logout invariants
const keys = ["wpt_web_session_v1", "wpt_web_app_state_v1", "wpt_web_outbox_v1"];
for (const key of keys) {
  if (!clientText.includes(key)) flag(APP, `required storage key '${key}' missing from client`);
}
const clearSites = (clientText.match(/clearWebSession\(\);/g) || []).length;
if (clearSites !== 2) flag(APP, `clearWebSession must have exactly 2 call sites (manual logout + performSessionLogout), found ${clearSites}`);
if (!clientText.includes('"/api/session/logout"')) flag(APP, "manual logout must hit POST /api/session/logout");
if (!clientText.includes("performSessionLogout(")) flag(APP, "performSessionLogout missing (401 / webForceLoggedOut cutoff)");
if (clientText.includes("will be logged out in") || /ends in \d+ seconds/.test(clientText) || /grace period/i.test(clientText)) {
  flag(APP, "grace-period / advance-warning copy present (force logout must be immediate)");
}
if (!clientText.includes("A new phone signed in to this account")) flag(APP, "clear 'session ended, please rescan' notice copy missing");
if (!clientText.includes("if (document.hidden) return")) flag(APP, "visibilitychange must do nothing while the tab is hidden");

// 6. no legacy stack references in runtime sources (retirement hygiene)
for (const f of targets) {
  const text = read(f);
  if (/qr-login[\\/]|apps[\\/]web[\\/]qr-login/.test(text)) flag(f, "reference to the retired legacy web app path");
  if (/socket\.io/.test(text)) flag(f, "reference to the retired Socket.io stack");
  if (/from ['"]express['"]/.test(text)) flag(f, "reference to the retired Express framework");
}

// 7. parse-checks on standalone runtime entrypoints
for (const rel of ["server/wpt-server.mjs", "lib/wptOutbox.js"]) {
  const full = path.join(APP, rel);
  const r = spawnSync(process.execPath, ["--check", full], { encoding: "utf8" });
  if (r.status !== 0) flag(full, `parse error: ${r.stderr.trim().split("\n").slice(0, 4).join(" | ")}`);
}

console.log(`@wpt/web source-lint — scanned ${targets.length} file(s), ${client.length} client`);
if (errors.length === 0) {
  console.log("OK: no violations.");
  process.exit(0);
}
for (const e of errors) console.log(`VIOLATION  ${e}`);
console.log(`\n${errors.length} violation(s)`);
void warnOnlyWeaknesses;
process.exit(1);