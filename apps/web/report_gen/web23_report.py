"""Generate the Satheesh Kumar WEB 2.3 (Read Receipts + Typing Indicators + In-thread Search) report DOCX."""
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


def status_cell(cell, status):
    colors = {
        'PASS': ('2E7D32', 'E8F5E9'),
        'VERIFIED': ('2E7D32', 'E8F5E9'),
        'COMPLETED': ('1565C0', 'E3F2FD'),
        'REQUIRES DEVICE TEST': ('8A6D00', 'FFF8E1'),
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
run = title.add_run('Task Analysis & Learning Report')
run.bold = True
run.font.size = Pt(20)
run.font.name = 'Calibri'
run.font.color.rgb = RGBColor(0x1A, 0x1A, 0x2E)
sub = doc.add_paragraph()
sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
rsub = sub.add_run('WPT Web App — WEB 2.3 Read Receipts + Typing Indicators + In-thread Search  |  Satheesh Kumar  |  Team Alpha')
rsub.font.size = Pt(12)
rsub.font.color.rgb = RGBColor(0x3F, 0x3F, 0x3F)
doc.add_paragraph()

h('1. Sprint Overview', 1)
kv('Sprint period: ', '24 September 2026')
kv('Role / focus: ', 'Deliver mobile-parity delivery semantics on the Sealine Web client over the real live relay: '
   'four-state message status (sent -> delivered -> read, plus terminal failed), live typing indicators with '
   'server-side TTL auto-clear, and in-chat search across a 50+ message thread.')
kv('Requirement source: ', 'WEB 2.3 stretch goal "Read Receipts + Typing Indicators + In-thread Search".')
kv('Approach confirmed by user: ', 'REST-only writes over the live wpt-server.mjs pipeline (the client socket stays '
   'receive-only), additive wire shapes so the legacy text-send contract never changes, one shared source of truth '
   'in @wpt/shared for timing/routes, and pure erasable-TS modules for the status machine and search core that Node '
   'harnesses import directly.')

doc.add_paragraph()
h('2. Task Analysis (WEB 2.3)', 1)

h('2.1 Four-state status machine (app/lib/receipts.ts)', 2)
body('A pure, dependency-free machine with exactly the mobile statuses ("sent" | "delivered" | "failed" | "read") and '
     'events ("echo" | "read" | "rejected"). nextMessageStatus never downgrades and treats "failed" as terminal — '
     'echo/read cannot resurrect it. applyReadReceipt elevates only the reader\'s own outbound messages in a history '
     'slice (a broadcast echoed back to the reader never touches their incoming messages); buildReadRequest shapes '
     'the wire body for direct ("to") vs group ("groupId"); lastPeerMessage is the read-through point reported when '
     'a chat opens. Erasable-only syntax — Node type-stripping imports it with no build step.')

h('2.2 Shared canonical timing (@wpt/shared)', 2)
body('packages/shared/src/realtime.ts is the single source of truth for the side channels: typing TTL default 5000ms '
     '(server override via TYPING_TTL_MS env), the client display safety ceiling of 2500ms, and the REST routes '
     'READ_ROUTE="/api/messages/read" and TYPING_ROUTE="/api/messages/typing". The server re-pins the same values '
     '(no drift); the harness proves the default and the env override independently.')

h('2.3 Server (live relay, REST-only side channels)', 2)
body('wpt-server.mjs adds two additive POST handlers. /api/messages/read reads-through from the reported messageId '
     'and resolves every peer message up to that point (direct: rows authored by the peer; group: every other '
     'member\'s rows), then broadcasts {type:"read", from, to|groupId, messageId, messageIds, at} to the senders\' '
     'live user rooms (direct + group alike). /api/messages/typing broadcasts {type:"typing", ..., kind} on/off and '
     'arms a per-pair TTL timer (keyed by "to:from" for direct, "groupId:from" for group) that auto-clears a quiet '
     'typist — a typist who stops without sending is cleaned by the server, not the client. Rejections stay '
     'structured: 404 read_not_found, 400 bad_read, 400 bad_typing; the text-send relay contract is byte-untouched.')

h('2.4 Client (orchestrator + surface)', 2)
body('web-app.tsx tracks peerTyping per chat, reports read-through via lastPeerMessage when a chat opens and '
     'read-receipts the instant an inbound message arrives while the chat is open, elevates outbound messages '
     'through the shared machine on echo/read/rejected, and posts both side channels via plain REST (no ws writes). '
     'chat-app.tsx renders a live typing row (.typing-dot) above the composer when peerTyping[activeChat.id], '
     'announces the local draft on a 2s heartbeat and stops instantly on send or chat switch, ignores a peer\'s '
     'typing that targets the local context, and runs the shared search core over the loaded history with '
     'highlight + prev/next stepping. No spinner/banner/toast sync UI.')

h('2.5 In-thread search core (app/lib/search.ts)', 2)
body('A pure erasable-TS search core: escapeRegExp + buildSearchPattern produce a case-insensitive capture-group '
     'pattern, chooseMatchIndexes finds every match in a history window, splitHighlight renders the matched '
     'fragments and stepMatchIndex wraps prev/next navigation. Regex metacharacters are matched literally — '
     'queries like "R&D(alpha)?" or "a.b" are escaped so they never behave as patterns (the "." never wildcards '
     'axb/aXb). The chat surface no longer hand-rolls regex escaping; one source of truth.')

doc.add_paragraph()
h('3. Verification Results Summary', 1)

t = data_table(11, 4)
header_row(t, ['Suite', 'Focus', 'Checks', 'Result'])
rows = [
    ('web-qr13-verify.js', 'QR linking (existing)', '20', 'VERIFIED'),
    ('web-web14-verify.js', 'Offline survival (existing)', '30', 'VERIFIED'),
    ('web-web14-live.js', 'Live sockets (existing)', '22', 'VERIFIED'),
    ('web-web15-verify.js', 'Invisible sync (existing)', '32', 'VERIFIED'),
    ('web-web16-verify.js', 'Logoff + tab close (existing)', '31', 'VERIFIED'),
    ('web-web17-verify.js', 'New-phone kick (existing)', '29', 'VERIFIED'),
    ('web-e2e.js', 'End-to-end funnel (existing)', '19', 'VERIFIED'),
    ('web-21-verify.js', 'Phase-5 design contract (existing)', '33', 'VERIFIED'),
    ('web-22-verify.js', 'Message Sending Parity (existing)', '61', 'VERIFIED'),
    ('web-23-verify.js', 'Read Receipts + Typing + Search (NEW)', '89', 'VERIFIED'),
]
total = 0
for i, (a, b, c, d) in enumerate(rows, start=1):
    set_cell_text(t.rows[i].cells[0], a)
    set_cell_text(t.rows[i].cells[1], b)
    set_cell_text(t.rows[i].cells[2], c, align=WD_ALIGN_PARAGRAPH.CENTER)
    status_cell(t.rows[i].cells[3], d)
    total += int(c)
set_cell_text(t.rows[10].cells[0], 'Total', bold=True)
set_cell_text(t.rows[10].cells[1], '')
set_cell_text(t.rows[10].cells[2], str(total), bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)
set_cell_text(t.rows[10].cells[3], '366/366 PASS', bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)

doc.add_paragraph()
kv('Gate checks: ', 'pnpm lint (source-lint offline gate) — clean;  pnpm typecheck (tsc --noEmit) — clean;  '
   'pnpm build (next build) — compiled + static pages generated.')
kv('Overall verdict: ', '366/366 checks pass across all ten suites. web-23-verify.js imports realtime.ts + '
   'receipts.ts + search.ts as real TS (Node type-stripping) and exercises the LIVE relay end-to-end '
   '(TTL overridden to 400ms on the harness\'s own port).')
kv('web-23 dynamic coverage: ', 'live read receipt drives a real sent -> delivered -> read transition (direct + '
   'group); every rejection returns the structured error; explicit typing:false clears immediately; a quiet '
   'typist is auto-cleared by the server TTL with no further events; a 57-message thread is searched with escaped '
   'metacharacters ("alpha" = exactly 7 seeded rows, "R&D(alpha)?" = 1 literal row, "a.b" ignores axb/aXb); a '
   'relayed rejection maps to terminal failed; the 50+ message contract holds against real relay history.')

doc.add_paragraph()
h('4. Key Findings & Challenges', 1)
bullet('The two side channels are additive, so the text-send relay shape ({id, from, text, time}) is untouched and '
       'the entire legacy harness corpus (web-13..22) stayed green while the new feature layered on.', 'Finding 1 — ')
bullet('Read-receipt broadcasts are intentionally symmetric with typing: resolved ids (messageIds) reach every '
       'sender\'s live socket, and the resolver only ever elevates messages the reader authored — a broadcast that '
       'echoes back to the reader cannot touch their own inbound rows.', 'Finding 2 — ')
bullet('Typing state is keyed per chat-pair (direct "to:from", group "groupId:from") so two users typing to each '
       'other are fully independent, and group typing never leaks into a direct chat.', 'Finding 3 — ')
bullet('The TTL is a server guarantee: the auto-clear fires even if the peer never posts typing:false. The harness '
       'proves it with a 400ms override (event arrives at/after the TTL, and no event arrives afterwards) rather '
       'than assuming the client cleans up.', 'Finding 4 — ')
bullet('waitEvent scans the already-received event buffer, so a repeated predicate can re-consume a stale event; '
       'the harness drains the buffer between typing scenarios so the auto-clear assertion measures real latency, '
       'not a leftover broadcast.', 'Finding 5 — ')
bullet('Escaping is exercised against LIVE relay history with ambiguous text ("R&D(alpha)? !", "cost a.b then '
       'axb aXb") proving the "." and "?" are matched literally and the case-insensitive alpha count is the exact '
       'N-of-N, matching the pure fixture.', 'Finding 6 — ')

doc.add_paragraph()
h('5. Learnings', 1)
h('5.1 Technical', 2)
bullet('Pure, erasable-only modules (machine + search) let the harness import the exact client source with plain '
        'Node type-stripping — no tsx, no bundling — so the tests run the same code the browser ships.')
bullet('The client socket stays receive-only; every write is a REST POST on a stable route. That keeps the '
        'real-time side channels trivially testable and, later, swappable one route at a time to the backend.')
bullet('TTL + display-ceiling split (server guarantees; client never outlives a dead typist) is the pattern to '
        'reuse for any presence feature.')
bullet('A single shared search module replaces hand-rolled regex escaping in the UI and makes the escaping rule '
        '(metadata -, literal match) enforceable in a harness.')
h('5.2 Process', 2)
bullet('The whole chain re-ran green in one command after the feature landed (366 checks); the static sections '
        'guard the client/server wiring, the dynamic sections drive the real relay.')
bullet('Both new wire bodies are additive and documented in the README with the BE-5.5 swap path, so the backend '
        'can adopt them without a protocol break.')
bullet('One harness bug — re-consuming a buffered event — was caught by the elapsed-TTL assertion; the lesson is '
        'to drain event buffers whenever a predicate could match an earlier scenario.')

doc.add_paragraph()
h('6. Next Steps / Pending Items', 1)
bullet('Confirm a message sent from the Web reaches "read" on a physical mobile device (no device available now).',
       'Pending: ')
bullet('Implement the backend BE-5.5 read-receipt + typing endpoints and repoint the two REST routes when they '
       'land.', 'Pending: ')
bullet('Re-run pnpm verify + the manual browser flow on the final build (366/366 currently green).', 'Pending: ')

doc.add_paragraph()
p = doc.add_paragraph()
r = p.add_run('Generated: ')
r.bold = True
r.font.size = Pt(10)
p2 = p.add_run('24 September 2026')
p2.font.size = Pt(10)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   'WEB_2.3_Read_Receipts_Typing_Search_Report.docx')
doc.save(out)
print('Saved:', out)