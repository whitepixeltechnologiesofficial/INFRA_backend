// WEB 2.4 — New Chat: Synced Contacts Only verification.
//
// The New Chat panel must read ONLY already-synced contacts via a server-side
// match — never a browser Contacts permission prompt (locked Section-5 design
// decision). The data source is the contact-match registry the mobile sync
// (PERM-2.16) feeds; on Web it is read through GET /api/synced-contacts/:token.
//
//   * the pure match/filter contract in app/lib/synced-contacts.ts is asserted
//     directly (self excluded, deduped, server order, zero-synced empty state);
//   * a live relay proves the wire: an unknown web token is 401, a fresh link
//     yields `{ok:true, synced:[]}` (the zero-synced edge), the QA knob seeds
//     the matched list, and matched / unmatched / self / unknown ids resolve
//     exactly as the contract says;
//   * client source is scanned: the panel builds from the synced list, the
//     empty-state copy is present, and NO browser Contacts API token appears
//     anywhere in the client or server sources.
//
// Shared chip imported as real TS source (Node type stripping).
//
// Run: node scripts/web-24-verify.js   (plain Node >= 22.7)

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Suite, http, startServer, stopServer } from "./_h.mjs";
import {
  EMPTY_SYNCED_CONTACTS_COPY,
  SYNCED_CONTACTS_ROUTE,
  SYNCED_NO_MATCH_COPY,
  buildSyncedContactsPath,
  filterSyncedContacts,
  isSyncedContactsPayload,
  matchSyncedContacts,
} from "../app/lib/synced-contacts.ts";

const APP = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (f) => fs.readFileSync(path.join(APP, f), "utf8");
function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const PORT = 3945;
const server = startServer(PORT);
await server.ready;
const s = new Suite("WEB 2.4 New Chat — Synced Contacts Only");

// ── pure contract (app/lib/synced-contacts.ts) ──
s.section("pure match/filter contract (app/lib/synced-contacts.ts)");
const ALL = [
  { id: "arun", name: "Arun Kumar", role: "member" },
  { id: "mervin", name: "Mervin Roger", role: "owner" },
  { id: "satheesh", name: "Satheesh", role: "member" },
  { id: "pravan", name: "Pravan", role: "admin" },
];
const matched = matchSyncedContacts(ALL, "satheesh", ["pravan", "mervin", "pravan"]);
s.check("matched users only, server order preserved, deduped", JSON.stringify(matched.map((u) => u.id)) === JSON.stringify(["mervin", "pravan"]));
s.check("self id in the match set is excluded (own number never a contact)", matchSyncedContacts(ALL, "mervin", ["mervin", "arun"]).map((u) => u.id).join(",") === "arun");
s.check("no matched ids -> empty list (zero-synced edge)", JSON.stringify(matchSyncedContacts(ALL, "satheesh", [])) === "[]");
s.check("unknown/blank ids are never surfaced", matchSyncedContacts(ALL, "satheesh", ["", "ghost"]).length === 0);
s.check("matched list never exceeds the server's users", matchSyncedContacts(ALL, "satheesh", ["mervin", "pravan", "arun", "nobody-else"]).length === 3);

const filteredAll = filterSyncedContacts(ALL, "");
s.check("empty search returns the whole matched list (unchanged)", filteredAll.length === ALL.length && filteredAll[0].id === "arun");
s.check("search by name is case-insensitive", filterSyncedContacts(ALL, "PRAVAN").map((u) => u.id).join(",") === "pravan");
s.check("search by id works too", filterSyncedContacts(ALL, "mer").map((u) => u.id).join(",") === "mervin");
s.check("no search match -> empty list", filterSyncedContacts(ALL, "zzz").length === 0);

s.check("route constant is /api/synced-contacts", SYNCED_CONTACTS_ROUTE === "/api/synced-contacts");
s.check("path builder encodes the web token", buildSyncedContactsPath("abc/def") === "/api/synced-contacts/abc%2Fdef");
s.check("payload guard accepts a well-formed response", isSyncedContactsPayload({ ok: true, synced: [{ id: "a", name: "A" }] }));
s.check("payload guard rejects a malformed response", !isSyncedContactsPayload({ ok: true, synced: "x" }) && !isSyncedContactsPayload(null));
s.check("empty-state copy exported (zero-synced edge)", typeof EMPTY_SYNCED_CONTACTS_COPY === "string" && EMPTY_SYNCED_CONTACTS_COPY.length > 20);
s.check("no-match copy exported", typeof SYNCED_NO_MATCH_COPY === "string" && SYNCED_NO_MATCH_COPY.length > 20);

// ── live relay: auth + zero-synced + server match ──
s.section("live relay: /api/synced-contacts (auth, empty state, server match)");
const unknown = await http(PORT, "GET", "/api/synced-contacts/not-a-token");
s.check("unknown web token -> 401 session_invalid", unknown.status === 401 && unknown.json?.error === "session_invalid");

const linked = await http(PORT, "POST", "/api/mock/link-web", { userId: "satheesh" });
s.check("mock link-web mints a web session for satheesh", linked.ok && typeof linked.json?.webToken === "string");
const wt = linked.json.webToken;

const empty = await http(PORT, "GET", buildSyncedContactsPath(wt));
s.check("fresh link: zero synced contacts -> {ok:true, synced:[]} (edge case)", empty.ok && Array.isArray(empty.json?.synced) && empty.json.synced.length === 0);

const seeded = await http(PORT, "POST", "/api/mock/sync-contacts", { userId: "satheesh", matched: ["pravan", "mervin"] });
s.check("mock sync seed returns the matched list", seeded.ok && seeded.json?.synced?.length === 2);

const got = await http(PORT, "GET", buildSyncedContactsPath(wt));
s.check("synced list contains ONLY matched users, in server order", (() => {
  if (!got.ok || !Array.isArray(got.json?.synced)) return false;
  const ids = got.json.synced.map((u) => u.id);
  return JSON.stringify(ids) === JSON.stringify(["mervin", "pravan"]);
})());
s.check("each synced row is a full ServerUser {id,name,role}", (() => {
  return got.json.synced.every((u) => typeof u.id === "string" && typeof u.name === "string" && typeof u.role === "string");
})());
s.check("synced rows carry server names (pravan resolves by name)", got.json.synced.every((u) => u.name.length > 0));

const messy = await http(PORT, "POST", "/api/mock/sync-contacts", { userId: "satheesh", matched: ["satheesh", "ghost", "mervin", "pravan", "pravan"] });
s.check("self + unknown matched ids are dropped server-side", (() => {
  if (!messy.ok || !Array.isArray(messy.json?.synced)) return false;
  const ids = messy.json.synced.map((u) => u.id);
  return !ids.includes("satheesh") && !ids.includes("ghost") && ids.length === 2;
})());

const clear = await http(PORT, "POST", "/api/mock/sync-contacts", { userId: "satheesh", matched: [] });
s.check("clearing the registry returns the zero-synced state", clear.ok && Array.isArray(clear.json?.synced) && clear.json.synced.length === 0);
const afterClear = await http(PORT, "GET", buildSyncedContactsPath(wt));
s.check("GET after clear is empty again", afterClear.ok && Array.isArray(afterClear.json?.synced) && afterClear.json.synced.length === 0);

// ── client wiring + no-browser-Contacts-Api ──
s.section("client wiring + hygiene (no browser Contacts API anywhere)");
const chatApp = read("app/wpt/chat-app.tsx");
const webApp = read("app/wpt/web-app.tsx");
const serverSrc = read("server/wpt-server.mjs");

s.check("NewChatPanel renders from the server-matched synced list", /function NewChatPanel[^)]*synced: ServerUser\[\]/.test(chatApp) && chatApp.includes("filterSyncedContacts(synced, q)"));
s.check("NewChatPanel no longer subscribes to the all-users pool", !/NewChatPanel\(\s*users\s*: ServerUser\[\]/.test(chatApp) && !chatApp.includes("const pool = users.filter"));
s.check("empty-state copy is rendered in the panel", chatApp.includes("EMPTY_SYNCED_CONTACTS_COPY"));
s.check("no-match copy is rendered in the panel", chatApp.includes("SYNCED_NO_MATCH_COPY"));
s.check("panel visibly states Web never requests Contacts permission", chatApp.includes("Web doesn`t request its own Contacts permission.") || chatApp.includes("Web doesn&apos;t request its own Contacts permission."));

s.check("orchestrator loads synced contacts via the session-authenticated route", webApp.includes("SYNCED_CONTACTS_ROUTE") && webApp.includes("isSyncedContactsPayload"));
s.check("orchestrator passes synced to ChatApp", /\bsynced=\{syncedContactsRef\.current\}/.test(webApp));
s.check("orchestrator never leaves the panel list at all-users", webApp.includes("loadSyncedContacts()"));

s.check("server exposes the synced-contacts GET route", serverSrc.includes("syncedList = p.match") && serverSrc.includes("^\\/api\\/synced-contacts\\/"));
s.check("server exposes the mock sync seed", serverSrc.includes("/api/mock/sync-contacts"));

const clientFiles = walk(path.join(APP, "app"), []);
const noContactsApi = (files) => {
  const bad = [];
  for (const f of files) {
    const text = read(path.relative(APP, f).replace(/\\/g, "/"));
    if (/navigator\.contacts\b|ContactsManager|getProperty\s*\(\s*['"]contacts/.test(text)) bad.push(path.relative(APP, f));
  }
  return bad;
};
const clientBad = noContactsApi(clientFiles);
s.check("no browser Contacts API token in any client source", clientBad.length === 0, clientBad.join(", ") || undefined);
const serverBad = noContactsApi([path.join(APP, "server/wpt-server.mjs")]);
s.check("no browser Contacts API token in the server source", serverBad.length === 0);

s.summary();
stopServer(server);
process.exit(s.failed === 0 ? 0 : 1);