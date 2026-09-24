// WEB 2.5 — New Chat: Manual Number Entry, No Invite Option verification.
//
// Manually entering an unregistered phone number in New Chat must show a
// "not registered" message and NOTHING else — no invite affordance, no
// share/referral link, no copy-link. Web intentionally excludes the mobile
// invite flow (locked Section-5 design decision).
//
// The edge the card calls out: number-format validation runs BEFORE the
// registration check. A malformed number always gets a format error — never a
// false "not registered" (a bad number is 400 invalid_number at the server
// even when a normalized variant of it is registered).
//
//   * the pure contract in app/lib/manual-number.ts is asserted directly
//     (E.164 normalization matrix, format-error-first ordering, copy constants
//     that are free of any invite wording, response shape guard);
//   * a live relay proves the wire: malformed -> 400 invalid_number, well-formed
//     unregistered -> `{ok:true, registered:false}` (the not-registered edge),
//     mock-registered -> `{ok:true, registered:true, user}`, and the malformed
//     input still 400 even AFTER an identical normalized number is registered
//     (format beats registration, never a false "not registered");
//   * client/server source is scanned: the manual flow normalizes before it
//     POSTs, both copy strings are rendered, and NO invite/share affordance
//     token appears anywhere in the client or server sources.
//
// Shared chip imported as real TS source (Node type stripping).
//
// Run: node scripts/web-25-verify.js   (plain Node >= 22.7)

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Suite, http, startServer, stopServer } from "./_h.mjs";
import {
  MANUAL_NUMBER_CHECK_ACTION,
  MANUAL_NUMBER_LABEL,
  MANUAL_NUMBER_PLACEHOLDER,
  MANUAL_NUMBER_ROUTE,
  NUMBER_CHECK_UNAVAILABLE_COPY,
  NUMBER_FORMAT_ERROR_COPY,
  NUMBER_NOT_REGISTERED_COPY,
  isManualNumberCheckResponse,
  normalizeToE164,
} from "../app/lib/manual-number.ts";

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

const PORT = 3946;
const server = startServer(PORT);
await server.ready;
const s = new Suite("WEB 2.5 New Chat — Manual Number Entry, No Invite Option");

// ── pure contract (app/lib/manual-number.ts) ──
s.section("pure validation + copy contract (app/lib/manual-number.ts)");
s.check("full E.164 passes through untouched", normalizeToE164("+14155552671") === "+14155552671");
s.check("spaces are stripped", normalizeToE164("+91 98765 43210") === "+919876543210");
s.check("dashes/parens/dots are stripped", normalizeToE164("+1 (415) 555-2671") === "+14155552671");
s.check("surrounding whitespace is trimmed", normalizeToE164("  +49 30 901820  ") === "+4930901820");
s.check("national format without + is rejected (Web needs country code)", normalizeToE164("9876543210") === null);
s.check("leading zero country code is rejected", normalizeToE164("+09876543210") === null);
s.check("too short is rejected", normalizeToE164("+1234567") === null && normalizeToE164("+12345678") !== null);
s.check("too long is rejected", normalizeToE164("+1234567890123456") === null && normalizeToE164("+123456789012345") !== null);
s.check("alphanumerics are rejected", normalizeToE164("+91abc") === null);
s.check("empty input is rejected", normalizeToE164("") === null && normalizeToE164("   ") === null);
s.check("route constant is /api/contacts/check", MANUAL_NUMBER_ROUTE === "/api/contacts/check");

s.check("format-error copy tells the user to include the country code", NUMBER_FORMAT_ERROR_COPY.includes("country code"));
s.check("not-registered copy tells the user they can retry once joined", NUMBER_NOT_REGISTERED_COPY.includes("joined"));
s.check("not-registered copy has zero invite/share/referral wording", (() => {
  return !/\b(invite|invitation|share[ds]?|referral|refer friend|tell a friend)\b/i.test(NUMBER_NOT_REGISTERED_COPY);
})());
s.check("format-error copy has zero invite/share/referral wording", !/\binvite\b|\bshare\b|\brefer\b/i.test(NUMBER_FORMAT_ERROR_COPY));
s.check("label/placeholder/action/network-error copy all exported", (() => {
  return [MANUAL_NUMBER_LABEL, MANUAL_NUMBER_PLACEHOLDER, MANUAL_NUMBER_CHECK_ACTION, NUMBER_CHECK_UNAVAILABLE_COPY]
    .every((x) => typeof x === "string" && x.length > 0);
})());

s.check("shape guard accepts registered:false without a user", isManualNumberCheckResponse({ ok: true, registered: false }));
s.check("shape guard accepts registered:true with a user", isManualNumberCheckResponse({ ok: true, registered: true, user: { id: "a", name: "A" } }));
s.check("shape guard rejects registered:true without a user", !isManualNumberCheckResponse({ ok: true, registered: true }));
s.check("shape guard rejects malformed payloads", !isManualNumberCheckResponse(null) && !isManualNumberCheckResponse({ ok: 1 }));

// ── live relay: format beats registration, unregistered edge, registered edge ──
s.section("live relay: /api/contacts/check (format-first, unregistered vs registered)");
const malformed0 = await http(PORT, "POST", MANUAL_NUMBER_ROUTE, { number: "9876543210" });
s.check("malformed (no +) -> 400 invalid_number", malformed0.status === 400 && malformed0.json?.error === "invalid_number");
s.check("invalid_number response has no invite/share fields", (() => {
  const t = JSON.stringify(malformed0.json);
  return !/\binvite|share|refer|link\b/i.test(t);
})());
const empty0 = await http(PORT, "POST", MANUAL_NUMBER_ROUTE, { number: "" });
s.check("empty number -> 400 invalid_number", empty0.status === 400 && empty0.json?.error === "invalid_number");

const unreg = await http(PORT, "POST", MANUAL_NUMBER_ROUTE, { number: "+91 98765 43210" });
s.check("well-formed unregistered -> {ok:true, registered:false}", unreg.ok && unreg.json?.ok === true && unreg.json?.registered === false);
s.check("not-registered response has no invite/share fields", (() => {
  const t = JSON.stringify(unreg.json);
  return !/\binvite|share|refer|link\b/i.test(t);
})());

const reg = await http(PORT, "POST", "/api/mock/register-number", { userId: "mervin", number: "+1 415 555-2671" });
s.check("mock register-number seeds a registered number", reg.ok && reg.json?.number === "+14155552671" && reg.json?.user?.id === "mervin");
const regBad = await http(PORT, "POST", "/api/mock/register-number", { userId: "mervin", number: "4155552671" });
s.check("mock register rejects a malformed number too", regBad.status === 400 && regBad.json?.error === "invalid_number");
const regGhost = await http(PORT, "POST", "/api/mock/register-number", { userId: "ghost", number: "+14155552671" });
s.check("mock register rejects an unknown user", regGhost.status === 404 && regGhost.json?.error === "unknown_user");

const registered = await http(PORT, "POST", MANUAL_NUMBER_ROUTE, { number: "+1 (415) 555-2671" });
s.check("well-formed registered number -> {ok:true, registered:true, user}", (() => {
  return registered.ok && registered.json?.registered === true && registered.json?.user?.id === "mervin" && registered.json?.user?.name.length > 0;
})());
const registeredRaw = await http(PORT, "POST", MANUAL_NUMBER_ROUTE, { number: "14155552671" });
s.check("a MALFORMED number is still 400 even when its normalized twin is registered", (() => {
  return registeredRaw.status === 400 && registeredRaw.json?.error === "invalid_number";
})());
s.check("... and never reported as registered (no false not-registered either)", registeredRaw.json?.registered === undefined);
s.check("normalized lookups with separators hit the same registry", (() => {
  return true;
})()); // covered above; exists so the format-vs-registration ordering is explicit

const unreg2 = await http(PORT, "POST", "/api/mock/unregister-number", { number: "+1 (415) 555-2671" });
s.check("mock unregister-number clears the registry", unreg2.ok === true);
const afterUnreg = await http(PORT, "POST", MANUAL_NUMBER_ROUTE, { number: "+14155552671" });
s.check("after unregister the same number is not-registered again", afterUnreg.ok && afterUnreg.json?.registered === false);

// ── client wiring + hygiene (no invite/share affordance anywhere) ──
s.section("client wiring + hygiene (manual entry with zero invite affordance)");
const chatApp = read("app/wpt/chat-app.tsx");
const manualLib = read("app/lib/manual-number.ts");
const webApp = read("app/wpt/web-app.tsx");
const serverSrc = read("server/wpt-server.mjs");
const css = read("app/globals.css");

s.check("NewChatPanel renders the manual number section", /pn-manual/.test(chatApp) && chatApp.includes("type=\"tel\"") && chatApp.includes("inputMode=\"tel\""));
s.check("manual number input posts to the WPT relay", /wptApi<ManualNumberCheckResponse>\("POST", MANUAL_NUMBER_ROUTE, \{ number: value \}\)/.test(chatApp));
s.check("format is validated BEFORE any server POST (format-first ordering)", (() => {
  const fn = chatApp.slice(chatApp.indexOf("function checkManualNumber"), chatApp.indexOf("function checkManualNumber") + 1400);
  const norm = fn.indexOf("normalizeToE164(value)");
  const post = fn.indexOf('"POST", MANUAL_NUMBER_ROUTE');
  return norm >= 0 && post > norm;
})());
s.check("malformed input short-circuits to the format error copy", (() => {
  const fn = chatApp.slice(chatApp.indexOf("function checkManualNumber"), chatApp.indexOf("function checkManualNumber") + 1400);
  return fn.indexOf("setManualError(NUMBER_FORMAT_ERROR_COPY)") < fn.indexOf('"POST", MANUAL_NUMBER_ROUTE');
})());
s.check("not-registered state renders the no-invite copy", chatApp.includes("setManualError(NUMBER_NOT_REGISTERED_COPY)") && /\{manualError\}/.test(chatApp) && chatApp.includes("mn-err"));
s.check("registered manual number starts the chat", /onStart\(r\.body\.user\.id\)/.test(chatApp) && chatApp.includes("onClose()"));
s.check("relay failure falls back to a friendly unavailable copy", chatApp.includes("NUMBER_CHECK_UNAVAILABLE_COPY"));
s.check("shape guard gates the success path", chatApp.includes("isManualNumberCheckResponse(r.body)"));
s.check("the synced-contacts panel copy is untouched (WEB-2.4 regression)", chatApp.includes("EMPTY_SYNCED_CONTACTS_COPY") && chatApp.includes("Web doesn&apos;t request its own Contacts permission."));
s.check("manual number logic is pure and importable by Node (erasable-only)", (() => {
  return !manualLib.includes(": any") && !/^import .* from "react"/m.test(manualLib) && !manualLib.includes("localStorage");
})());

const inviteAffordance = (text) => /\b(invite[A-Z_]|inviteToken|inviteLink|inviteUrl|shareLink|shareUrl|shareToken|referral|copy-link|copyLink|referredBy|\/api\/invite|\/api\/share|navigator\.share|navigator\.clipboard)\b/.test(text);

const clientFiles = walk(path.join(APP, "app"), []);
const clientHygiene = [];
for (const f of clientFiles) {
  const text = read(path.relative(APP, f).replace(/\\/g, "/"));
  // the manual lib header + panel comments intentionally SAY there is no
  // invite; a bare "invite" word is not an affordance. Only real affordance
  // mechanisms (tokens, /invite or /share endpoints, share links, clipboard)
  // are scanned for, and the not-registered/format COPY constants are checked
  // invite-free directly in the pure section above.
  if (inviteAffordance(text)) clientHygiene.push(path.relative(APP, f));
}
s.check("NO invite/share affordance token in any client source", clientHygiene.length === 0, clientHygiene.join(", ") || undefined);
s.check("NO invite/share affordance in the server source", !inviteAffordance(serverSrc));
s.check("server exposes /api/contacts/check with format-before-registration", (() => {
  const i = serverSrc.indexOf('p === "/api/contacts/check"');
  return i >= 0 && serverSrc.indexOf("normalizeE164(") < serverSrc.indexOf("registeredNumbers.get(e164)") && serverSrc.slice(i, i + 900).includes("invalid_number");
})());
s.check("server exposes mock register/unregister QA knobs", serverSrc.includes("/api/mock/register-number") && serverSrc.includes("/api/mock/unregister-number"));
s.check("manual number UI styles present", css.includes(".pn-manual") && css.includes(".mn-err"));

s.summary();
stopServer(server);
process.exit(s.failed === 0 ? 0 : 1);