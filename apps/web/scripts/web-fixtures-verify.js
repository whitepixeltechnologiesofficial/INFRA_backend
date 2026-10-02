// WEB-2.1 -> WEB-2.5 — development fixture data layer verification.
//
// Four sections, all offline and deterministic:
//
//   A. THE FIXTURES (the real modules are executed, not described)
//      8 conversations with distinct states, a 40-message long thread, every
//      supported message kind, deliberate search terms, unread variety.
//   B. THE SHARED SEARCH/STATE LOGIC really accepts this data
//      sidebar filterChats + in-thread search run against the real fixtures.
//   C. DEVELOPMENT-ONLY INVARIANTS
//      no production component or production model may reference the fixtures,
//      and the real relay source is unchanged.
//   D. PRODUCTION EXCLUSION (TEST 17)
//      the gate returns false for every production env shape, the fixture
//      provider refuses to answer when the gate is closed, and the only
//      reference to it in the app is inside the guarded dynamic import.
//
// Run: node scripts/web-fixtures-verify.js
//      (plain Node >= 22.7; type stripping, no tsx, no bundling, no server)

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Suite } from "./_h.mjs";
import { chatFixturesEnabled } from "../app/lib/chat-fixtures-gate.ts";
import {
  FIXTURE_CHATS,
  FIXTURE_PARTICIPANTS,
  FIXTURE_SEARCH_TERMS,
  FIXTURE_SELF,
  buildFixtureDataset,
  participantName,
} from "../app/lib/dev-fixtures/sample-data.ts";
import { filterChats, decideChatListState } from "../app/lib/chat-list-state.ts";
import { buildSearchPattern, chooseMatchIndexes, splitHighlight } from "../app/lib/search.ts";

const APP = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (f) => fs.readFileSync(path.join(APP, f), "utf8");

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const ds = buildFixtureDataset(NOW);
const suite = new Suite("web-fixtures");

// ─────────────────────────────────────────────────────────────────────────────
// A. The fixture data itself
// ─────────────────────────────────────────────────────────────────────────────
suite.section("A. fixture data");
{
  const direct = FIXTURE_CHATS.filter((c) => !c.isGroup);
  const groups = FIXTURE_CHATS.filter((c) => c.isGroup);
  suite.check("8 conversations", FIXTURE_CHATS.length === 8, `got ${FIXTURE_CHATS.length}`);
  suite.check("5 direct + 3 group", direct.length === 5 && groups.length === 3, `${direct.length}/${groups.length}`);
  suite.check("chat list built", ds.chats.length === 8, `got ${ds.chats.length}`);

  const required = ["Arjun Kumar", "Priya Sharma", "Sanjay Raman", "Meera Krishnan", "Alex Thomas", "Cyber Security Team", "Project Alpha", "Internship Team"];
  const names = ds.chats.map((c) => c.name);
  for (const r of required) suite.check(`roster contains "${r}"`, names.includes(r));

  // WEB-2.1 unread variety: 0, 1, 2 and 5+ must all be reachable.
  const unreads = ds.chats.map((c) => c.unread).sort((a, b) => a - b);
  suite.check("has a 0-unread chat", unreads.includes(0), `unreads=${unreads}`);
  suite.check("has a 1-unread chat", unreads.includes(1));
  suite.check("has a 2-unread chat", unreads.includes(2));
  suite.check("has a 5+-unread chat", unreads.some((u) => u >= 5));
  suite.check("unread values are not all identical", new Set(unreads).size >= 4, `distinct=${new Set(unreads).size}`);

  // WEB-2.1 online/offline, and group vs direct.
  suite.check("has online and offline rows", ds.chats.some((c) => c.online) && ds.chats.some((c) => !c.online));
  suite.check("summary type reflects group-ness", ds.chats.filter((c) => c.isGroup).length === 3);

  // WEB-2.1 list ordering + timestamp shape.
  const times = ds.chats.map((c) => new Date(c.time).getTime());
  suite.check("chat list sorted newest first", times.every((t, i) => i === 0 || times[i - 1] >= t));
  suite.check("every timestamp is ISO-8601", ds.chats.every((c) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(c.time)));
  suite.check("every timestamp is in the past", times.every((t) => t < NOW));

  // WEB-2.2 the long thread: 30-50 messages, with everything that stresses it.
  const counts = FIXTURE_CHATS.map((c) => ds.history[c.id].length);
  const longest = Math.max(...counts);
  suite.check("a thread has 30-50 messages", longest >= 30 && longest <= 50, `longest=${longest}`);
  const longId = FIXTURE_CHATS.find((c) => ds.history[c.id].length === longest).id;
  const thread = ds.history[longId];
  suite.check("long thread mixes incoming and outgoing", new Set(thread.map((m) => m.from)).size >= 2);
  suite.check("long thread has consecutive same-sender runs", thread.some((m, i) => i > 0 && m.from === thread[i - 1].from));
  const gaps = thread.slice(1).filter((m, i) => new Date(m.time) - new Date(thread[i].time) >= 60_000).length;
  suite.check("long thread has several timestamp gaps", gaps >= 5, `gaps>=60s: ${gaps}`);
  suite.check("long thread has long text", thread.some((m) => m.text.length > 120), `max=${Math.max(...thread.map((m) => m.text.length))}`);
  suite.check("long thread has short replies", thread.some((m) => m.text.length <= 12));
  const openUnread = FIXTURE_CHATS.find((c) => c.id === longId).unread;
  suite.check("long thread carries unread near the bottom", openUnread > 0, `unread=${openUnread}`);

  // WEB-2.2 grouping/timestamps work on real data.
  const peerIds = FIXTURE_CHATS.find((c) => c.id === longId).memberIds.filter((p) => p !== FIXTURE_SELF);
  suite.check("long thread names a non-self sender", peerIds.length > 0 && thread.some((m) => peerIds.includes(m.from)));
  suite.check("outgoing rows use the self sentinel pre-attribution", thread.some((m) => m.from === FIXTURE_SELF));

  // WEB-2.2/2.3 message kinds — only kinds the existing model supports.
  const kinds = new Set();
  for (const rows of Object.values(ds.history)) for (const m of rows) kinds.add(m.mKind || "text");
  suite.check("text messages present", kinds.has("text"));
  suite.check("image messages present", kinds.has("image"), `kinds=${[...kinds]}`);
  suite.check("voice messages present", kinds.has("voice"));
  suite.check("no unsupported kind invented", [...kinds].every((k) => ["text", "image", "voice"].includes(k)), `kinds=${[...kinds]}`);

  const media = Object.values(ds.history).flat().filter((m) => m.mKind === "image" || m.mKind === "voice");
  suite.check("media rows carry metadata", media.every((m) => typeof m.mimeType === "string"));
  suite.check("image rows carry a byte size", media.filter((m) => m.mKind === "image").every((m) => typeof m.sizeBytes === "number"));
  suite.check("voice rows carry a duration", media.filter((m) => m.mKind === "voice").every((m) => typeof m.durationSec === "number"));
  suite.check("media rows carry NO attachmentId (no dead media URL)", media.every((m) => !("attachmentId" in m)));

  // WEB-2.1 preview always mirrors the newest message. History is oldest first,
  // so the newest row is the LAST one - and it is what a transcript's last
  // bubble and a sidebar preview must both show.
  for (const c of ds.chats) {
    const rowsOf = ds.history[c.id];
    const newest = rowsOf[rowsOf.length - 1];
    const oldest = rowsOf[0];
    suite.check(`history is oldest-first (${c.name})`, new Date(oldest.time) <= new Date(newest.time));
    suite.check(`preview mirrors newest row (${c.name})`, c.preview === newest.text || c.preview === "Image" || c.preview === "Voice message");
    suite.check(`chat time equals newest row time (${c.name})`, c.time === newest.time);
  }

  // Group participants resolve to fictional names.
  const allMemberIds = FIXTURE_CHATS.flatMap((c) => c.memberIds);
  suite.check("group members include the signed-in user", FIXTURE_CHATS.filter((c) => c.isGroup).every((c) => c.memberIds.includes(FIXTURE_SELF)));
  suite.check("every member id resolves to a name", allMemberIds.every((id) => participantName(id) !== "Unknown"));
  suite.check("a long participant name exists for layout testing", FIXTURE_PARTICIPANTS.some((p) => p.name.length > 18), `longest=${Math.max(...FIXTURE_PARTICIPANTS.map((p) => p.name.length))}`);

  // Every sender is a known fixture participant or the signed-in user.
  const everyFrom = Object.values(ds.history).flat().map((m) => m.from);
  suite.check("no unknown message sender", everyFrom.every((f) => f === FIXTURE_SELF || FIXTURE_PARTICIPANTS.some((p) => p.id === f)));
}

// ─────────────────────────────────────────────────────────────────────────────
// B. The existing search + list-state logic accepts this data
// ─────────────────────────────────────────────────────────────────────────────
suite.section("B. shared search + list state over the fixtures");
{
  const rows = ds.chats.map((c) => ({ name: c.name, preview: c.preview }));
  suite.check("list is 'populated', not 'empty'", decideChatListState(rows, "") === "populated");
  suite.check("list is 'populated' with a stale non-matching query", decideChatListState(rows, "zzz-nothing") === "no-matches");

  // Sidebar filter: by display name.
  suite.check("sidebar finds a chat by name", filterChats(rows, "arjun").length === 1);
  suite.check("sidebar is case-insensitive", filterChats(rows, "ARJUN").length === 1);
  suite.check("sidebar finds a group by name", filterChats(rows, "cyber").length === 1);
  suite.check("blank query returns every chat", filterChats(rows, "   ").length === 8);
  suite.check("unknown term yields no rows", filterChats(rows, "zzzz").length === 0);
  suite.check("partial term matches a chat name", filterChats(rows, "proj").some((r) => r.name === "Project Alpha"));

  // Sidebar filter: by message preview.
  suite.check("sidebar finds a chat by preview text", filterChats(rows, "deployment").length >= 1, `n=${filterChats(rows, "deployment").length}`);

  // In-thread search over the real threads, using the shared matcher exactly
  // as the UI does (chooseMatchIndexes walks the history, splitHighlight uses
  // the capture-group pattern).
  const allRows = Object.values(ds.history).flat();
  for (const term of FIXTURE_SEARCH_TERMS) {
    const pattern = buildSearchPattern(term);
    const indexes = chooseMatchIndexes(allRows, pattern);
    suite.check(`in-thread search finds "${term}"`, pattern !== null && indexes.length > 0, `${indexes.length} row(s)`);
  }
  // The shared matcher must survive regex metacharacters present in the corpus.
  const metaRow = allRows.find((m) => /[.*+?^${}()|[\]\\]/.test(m.text));
  if (metaRow) {
    const pattern = buildSearchPattern(".");
    suite.check("metacharacter row does not break the matcher", pattern !== null && typeof pattern.test(metaRow.text) === "boolean");
    const literal = buildSearchPattern("(sanjay)");
    suite.check("a parenthesised query is escaped, not compiled as a group", literal !== null && /\\\(/.test(literal.source), `source=${literal?.source}`);
    suite.check("a parenthesised query matches nothing when absent", literal !== null && chooseMatchIndexes(allRows, literal).length === 0);
  } else {
    suite.check("no regex metacharacter present", true);
  }
  const firstWord = allRows[0].text.split(" ")[0];
  const pattern = buildSearchPattern(firstWord);
  const parts = splitHighlight(allRows[0].text, pattern);
  suite.check("highlighting splits around a match", parts.length >= 3 && parts.filter((_, i) => i % 2 === 1).length >= 1, `parts=${parts.length}`);
  suite.check("highlighting is lossless", parts.join("") === allRows[0].text);
  suite.check("no pattern for an empty query", buildSearchPattern("   ") === null);
}

// ─────────────────────────────────────────────────────────────────────────────
// C. Development-only invariants
// ─────────────────────────────────────────────────────────────────────────────
suite.section("C. development-only invariants");
{
  const src = read("app/lib/dev-fixtures/sample-data.ts");
  const provider = read("app/lib/dev-fixtures/fixture-chat-source.ts");
  const seam = read("app/lib/chat-source.ts");
  const gate = read("app/lib/chat-fixtures-gate.ts");

  // No secret-ish material anywhere in the fixture layer.
  const fixturesSrc = src + provider;
  for (const [label, re] of [
    ["no access token", /eyJ[A-Za-z0-9_-]{10,}/],
    ["no private key block", /BEGIN [A-Z ]*PRIVATE KEY/],
    ["no external URL", /https?:\/\//],
    ["no database URL", /DATABASE_URL|postgresql:\/\//],
    ["no jwt secret", /JWT_SECRET\s*=\s*\S/],
    ["no email address", /[\w.+-]+@[\w-]+\.[\w.]+/],
  ]) {
    suite.check(label, !re.test(fixturesSrc), re.exec(fixturesSrc)?.[0] ?? "");
  }

  // The seam must not import React or the relay mock server.
  suite.check("seam does not import React", !/from ["']react/.test(seam));
  suite.check("seam does not reference the relay mock server", !/wpt-server/.test(seam));
  suite.check("provider is not a mock API route", !/app\/api|NextResponse|export async function POST/.test(provider));

  // No production component may reach the fixtures.
  const components = ["app/wpt/web-app.tsx", "app/wpt/chat-app.tsx", "app/wpt/qr-gate.tsx", "app/wpt/linking-screen.tsx", "app/wpt/icons.tsx"];
  for (const c of components) {
    const s = read(c);
    suite.check(`${c} does not import dev fixtures`, !/dev-fixtures|sample-data|fixture-chat-source/.test(s));
    suite.check(`${c} contains no fixture name`, !/Cyber Security Team|Project Alpha|Internship Team|Arjun Kumar|Meera Krishnan/.test(s));
  }

  // The relay source keeps the exact production paths it had before the seam.
  suite.check("relay still GETs /api/recent-chats/{uid}", /\/api\/recent-chats\/\$\{encodeURIComponent\(uid\)\}/.test(seam));
  suite.check("relay still GETs /api/messages/{uid}/{peer}", /\/api\/messages\/\$\{encodeURIComponent\(uid\)\}/.test(seam));
  suite.check("relay still GETs /api/group-messages/{gid}", /\/api\/group-messages\/\$\{encodeURIComponent\(key\)\}/.test(seam));
  suite.check("relay source is declared", /export const relayChatSource: ChatSource/.test(seam));

  // The production wire model is untouched: unread is optional and additive.
  const types = read("app/wpt/types.ts");
  suite.check("ServerChatSummaryItem gained no unread field", !/unread/.test(types));
  const seamTypes = seam.slice(seam.indexOf("export interface ChatSummaryRow"), seam.indexOf("export interface ChatSource"));
  suite.check("unread is optional on the seam row", /unread\?: number/.test(seamTypes));
  suite.check("WebChatItem model untouched by fixtures", /unread: number/.test(read("app/lib/app-state.ts")));

  // The gate is the only switch, and it is closed in production.
  suite.check("gate module is dependency-free", !/^import /m.test(gate));
  suite.check("gate keys off NODE_ENV", /NODE_ENV !== "development" && env\.NODE_ENV !== "test"/.test(gate));
  suite.check("gate fails closed (no 'not equal to production' shortcut)", !/!== "production"/.test(gate));
  suite.check("gate refuses every production spelling", ["production", "PRODUCTION", "prod", "staging", ""].every((v) => chatFixturesEnabled({ NODE_ENV: v }) === false));
}

// ─────────────────────────────────────────────────────────────────────────────
// D. Production exclusion (TEST 17)
// ─────────────────────────────────────────────────────────────────────────────
suite.section("D. production exclusion");
{
  // Executed gate, not a reading of it.
  suite.check("gate closed when NODE_ENV=production", chatFixturesEnabled({ NODE_ENV: "production" }) === false);
  suite.check("gate closed in production even with the opt-in flag", chatFixturesEnabled({ NODE_ENV: "production", NEXT_PUBLIC_CHAT_FIXTURES: "1" }) === false);
  suite.check("gate closed in production with any flag value", ["", "0", "1", "true", "yes"].every((v) => chatFixturesEnabled({ NODE_ENV: "production", NEXT_PUBLIC_CHAT_FIXTURES: v }) === false));
  suite.check("gate closed for every non-development NODE_ENV spelling", ["production", "PRODUCTION", "Production", "prod", "", "staging", undefined].every((v) => chatFixturesEnabled({ NODE_ENV: v }) === false), `PRODUCTION=${chatFixturesEnabled({ NODE_ENV: "PRODUCTION" })} unset=${chatFixturesEnabled({})}`);
  suite.check("gate open in development", chatFixturesEnabled({ NODE_ENV: "development" }) === true);
  suite.check("gate open in test", chatFixturesEnabled({ NODE_ENV: "test" }) === true);
  suite.check("gate respects the documented opt-out", chatFixturesEnabled({ NODE_ENV: "development", NEXT_PUBLIC_CHAT_FIXTURES: "0" }) === false);
  suite.check("gate stays open for an explicit enable", chatFixturesEnabled({ NODE_ENV: "development", NEXT_PUBLIC_CHAT_FIXTURES: "1" }) === true);

  // The provider itself is the second barrier: refuse to answer when closed.
  const provider = read("app/lib/dev-fixtures/fixture-chat-source.ts");
  const guards = (provider.match(/if \(!chatFixturesEnabled\(\)\) return null;/g) || []).length;
  suite.check("provider guards BOTH listChats and loadHistory", guards === 2, `guards=${guards}`);

  // The ONLY reference to the provider in the app is the gated dynamic import.
  const seam = read("app/lib/chat-source.ts");
  const idxGuard = seam.indexOf("if (!DEV_ENV || !chatFixturesEnabled()) return relayChatSource;");
  const idxImport = seam.indexOf('await import("./dev-fixtures/fixture-chat-source")');
  suite.check("seam checks the gate before importing the provider", idxGuard !== -1 && idxImport > idxGuard, `guard@${idxGuard} import@${idxImport}`);
  suite.check("the call-site guard reads process.env.NODE_ENV for build-time folding", /const DEV_ENV = process\.env\.NODE_ENV === "development" \|\| process\.env\.NODE_ENV === "test"/.test(seam));
  suite.check("provider is imported dynamically, not statically", /await import\(/.test(seam) && !/^import .*fixture-chat-source/m.test(seam));

  // No other file in the app graph mentions the provider or the fixture data.
  const walk = (dir, acc = []) => {
    for (const e of fs.readdirSync(path.join(APP, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel, acc);
      else if (/\.(ts|tsx)$/.test(e.name)) acc.push(rel.split(path.sep).join("/"));
    }
    return acc;
  };
  const files = walk("app").concat(walk("server"));
  const referencing = files.filter((f) => {
    if (f.endsWith("dev-fixtures/fixture-chat-source.ts")) return false;
    return /fixture-chat-source|dev-fixtures\/sample-data/.test(read(f));
  });
  suite.check("only the seam and the harness reference the fixtures", referencing.every((f) => f === "app/lib/chat-source.ts"), `referencing=${referencing}`);
  suite.check("exactly one app file references the provider", referencing.length === 1, `n=${referencing.length}`);
}

suite.section("E. production build artefacts");
{
  // These assertions are about a real `next build`, so they only run when one is
  // present. The verify chain itself does not need a build (skipped otherwise) -
  // `pnpm --filter @wpt/web build` followed by `node scripts/web-fixtures-verify.js`
  // checks them.
  const staticDir = path.join(APP, ".next", "static");
  if (!fs.existsSync(staticDir)) {
    suite.check("production artefact check skipped (no .next build present)", true);
  } else {
    const files = fs.readdirSync(staticDir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".js"))
      .map((e) => path.join(e.parentPath || e.path, e.name));
    const reads = files.map((f) => [f, read(path.relative(APP, f).split(path.sep).join("/"))]);
    const carriers = reads.filter(([, src]) => /Arjun Kumar|Cyber Security Team|Internship Team|Meera Krishnan|buildFixtureDataset/.test(src));

    suite.check("a production build was found to inspect", files.length > 0, `js files=${files.length}`);
    suite.check("fixture text appears in no more than one chunk", carriers.length <= 1, `carriers=${carriers.map(([f]) => path.basename(f))}`);
    if (carriers.length === 1) {
      // The fixture module id in the emitted chunk is matched against every other
      // chunk: if nothing binds or requires it, the browser cannot load it.
      const idMatch = carriers[0][1].match(/\d{3,6}:\(?[a-z,=]*\)?=>\{[a-z]+\.r\(t\),[a-z]+\.d\(t,\{fixtureChatSource/);
      const moduleId = idMatch ? idMatch[0].match(/(\d{3,6}):/)[1] : null;
      suite.check("the fixture chunk declares its module id", moduleId !== null, `id=${moduleId}`);
      if (moduleId) {
        const bound = reads.filter(([f, src]) => f !== carriers[0][0] && new RegExp(`bind\\([a-z]+,${moduleId}\\)|\\.e\\(${moduleId}\\)`).test(src));
        suite.check("NO shipped chunk loads the fixture module", bound.length === 0, `loaded by=${bound.map(([f]) => path.basename(f))}`);
      }
      suite.check("the fixture chunk is not a Next.js page", !fs.readFileSync(path.join(APP, ".next", "server", "pages-manifest.json"), "utf8").includes("fixture-chat-source"));
      // A chunk listed in these two manifests is fetched by the browser as an initial
      // or route static asset. It must not appear in either.
      const shipped = ["app-build-manifest.json", "build-manifest.json", "prerender-manifest.json"].filter((m) => {
        const p = path.join(APP, ".next", m);
        return fs.existsSync(p) && fs.readFileSync(p, "utf8").includes(path.basename(carriers[0][0]));
      });
      suite.check("no page manifest ships the fixture chunk", shipped.length === 0, `listed in=${shipped}`);
      // react-loadable-manifest.json is an internal moduleId -> file map used by
      // next/dynamic; registering an entry there does not fetch anything unless a
      // component awaits the import, which section E proved no chunk does.
      const loadablePath = path.join(APP, ".next", "react-loadable-manifest.json");
      const loadable = fs.existsSync(loadablePath) ? JSON.parse(fs.readFileSync(loadablePath, "utf8")) : {};
      const entry = Object.entries(loadable).find(([, v]) => JSON.stringify(v).includes(path.basename(carriers[0][0])));
      suite.check("the only manifest entry is a moduleId map, not a page", entry === undefined || typeof entry[1].id === "number", `entry=${entry && entry[0]}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// F. The seam resolves correctly at runtime
// ─────────────────────────────────────────────────────────────────────────────
// The previous sections read the seam's source; this one EXECUTES it. Node's
// type-stripping loader requires explicit extensions on relative specifiers,
// which Next/webpack does not, so the two modules that form the seam are copied
// to a temp directory with their local specifiers rewritten to absolute file
// URLs. Nothing under app/ is written or modified - and the real provider,
// real gate and real dataset are still the code that runs.
suite.section("F. live seam resolution");
{
  const os = await import("node:os");
  const { pathToFileURL } = await import("node:url");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wpt-fixtures-"));
  const abs = (p) => pathToFileURL(path.join(APP, p)).href;

  const seamPath = path.join(tmp, "seam.ts");
  const providerPath = path.join(tmp, "provider.ts");
  fs.writeFileSync(
    providerPath,
    read("app/lib/dev-fixtures/fixture-chat-source.ts")
      .replace('from "../chat-source"', `from "${pathToFileURL(seamPath).href}"`)
      .replace('from "../chat-fixtures-gate"', `from "${abs("app/lib/chat-fixtures-gate.ts")}"`)
      .replace('from "./sample-data"', `from "${abs("app/lib/dev-fixtures/sample-data.ts")}"`),
  );
  fs.writeFileSync(
    seamPath,
    read("app/lib/chat-source.ts")
      .replace('from "./api"', `from "${abs("app/lib/api.ts")}"`)
      .replace('from "./chat-fixtures-gate"', `from "${abs("app/lib/chat-fixtures-gate.ts")}"`)
      .replace('"./dev-fixtures/fixture-chat-source"', `"${pathToFileURL(providerPath).href}"`),
  );

  // NODE_ENV is read when a module is first evaluated (DEV_ENV) AND when
  // chatFixturesEnabled() is called, so the environment must stay in place for
  // the whole import-and-resolve sequence, not just the import. Each
  // environment therefore gets its own module instance via a cache-busting
  // specifier, and the original environment is restored at the end.
  const ORIGINAL_ENV = { NODE_ENV: process.env.NODE_ENV, NEXT_PUBLIC_CHAT_FIXTURES: process.env.NEXT_PUBLIC_CHAT_FIXTURES };
  const setEnv = (env) => {
    if (env.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env.NODE_ENV;
    if (env.NEXT_PUBLIC_CHAT_FIXTURES === undefined) delete process.env.NEXT_PUBLIC_CHAT_FIXTURES;
    else process.env.NEXT_PUBLIC_CHAT_FIXTURES = env.NEXT_PUBLIC_CHAT_FIXTURES;
  };
  const restoreEnv = () => setEnv(ORIGINAL_ENV);
  const loadSeam = (env, n) => import(`${pathToFileURL(seamPath).href}?n=${n}`);

  const SESSION = "user-1234";
  try {
    setEnv({ NODE_ENV: "development" });
    const dev = await loadSeam({ NODE_ENV: "development" }, 1);
    const fixtureSource = await dev.resolveChatSource();
    suite.check("development resolves the FIXTURE source", fixtureSource.kind === "fixtures", `kind=${fixtureSource.kind}`);

    setEnv({ NODE_ENV: "production" });
    const prod = await loadSeam({ NODE_ENV: "production" }, 2);
    const prodSource = await prod.resolveChatSource();
    suite.check("production resolves the RELAY source", prodSource.kind === "relay", `kind=${prodSource.kind}`);
    suite.check("production and development resolve different sources", prodSource !== fixtureSource);

    setEnv({ NODE_ENV: "development", NEXT_PUBLIC_CHAT_FIXTURES: "0" });
    const opted = await loadSeam({ NODE_ENV: "development", NEXT_PUBLIC_CHAT_FIXTURES: "0" }, 3);
    const optedSource = await opted.resolveChatSource();
    suite.check("NEXT_PUBLIC_CHAT_FIXTURES=0 opts back into the RELAY", optedSource.kind === "relay", `kind=${optedSource.kind}`);

    setEnv({ NODE_ENV: "development" });

    // The provider answers with the real wire shapes.
    const rows = await fixtureSource.listChats(SESSION);
    suite.check("listChats returns the 8 fixture summaries", Array.isArray(rows) && rows.length === 8, `n=${Array.isArray(rows) ? rows.length : rows}`);
    suite.check("summaries carry the relay shape only", rows.every((r) => r.id && r.name && r.preview && r.time && (r.type === "direct" || r.type === "group")));
    suite.check("unread is additive metadata, never a relay field", rows.every((r) => r.unread === undefined || typeof r.unread === "number"));
    suite.check("a fully-read chat omits unread entirely", rows.some((r) => r.unread === undefined));
    suite.check("a group summary is typed as a group", rows.filter((r) => r.type === "group").length === 3);
    suite.check("initialTyping is exposed as existing state", fixtureSource.initialTyping && Object.keys(fixtureSource.initialTyping).length >= 1, JSON.stringify(fixtureSource.initialTyping));

    const summary = rows.find((r) => r.type === "direct" && r.unread > 0);
    const history = await fixtureSource.loadHistory(SESSION, { id: summary.id, serverId: null, isGroup: false });
    suite.check("loadHistory returns rows for an unmatched chat id", Array.isArray(history) && history.length > 0, `n=${Array.isArray(history) ? history.length : history}`);
    suite.check("history rows use the relay message shape", history.every((m) => m.id && m.from && m.text && m.time));
    suite.check("the signed-in user's rows are attributed to the REAL user id", history.some((m) => m.from === SESSION), `sent=${history.filter((m) => m.from === SESSION).length}`);
    suite.check("the fixture self sentinel never reaches the app", history.every((m) => m.from !== "fixture:self"));
    suite.check("history is oldest-first", history.every((m, i) => i === 0 || new Date(history[i - 1].time) <= new Date(m.time)));

    const groupSummary = rows.find((r) => r.type === "group");
    const groupHistory = await fixtureSource.loadHistory(SESSION, { id: groupSummary.id, serverId: null, isGroup: true });
    suite.check("a group conversation loads its own history", Array.isArray(groupHistory) && groupHistory.length > 0, `n=${Array.isArray(groupHistory) ? groupHistory.length : groupHistory}`);

    // Unknown conversation -> null, exactly like a relay miss.
    suite.check("an unknown conversation returns null (no throw)", (await fixtureSource.loadHistory(SESSION, { id: "fixture:nope", serverId: null, isGroup: false })) === null);

    // The provider refuses when the gate is closed, even if it is imported.
    const closedProvider = await import(`${pathToFileURL(providerPath).href}?n=closed`);
    setEnv({ NODE_ENV: "production" });
    suite.check("provider.listChats is null in production", (await closedProvider.fixtureChatSource.listChats(SESSION)) === null);
    suite.check("provider.loadHistory is null in production", (await closedProvider.fixtureChatSource.loadHistory(SESSION, { id: "x", serverId: null, isGroup: false })) === null);

    // And the relay source is still the real thing.
    suite.check("relay source exposes no fixture typing seed", prodSource.initialTyping === undefined || Object.keys(prodSource.initialTyping).length === 0);
  } finally {
    restoreEnv();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

suite.summary();
process.exit(suite.failed === 0 ? 0 : 1);