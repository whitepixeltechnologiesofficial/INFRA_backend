// DEVELOPMENT-ONLY sample conversations for WEB-2.1 -> WEB-2.5.
//
// This module is PURE and dependency-free: no React, no fetch, no env reads, no
// crypto. It is executed directly by scripts/web-fixtures-verify.js with Node
// type stripping, exactly like ./receipts.ts, ./search.ts and
// ./chat-list-state.ts, so the shipped fixtures and the verified fixtures cannot
// drift apart.
//
// ── Everything in here is FICTIONAL ────────────────────────────────────────────
// The participants are invented test identities. They are not rows from the
// database, they are not connected to any real account, and they carry no
// credential, token, key or contact detail of any kind. Nothing here may be
// used outside a development build.
//
// ── Only EXISTING model fields are used ───────────────────────────────────────
// The shapes below mirror what the chat relay already emits
// (`ServerChatSummaryItem` / `ServerSentMessage`) and what app/lib/app-state.ts
// already stores (`WebChatItem` / `WebChatMessage`), so enabling fixtures
// required no production model change. Deliberately NOT modelled, because the
// Web client does not support them at all: pinned, muted, per-chat draft,
// attachment/file messages and system messages. See the delivery report.
//
// ── Media rows are METADATA-ONLY ─────────────────────────────────────────────
// `kind: "image" | "voice"` rows carry a mime type, size and duration but NO
// `attachmentId`, because a real one would point at the relay's
// `/api/media/:id` endpoint. With no attachment id the existing renderer shows
// its own designed pending state, which is a genuine WEB-2.4 case and keeps the
// fixtures free of dead URLs and invented binaries.

/** Sentinel for "sent by the signed-in user". Replaced with the real account id. */
export const FIXTURE_SELF = "fixture:self";

export interface FixtureReplyRef {
  id: string;
  name: string;
  text: string;
}

export interface FixtureMessageSpec {
  /** Participant id, or FIXTURE_SELF for an outgoing row. */
  from: string;
  text: string;
  /** Minutes BEFORE `now`. Kept as a delta so the dataset is relative and stable. */
  agoMin: number;
  kind?: "text" | "image" | "voice";
  mimeType?: string;
  sizeBytes?: number;
  durationSec?: number;
  replyTo?: FixtureReplyRef;
}

export interface FixtureChatSpec {
  id: string;
  name: string;
  isGroup: boolean;
  online: boolean;
  /** Unread on first load. Drives the WEB-2.1 badge without hiding it in CSS. */
  unread: number;
  /** Participant ids, INCLUDING FIXTURE_SELF, for the group member model. */
  memberIds: string[];
  /** Oldest first. */
  messages: FixtureMessageSpec[];
}

/** Fictional participants. `long` exists to prove long names do not break layout. */
export const FIXTURE_PARTICIPANTS: { id: string; name: string }[] = [
  { id: "fixture:arjun", name: "Arjun Kumar" },
  { id: "fixture:priya", name: "Priya Sharma" },
  { id: "fixture:sanjay", name: "Sanjay Raman" },
  { id: "fixture:meera", name: "Meera Krishnan" },
  { id: "fixture:alex", name: "Alex Thomas" },
  { id: "fixture:venkat", name: "Venkateshwaragopalan Iyer" },
];

const ME = FIXTURE_SELF;
const arjun = "fixture:arjun";
const priya = "fixture:priya";
const sanjay = "fixture:sanjay";
const meera = "fixture:meera";
const alex = "fixture:alex";
const venkat = "fixture:venkat";

const IMAGE_MIME = "image/jpeg";
const VOICE_MIME = "audio/webm";

/** The WEB-2.1 requested roster: 5 direct + 3 group, each with a distinct state. */
export const FIXTURE_CHATS: FixtureChatSpec[] = [
  // ── 1. recent, online, small unread ───────────────────────────────────────
  {
    id: "fixture:arjun",
    name: "Arjun Kumar",
    isGroup: false,
    online: true,
    unread: 2,
    memberIds: [arjun, ME],
    messages: [
      { from: arjun, text: "Hey, did you finish the Web Linking testing?", agoMin: 95 },
      { from: ME, text: "Almost. I'm testing the QR flow now.", agoMin: 93 },
      { from: arjun, text: "Nice. Let me know when it works.", agoMin: 92 },
      { from: ME, text: "Sure, I'll test the second browser case too.", agoMin: 91 },
      { from: arjun, text: "Perfect 👍", agoMin: 90 },
      { from: arjun, text: "One thing I noticed: the security review asked whether the QR payload ever leaves the browser with a phone number in it. I told them it doesn't.", agoMin: 18 },
      { from: ME, text: "Correct - the production payload is only the opaque link token. No number, no name, nothing.", agoMin: 16 },
      { from: arjun, text: "Great, that's the answer I needed. Sending it to the security team now.", agoMin: 12 },
    ],
  },

  // ── 2. no unread, last row is mine and read ───────────────────────────────
  {
    id: "fixture:priya",
    name: "Priya Sharma",
    isGroup: false,
    online: false,
    unread: 0,
    memberIds: [priya, ME],
    messages: [
      { from: priya, text: "Are we still on for the sprint review meeting at four?", agoMin: 240 },
      { from: ME, text: "Yes. I'll bring the test results.", agoMin: 238 },
      { from: priya, text: "Perfect. I'll send the agenda beforehand.", agoMin: 237 },
      { from: ME, text: "Sounds good.", agoMin: 236 },
      { from: priya, text: "Also - can you look at my PR when you get a minute?", agoMin: 60 },
      { from: ME, text: "Already reviewed it. Two small comments, nothing blocking.", agoMin: 34 },
    ],
  },

  // ── 3. several recent rows from one peer (grouping) ───────────────────────
  {
    id: "fixture:sanjay",
    name: "Sanjay Raman",
    isGroup: false,
    online: true,
    unread: 0,
    memberIds: [sanjay, ME],
    messages: [
      { from: sanjay, text: "The backend build finished.", agoMin: 42 },
      { from: sanjay, text: "All green.", agoMin: 42 },
      { from: sanjay, text: "Deployment is queued for tonight.", agoMin: 41 },
      { from: ME, text: "Should I hold the release notes until after?", agoMin: 39 },
      { from: sanjay, text: "No, go ahead. Nothing else is landing today.", agoMin: 38 },
    ],
  },

  // ── 4. unread conversation with a long preview ────────────────────────────
  {
    id: "fixture:meera",
    name: "Meera Krishnan",
    isGroup: false,
    online: false,
    unread: 6,
    memberIds: [meera, ME],
    messages: [
      { from: meera, text: "Hi - are you around later?", agoMin: 300 },
      { from: ME, text: "Around until six.", agoMin: 298 },
      { from: meera, text: "Good. I need a hand with the deployment checklist before Friday.", agoMin: 290 },
      { from: meera, text: "Specifically the rollback step - I want to be sure we have a tested path back before we ship anything new to production.", agoMin: 288 },
      { from: ME, text: "Yes. Let's walk through it together.", agoMin: 285 },
      { from: meera, text: "That would be wonderful, thank you.", agoMin: 26 },
      { from: meera, text: "I wrote down the steps I think we need and I'd rather we go through them together than have me guess.", agoMin: 25 },
      { from: meera, text: "The first part is the database migration, then the service restart, then the smoke test.", agoMin: 25 },
      { from: meera, text: "Then we verify the rollback still works before we call it done.", agoMin: 24 },
      { from: meera, text: "Does that match what you remember?", agoMin: 24 },
      { from: meera, text: "No rush - tomorrow morning works just as well if today gets busy. The deployment can wait for both of us.", agoMin: 23 },
    ],
  },

  // ── 5. older conversation, offline peer ──────────────────────────────────
  {
    id: "fixture:alex",
    name: "Alex Thomas",
    isGroup: false,
    online: false,
    unread: 0,
    memberIds: [alex, ME],
    messages: [
      { from: alex, text: "Hey, are you still working on the messaging project?", agoMin: 8_600 },
      { from: ME, text: "I am. Why?", agoMin: 8_595 },
      { from: alex, text: "I might join the team next month.", agoMin: 8_590 },
      { from: ME, text: "That would be good. There's a lot to do on the backend.", agoMin: 8_580 },
      { from: alex, text: "Good to know. I'll reach out when it's official.", agoMin: 8_575 },
    ],
  },

  // ── 6. group, one unread, includes the long participant name ──────────────
  {
    id: "fixture:grp-cyber",
    name: "Cyber Security Team",
    isGroup: true,
    online: false,
    unread: 1,
    memberIds: [arjun, priya, sanjay, meera, venkat, ME],
    messages: [
      { from: priya, text: "Reminder: the security review is on Thursday.", agoMin: 1_500 },
      { from: sanjay, text: "Noted. I'll bring the session ticket list.", agoMin: 1_495 },
      { from: ME, text: "I'll cover the QR hand-off section.", agoMin: 1_490 },
      { from: venkat, text: "Can someone also review the token expiry policy? Thirty seconds felt short during testing.", agoMin: 1_200 },
      { from: arjun, text: "It's sixty seconds now. We doubled it after the first round of testing.", agoMin: 1_190 },
      { from: priya, text: "Much better. I'll update the document.", agoMin: 1_185 },
      { from: meera, text: "One more from the audit: we still need to confirm that a token cannot be registered twice after it has already been approved. I'll write that up today.", agoMin: 45 },
    ],
  },

  // ── 7. group, active discussion, several unread, THE LONG THREAD ──────────
  {
    id: "fixture:grp-alpha",
    name: "Project Alpha",
    isGroup: true,
    online: false,
    unread: 5,
    memberIds: [alex, arjun, meera, ME],
    messages: [
      { from: arjun, text: "Kicking off the Project Alpha thread here so we stop splitting across three chats.", agoMin: 2_900 },
      { from: alex, text: "Good call. I have notes from the last sync to paste in.", agoMin: 2_895 },
      { from: alex, text: "Main open item is still the deployment window.", agoMin: 2_894 },
      { from: arjun, text: "Agreed.", agoMin: 2_890 },
      { from: ME, text: "I'll take the backend piece - the migration and the rollback path.", agoMin: 2_880 },
      { from: meera, text: "And I'll coordinate with the security team.", agoMin: 2_875 },
      { from: arjun, text: "Thanks both. Let's do a short meeting tomorrow to lock the dates?", agoMin: 2_700 },
      { from: ME, text: "Works for me.", agoMin: 2_690 },
      { from: alex, text: "Same.", agoMin: 2_688 },
      { from: arjun, text: "Meeting is booked for the morning. Calendar invites are out.", agoMin: 2_600 },

      { from: meera, text: "Here is what I have so far.", agoMin: 900 },
      { from: meera, text: "Testing is mostly complete. The QR flow passes on both browsers.", agoMin: 899 },
      { from: meera, text: "One open bug: long group names wrap oddly in the sidebar on narrow widths.", agoMin: 898 },
      { from: ME, text: "I can fix that. Is it the header or the list row?", agoMin: 897 },
      { from: meera, text: "The list row.", agoMin: 896 },
      { from: ME, text: "Noted, thanks.", agoMin: 895 },

      { from: alex, text: "Adding to that - I saw the same thing on the conversation header.", agoMin: 800 },
      { from: alex, text: "Long group names need to truncate rather than push the layout sideways.", agoMin: 799 },
      { from: arjun, text: "Agreed with Alex here.", agoMin: 798 },
      { from: ME, text: "I'll handle both. Truncation plus a tooltip.", agoMin: 795 },

      { from: meera, text: "Also - the security review flagged the deployment checklist as incomplete.", agoMin: 500 },
      { from: meera, text: "Missing the rollback verification step.", agoMin: 499 },
      { from: meera, text: "For the record, the deployment runs in three stages: migrate the database, restart the backend service, then smoke test the new build - and each stage needs a confirmed rollback before we move to the next one.", agoMin: 498 },
      { from: ME, text: "I'll add it tonight.", agoMin: 497 },
      { from: arjun, text: "Please also note who verified it.", agoMin: 496 },

      { from: ME, text: "Done. Checklist updated with a verification field.", agoMin: 140 },
      { from: ME, text: "Tested the rollback twice against staging.", agoMin: 140 },
      { from: ME, text: "Both runs passed.", agoMin: 139 },
      { from: alex, text: "Excellent.", agoMin: 138 },

      { from: arjun, text: "Before we deploy - does the QR token still expire at sixty seconds?", agoMin: 75 },
      { from: ME, text: "Yes.", agoMin: 74 },
      { from: ME, text: "And the code is single-use, so a replay gets rejected.", agoMin: 74 },
      { from: meera, text: "Confirmed on my side too.", agoMin: 73 },
      { from: arjun, text: "Good. Testing is done then.", agoMin: 40 },
      { from: arjun, text: "One last thing - please confirm the backend deployment goes out after the mobile build, not before.", agoMin: 39 },
      { from: ME, text: "Understood. Backend last.", agoMin: 38 },
      { from: alex, text: "Same ordering on our side.", agoMin: 37 },
      { from: meera, text: "I'll update the runbook so nobody has to remember.", agoMin: 36 },
      { from: ME, text: "Thanks. That covers everything from the meeting.", agoMin: 8 },
      { from: arjun, text: "Great work everyone.", agoMin: 6 },
      { from: alex, text: "👍", agoMin: 5 },
      { from: meera, text: "Same. Let's ship it.", agoMin: 4 },
    ],
  },

  // ── 8. group, older, mixed message types ─────────────────────────────────
  {
    id: "fixture:grp-intern",
    name: "Internship Team",
    isGroup: true,
    online: false,
    unread: 0,
    memberIds: [priya, sanjay, venkat, ME],
    messages: [
      { from: priya, text: "Welcome to the internship team group.", agoMin: 4_300 },
      { from: sanjay, text: "Thanks Priya!", agoMin: 4_290 },
      { from: venkat, text: "Excited to be here.", agoMin: 4_285 },
      { from: priya, text: "First task: read the onboarding docs and introduce yourselves.", agoMin: 4_280 },
      { from: sanjay, text: "Done. The docs are good.", agoMin: 4_100 },
      { from: ME, text: "Here's the architecture diagram from the meeting.", agoMin: 3_500, kind: "image", mimeType: IMAGE_MIME, sizeBytes: 184_320 },
      { from: ME, text: "Let me know if it's too small to read.", agoMin: 3_499 },
      { from: priya, text: "It's clear. Thank you!", agoMin: 3_480 },
      { from: venkat, text: "Could you talk through the deployment part again? I missed that bit.", agoMin: 3_200 },
      { from: ME, text: "Of course.", agoMin: 3_190 },
      { from: ME, text: "Recording a short walkthrough.", agoMin: 3_189, kind: "voice", mimeType: VOICE_MIME, sizeBytes: 48_900, durationSec: 96 },
      { from: sanjay, text: "That's much clearer, thanks!", agoMin: 3_180 },
      { from: priya, text: "Great. See everyone at the next meeting.", agoMin: 3_000 },
    ],
  },
];

export interface FixtureChatSummary {
  id: string;
  name: string;
  isGroup: boolean;
  online: boolean;
  unread: number;
  preview: string;
  time: string;
}

export interface FixtureHistoryMessage {
  id: string;
  from: string;
  text: string;
  time: string;
  mKind?: string;
  mimeType?: string;
  sizeBytes?: number;
  durationSec?: number;
  replyTo?: FixtureReplyRef;
}

export interface FixtureDataset {
  chats: FixtureChatSummary[];
  /** Keyed by chat id, oldest message first. */
  history: Record<string, FixtureHistoryMessage[]>;
  /** Peer-typing seed for the WEB-2.3 typing row. */
  typing: Record<string, boolean>;
}

export function participantName(id: string): string {
  if (id === ME) return "You";
  const hit = FIXTURE_PARTICIPANTS.find((p) => p.id === id);
  return hit ? hit.name : "Unknown";
}

export function fixtureTime(nowMs: number, agoMin: number): string {
  return new Date(nowMs - agoMin * 60_000).toISOString();
}

/** Mirrors the relay's preview rule: a media row previews as its kind label. */
function previewText(m: FixtureMessageSpec): string {
  if (m.kind === "image") return "Image";
  if (m.kind === "voice") return "Voice message";
  return m.text;
}

/**
 * Builds the whole dataset relative to `nowMs`. A function rather than a const
 * so timestamps are always relative to the current date/time (never a frozen
 * date that would look stale) while remaining deterministic for tests.
 */
export function buildFixtureDataset(nowMs: number): FixtureDataset {
  const chats: FixtureChatSummary[] = [];
  const history: Record<string, FixtureHistoryMessage[]> = {};

  for (const spec of FIXTURE_CHATS) {
    // agoMin is "minutes ago", so a LARGER agoMin is the OLDER message. Sorting
    // descending therefore yields OLDEST FIRST, which is the order the relay
    // stores and returns history in and the order a transcript renders in.
    // The newest row is consequently the LAST element.
    const messages = [...spec.messages].sort((a, b) => b.agoMin - a.agoMin);
    const last = messages[messages.length - 1];
    if (!last) continue;

    history[spec.id] = messages.map((m, i) => {
      const row: FixtureHistoryMessage = {
        id: `fx-${spec.id.replace(/[^a-z0-9]/gi, "")}-${i}`,
        from: m.from === ME ? FIXTURE_SELF : m.from,
        text: m.text,
        time: fixtureTime(nowMs, m.agoMin),
      };
      if (m.kind && m.kind !== "text") row.mKind = m.kind;
      if (m.mimeType) row.mimeType = m.mimeType;
      if (typeof m.sizeBytes === "number") row.sizeBytes = m.sizeBytes;
      if (typeof m.durationSec === "number") row.durationSec = m.durationSec;
      if (m.replyTo) row.replyTo = m.replyTo;
      return row;
    });

    chats.push({
      id: spec.id,
      name: spec.name,
      isGroup: spec.isGroup,
      online: spec.online,
      unread: spec.unread,
      preview: previewText(last),
      time: fixtureTime(nowMs, last.agoMin),
    });
  }

  // Newest conversation first - the same order the sidebar renders.
  chats.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  return { chats, history, typing: { "fixture:grp-cyber": true } };
}

/** Every searchable term WEB-2.3 needs to be able to find. */
export const FIXTURE_SEARCH_TERMS = [
  "project",
  "security",
  "QR",
  "backend",
  "testing",
  "meeting",
  "deployment",
  "internship",
];