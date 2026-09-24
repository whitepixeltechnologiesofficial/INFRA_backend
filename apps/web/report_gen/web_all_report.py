"""Generate the Satheesh Kumar consolidated WEB 1.1 -> WEB 2.3 test report DOCX."""
import os
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import nsdecls
from docx.oxml import parse_xml

DARK = '1A1A2E'

doc = Document()
sec = doc.sections[0]
sec.top_margin = Cm(1.8)
sec.bottom_margin = Cm(1.8)
sec.left_margin = Cm(2.0)
sec.right_margin = Cm(2.0)

normal = doc.styles['Normal']
normal.font.name = 'Calibri'
normal.font.size = Pt(11)


def set_cell_shading(cell, color_hex):
    shading = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{color_hex}"/>')
    cell._tc.get_or_add_tcPr().append(shading)


def set_cell_text(cell, text, bold=False, font_size=10, align=None, color=None):
    p = cell.paragraphs[0]
    if align is not None:
        p.alignment = align
    run = p.add_run(text)
    run.bold = bold
    run.font.size = Pt(font_size)
    run.font.name = 'Calibri'
    if color is not None:
        run.font.color.rgb = color
    return run


def status_cell(cell, status):
    colors = {
        'PASS': ('2E7D32', 'E8F5E9'),
        'VERIFIED': ('2E7D32', 'E8F5E9'),
        'COMPLETED': ('1565C0', 'E3F2FD'),
        'REQUIRES DEVICE TEST': ('8A6D00', 'FFF8E1'),
        'FAIL': ('C62828', 'FFEBEE'),
    }
    fg, bg = colors.get(status, ('000000', 'FFFFFF'))
    set_cell_shading(cell, bg)
    p = cell.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(status)
    run.bold = True
    run.font.size = Pt(9)
    run.font.name = 'Calibri'
    run.font.color.rgb = RGBColor(int(fg[0:2], 16), int(fg[2:4], 16), int(fg[4:6], 16))


def header_row(table, labels):
    for j, header in enumerate(labels):
        set_cell_shading(table.rows[0].cells[j], DARK)
        set_cell_text(table.rows[0].cells[j], header, bold=True,
                      align=WD_ALIGN_PARAGRAPH.CENTER, color=RGBColor(0xFF, 0xFF, 0xFF))


def h(text, level=1):
    heading = doc.add_heading(text, level=level)
    for r in heading.runs:
        r.font.color.rgb = RGBColor(0x1A, 0x1A, 0x2E)
    return heading


def body(text, bold=False, size=11):
    p = doc.add_paragraph()
    run = p.add_run(text)
    run.bold = bold
    run.font.size = Pt(size)
    run.font.name = 'Calibri'
    return p


def bullet(text, bold_prefix=None):
    p = doc.add_paragraph(style='List Bullet')
    if bold_prefix:
        r = p.add_run(bold_prefix)
        r.bold = True
        r.font.size = Pt(11)
        r.font.name = 'Calibri'
    run = p.add_run(text)
    run.font.size = Pt(11)
    run.font.name = 'Calibri'
    return p


def kv(label, text, size=11):
    p = doc.add_paragraph()
    r1 = p.add_run(label)
    r1.bold = True
    r1.font.size = Pt(size)
    r1.font.name = 'Calibri'
    r2 = p.add_run(text)
    r2.font.size = Pt(size)
    r2.font.name = 'Calibri'
    return p


def data_table(rows, cols):
    t = doc.add_table(rows=rows, cols=cols)
    t.style = 'Table Grid'
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    return t


title = doc.add_paragraph()
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = title.add_run('Test Report')
run.bold = True
run.font.size = Pt(20)
run.font.name = 'Calibri'
run.font.color.rgb = RGBColor(0x1A, 0x1A, 0x2E)
sub = doc.add_paragraph()
sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
rsub = sub.add_run('WPT Web App — Consolidated Verification, WEB 1.1 to WEB 2.3  |  Satheesh Kumar  |  Team Alpha')
rsub.font.size = Pt(12)
rsub.font.color.rgb = RGBColor(0x3F, 0x3F, 0x3F)
doc.add_paragraph()

h('1. Sprint Overview', 1)
kv('Sprint period: ', '15 September 2026 – 24 September 2026 (WEB 1.1–1.9: 15–21 Sep; WEB 2.1–2.3: 22–24 Sep)')
kv('Role / focus: ', 'Implementation + machine verification of the WPT Web client: QR linking sessions, offline '
   'survival + invisible re-sync, manual logoff / tab-close persistence, new-phone force-logout, legacy client '
   'retirement, Phase-5 restyle, message-sending parity, and delivery parity (read receipts / typing / search).')
kv('Claim: ', 'Every requirement is verified by an executable harness against the LIVE relay '
   'server/wpt-server.mjs — the client socket is receive-only and all writes are REST, so the tests exercise the '
   'same wire the browser uses.')
kv('Overall result: ', '366/366 checks PASS across all ten suites (was 183/183 after WEB 1.1–1.9; 216/216 after '
   'WEB 2.1; 277/277 after WEB 2.2; 366/366 after WEB 2.3).')

doc.add_paragraph()
h('2. Scope & Requirements under test', 1)

t = data_table(13, 4)
header_row(t, ['Requirement', 'Deliverable', 'Suite', 'Result'])
scope = [
    ('WEB 1.1–1.3', 'QR scan-to-link gate (60s TTL, live countdown, confirm, post-link hardening)', 'web-qr13-verify.js', 'VERIFIED'),
    ('WEB 1.4', 'Web session survives phone offline; backend-relay sends + localStorage outbox', 'web-web14-verify.js + web-web14-live.js', 'VERIFIED'),
    ('WEB 1.5', 'Invisible reconnect sync (no sync UI, single-flight backlog refetch)', 'web-web15-verify.js', 'VERIFIED'),
    ('WEB 1.6', 'Manual logoff (only logout path; server revoke + fresh QR)', 'web-web16-verify.js', 'VERIFIED'),
    ('WEB 1.7', 'Tab-close persistence (localStorage survival, no unload cleanup)', 'web-web16-verify.js', 'VERIFIED'),
    ('WEB 1.8', 'New-phone login force-logs every Web session immediately', 'web-web17-verify.js', 'VERIFIED'),
    ('WEB 1.9', 'qr-login retirement + fully verified @wpt/web replacement (end-to-end funnel)', 'web-e2e.js', 'VERIFIED'),
    ('WEB 2.1', 'Phase-5 design restyle (sender labels, status ticks, panels, FAB) — logic untouched', 'web-21-verify.js', 'VERIFIED'),
    ('WEB 2.2', 'Message-sending parity: text / image / voice with one shared 100 MiB cap', 'web-22-verify.js', 'VERIFIED'),
    ('WEB 2.3', 'Delivery parity: four-state status, typing indicators + TTL, in-thread search', 'web-23-verify.js', 'VERIFIED'),
]
for i, (a, b, c, d) in enumerate(scope, start=1):
    set_cell_text(t.rows[i].cells[0], a, bold=True)
    set_cell_text(t.rows[i].cells[1], b)
    set_cell_text(t.rows[i].cells[2], c)
    status_cell(t.rows[i].cells[3], d)

doc.add_paragraph()
h('3. Verification Results Summary', 1)

t = data_table(12, 4)
header_row(t, ['Suite', 'Focus', 'Checks', 'Result'])
rows = [
    ('web-qr13-verify.js', 'WEB 1.1–1.3 QR linking (static + dynamic)', '20', 'VERIFIED'),
    ('web-web14-verify.js', 'WEB 1.4 offline survival + outbox contract', '30', 'VERIFIED'),
    ('web-web14-live.js', 'WEB 1.4 real live sockets', '22', 'VERIFIED'),
    ('web-web15-verify.js', 'WEB 1.5 invisible reconnect sync', '32', 'VERIFIED'),
    ('web-web16-verify.js', 'WEB 1.6 + 1.7 logoff / tab-close', '31', 'VERIFIED'),
    ('web-web17-verify.js', 'WEB 1.8 new-phone force-logout', '29', 'VERIFIED'),
    ('web-e2e.js', 'WEB 1.9 end-to-end funnel (replacement)', '19', 'VERIFIED'),
    ('web-21-verify.js', 'WEB 2.1 Phase-5 design contract', '33', 'VERIFIED'),
    ('web-22-verify.js', 'WEB 2.2 message-sending parity', '61', 'VERIFIED'),
    ('web-23-verify.js', 'WEB 2.3 read receipts + typing + search', '89', 'VERIFIED'),
]
total = 0
for i, (a, b, c, d) in enumerate(rows, start=1):
    set_cell_text(t.rows[i].cells[0], a)
    set_cell_text(t.rows[i].cells[1], b)
    set_cell_text(t.rows[i].cells[2], c, align=WD_ALIGN_PARAGRAPH.CENTER)
    status_cell(t.rows[i].cells[3], d)
    total += int(c)
set_cell_text(t.rows[11].cells[0], 'Total', bold=True)
set_cell_text(t.rows[11].cells[1], '')
set_cell_text(t.rows[11].cells[2], str(total), bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)
set_cell_text(t.rows[11].cells[3], '366/366 PASS', bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)

doc.add_paragraph()
kv('Gate checks: ', 'pnpm lint (source-lint offline gate, 35 files / 20 client) — clean;  pnpm typecheck '
   '(tsc --noEmit) — clean;  pnpm build (next build) — compiled + static pages generated.')
kv('Cumulative pass history: ', 'WEB 1.1–1.9: 183/183  →  +WEB 2.1: 216/216  →  +WEB 2.2: 277/277  →  '
   '+WEB 2.3: 366/366.')
kv('Web 1.1-1.9 totals: ', 'qr13(20) + web14(30) + web14-live(22) + web15(32) + web16(31) + web17(29) + e2e(19) '
   '= 183 checks.')

doc.add_paragraph()
h('4. Coverage Detail', 1)

h('4.1 WEB 1.1–1.9 baseline', 2)
bullet('QR mint with strict 60s TTL, one live QR, token regeneration that never reuses a minted token; live '
       'countdown pill; accountLinked / qrExpired over a dedicated qrSession socket.')
bullet('Only a hard 401 logs the Web out; sends are phone-independent via POST /api/messages/send with a '
       'localStorage outbox (wpt_web_outbox_v1, UMD module); optimistic sends finalize to the server id.')
bullet('Reconnect sync is fully background: flushOutbox + loadRecentChats on socket-open; no syncChip / pending-send UI; single-flight refetch prevents reconnect bursts.')
bullet('Logoff is the ONLY logout (server revoke + fresh QR); clearWebSession() has exactly 2 call sites.')
bullet('Tab close never ends the session: session/app-state/outbox in localStorage, no beforeunload/pagehide/unload handlers, no server-side TTL on web sessions.')
bullet('New-phone login synchronously clears the registry and broadcasts webForceLoggedOut{reason} to live '
       'sockets with a reason-aware rescan notice and no grace window.')
bullet('Legacy apps/web/qr-login retired after its replacement (@wpt/web, node:http + ws, No Express/Socket.io) '
       'passed the full migrated harness corpus.')

h('4.2 WEB 2.1 — Phase-5 design (logic untouched)', 2)
bullet('Token-based design system (Space Grotesk / Inter / IBM Plex Mono, phase theme); room/thread/panel '
       'restyle to the Sealine Web Phase-5 prototype.')
bullet('QR gate + linking transition restyled; chat surface rebuilt (sender labels, sent/delivered/failed/read '
       'status ticks, new-chat / group-info / settings / blocked-contacts panels, FAB).')
bullet('Data plumbing intact: only loadServerGroups() added to the orchestrator; session/socket/outbox '
       'invariants re-asserted by the harness (33 checks).')

h('4.3 WEB 2.2 — Message-sending parity (text / image / voice)', 2)
bullet('One shared source of truth: packages/shared/src/messages.ts (kinds, 100 MiB cap, 4000-char text max, '
       '1s voice minimum, mime rules, error copy).')
bullet('Transport via packages/api-client plain-fetch relay (no socket.io, no /api/v1 coupling) — BE-5.4 swap '
       'is a one-line base-URL change.')
bullet('Server sends + GET /api/media/:id byte-exact round-trips; rejections: 413 attachment_too_large / 400 '
       'bad_kind / 400 bad_mime / 400 voice_too_short / 400 bad_size / 413 payload_too_large.')
bullet('Client: attach 📎 (image) and press-and-hold 🎤 recorder; media payloads in-memory only, never persisted '
       'to localStorage.')

h('4.4 WEB 2.3 — Read receipts + typing indicators + in-thread search', 2)
bullet('Four-state machine (sent → delivered → read, terminal failed) — pure app/lib/receipts.ts; never '
       'downgrades, failed never resurrects.')
bullet('REST-only side channels: POST /api/messages/read (read-through + {type:"read", messageIds} broadcast) '
       'and POST /api/messages/typing (on/off + server TTL auto-clear, default 5000ms).')
bullet('Typing is per chat-pair (direct to:from / group groupId:from); client display ceiling 2500ms; live '
       'typing row with .typing-dot only for the active chat.')
bullet('In-thread search via pure app/lib/search.ts — case-insensitive, regex-metacharacter escaping verified '
       'over a 57-message live thread ("alpha" = exact seeded count; "R&D(alpha)?" / "a.b" matched literally).')
bullet('Rejection matrix in force: 404 read_not_found / 400 bad_read / 400 bad_typing; relayed send refusal '
       'maps to terminal failed.')

doc.add_paragraph()
h('5. Key Findings & Challenges', 1)
bullet('Stale requirement path (apps/web/qr-login): the template pointed at the Next.js app that had no session '
        'logic; the standing scope decision was recorded and the legacy client later replaced in full.',
        'Finding 1 — ')
bullet('Offline-send correctness required a backend-relay send path + localStorage outbox so Web sends survive '
        'the phone being offline.', 'Finding 2 — ')
bullet('Sync UI leak (#syncChip) was locked out by the Phase-5 decision — reconnect sync must be invisible; '
        'the harness bans the tokens.', 'Finding 3 — ')
bullet('The restyle had to avoid "loading|spinner|toast|snackbar" in the client files; media bubbles used '
        'loading="lazy" which was removed.', 'Finding 4 — ')
bullet('mKind (not "kind") carries message kind on the wire because "kind" was already the conversation type '
        '(direct/group) — a collision that would have broken every legacy assertion.', 'Finding 5 — ')
bullet('A harness event-buffer gotcha (waitEvent re-consuming a stale typing:false) was caught by an '
        'elapsed-TTL assertion; buffers are drained between scenarios.', 'Finding 6 — ')

doc.add_paragraph()
h('6. Learnings', 1)
h('6.1 Technical', 2)
bullet('Pure, erasable-only TS modules (+ @wpt/shared) let Node harnesses import the exact shipped source with '
        'type-stripping — no bundler, no tsx, no socket.io in tests.')
bullet('Additive wire evolution (extra fields/routes, unchanged text-send shape) keeps the entire legacy '
        'harness corpus green while new features layer on.')
bullet('Server-guaranteed TTL + client display ceiling is the right split for any presence feature.')
bullet('A single pnpm verify gate spanning every requirement is durable regression insurance (10 suites, one '
        'command).')
h('6.2 Process', 2)
bullet('Verify every requirement with an executable harness BEFORE deleting the legacy app; the retirement '
        'landed with zero regressions.')
bullet('Static source-lint gates (ban sync UI tokens, console.log, loading=, sessionStorage, legacy paths) '
        'encode the hygiene contract as checks, not as manual discipline.')
bullet('Document swap paths (BE-5.4, BE-5.5) and pending manual device retests in the README/reports so the '
        'next session can pick them up cleanly.')

doc.add_paragraph()
h('7. Pending / Outstanding', 1)
bullet('Manual device VERIFY: link the Web on a real phone + desktop, confirm rescan end-state after a '
        'new-phone login, and confirm image/voice receipts and the terminal "read" tick on a physical device '
        '(no device available in this environment).', 'Pending: ')
bullet('Backend integration: repoint /api/media/:id and the read/typing POSTs at the BE-5.4 / BE-5.5 backend '
        'relay when those endpoints land; wire shape and client helpers are already swap-ready.', 'Pending: ')
bullet('Re-run pnpm --filter @wpt/web run verify (currently 366/366) after the device retest.', 'Pending: ')

doc.add_paragraph()
p = doc.add_paragraph()
r = p.add_run('Generated: ')
r.bold = True
r.font.size = Pt(10)
p2 = p.add_run('24 September 2026')
p2.font.size = Pt(10)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   'WEB_1.1_2.3_Consolidated_Test_Report.docx')
doc.save(out)
print('Saved:', out)