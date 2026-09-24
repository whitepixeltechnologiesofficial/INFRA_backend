"""Generate the Satheesh Kumar WEB 2.2 (Message Sending Parity) report DOCX."""
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
rsub = sub.add_run('WPT Web App — WEB 2.2 Message Sending Parity (text / image / voice)  |  Satheesh Kumar  |  Team Alpha')
rsub.font.size = Pt(12)
rsub.font.color.rgb = RGBColor(0x3F, 0x3F, 0x3F)
doc.add_paragraph()

h('1. Sprint Overview', 1)
kv('Sprint period: ', '24 September 2026')
kv('Role / focus: ', 'Extend the Sealine Web client so it can send (and receive) the same message kinds as the '
   'mobile app — text, image, voice — over the real live relay server, with one shared cap and clear errors.')
kv('Requirement source: ', 'WEB 2.2 stretch goal "Message Sending Parity" (mobile parity; no video/file on Web).')
kv('Approach confirmed by user: ', 'definition of the one size limit (100 MiB single cap for image + voice) and a '
   'source of truth in @wpt/shared; extend the live wpt-server.mjs pipeline, keep text sends byte-identical to '
   'the legacy relay contract, and make the send path swap-ready for the backend BE-5.4 relay.')

doc.add_paragraph()
h('2. Task Analysis (WEB 2.2)', 1)

h('2.1 One shared source of truth', 2)
body('packages/shared/src/messages.ts is NEW and canonical: the exact kind set ("text" | "image" | "voice"), the '
     'single 100 MiB cap MAX_ATTACHMENT_BYTES (matches mobile), the 1-second voice minimum, the 4000-char text max, '
     'mime rules, validateAttachment, formatBytes / ATTACHMENT_LIMIT_LABEL ("100 MB") and mediaPreviewText for '
     'recent-chat previews. The server re-pins the same constants (no drift). The over-limit copy is human first: '
     '"Attachment is too large — Sealine accepts up to 100 MB."')

h('2.2 Transport helpers (@wpt/api-client)', 2)
body('packages/api-client/src/messages.ts is a self-contained plain-fetch relay: buildRelaySendBody (kind-aware, '
     'omitted kind → text, videos never built) and sendRelayMessage against /api/messages/send. No socket.io, no '
     '/api/v1 coupling — the swap to the backend BE-5.4 relay is a one-line base-URL change. Text bodies keep the '
     'exact legacy shape {id, from, text, time}.')

h('2.3 Server (live relay, not a mock)', 2)
body('wpt-server.mjs accepts optional kind / dataUrl / mimeType / sizeBytes / durationSec on /api/messages/send. '
     'Media messages carry mKind/attachmentId/mimeType/sizeBytes (+durationSec for voice); bytes live in an '
     'in-memory Map and are served back at GET /api/media/:id with Content-Type + Content-Length (no-store). '
     'Rejections: 413 attachment_too_large over the shared cap, 400 bad_kind for explicit unknown kinds (e.g. '
     'video), 400 bad_mime, 400 voice_too_short (<1s), 400 bad_size for a declared size that does not match the '
     'payload, plus a readBody size guard returning 413 payload_too_large. Recent-chats previews use the shared '
     'mediaPreviewText ("Image" / "Voice message"). Broadcasts keep the conversation kind field ("direct"/"group") '
     'while adding mKind — so every existing assertion stays valid.')

h('2.4 Client', 2)
body('app/lib/messages.ts bridges @wpt/shared (compose-time validation + mediaUrl). chat-app.tsx gained an enabled '
     '📎 attach button (hidden <input type="file" accept="image/*">) and a press-and-hold 🎤 voice recorder '
     '(MediaRecorder + getUserMedia, pointer capture, live timer, cancel/send, too-short takes discarded, '
     'mic-denied copy). Image/voice bubbles render via /api/media/:id; a pending bubble covers the '
     'server-address-unknown/offline case and rides the existing offline outbox. Media payloads (dataUrl) are '
     'in-memory only (mediaPayloadRef) — never persisted to localStorage. The orchestrator (web-app.tsx) maps '
     'mKind/attachmentId/mimeType/sizeBytes/durationSec on incoming, history and echo finalize, and previews '
     'recent chats with the shared copy.')

doc.add_paragraph()
h('3. Verification Results Summary', 1)

t = data_table(10, 4)
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
    ('web-22-verify.js', 'Message Sending Parity (NEW)', '61', 'VERIFIED'),
]
total = 0
for i, (a, b, c, d) in enumerate(rows, start=1):
    set_cell_text(t.rows[i].cells[0], a)
    set_cell_text(t.rows[i].cells[1], b)
    set_cell_text(t.rows[i].cells[2], c, align=WD_ALIGN_PARAGRAPH.CENTER)
    status_cell(t.rows[i].cells[3], d)
    total += int(c)
set_cell_text(t.rows[9].cells[0], 'Total', bold=True)
set_cell_text(t.rows[9].cells[1], '')
set_cell_text(t.rows[9].cells[2], str(total), bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)
set_cell_text(t.rows[9].cells[3], '277/277 PASS', bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)

doc.add_paragraph()
kv('Gate checks: ', 'pnpm lint (source-lint offline gate) — clean;  pnpm typecheck (tsc --noEmit, web + '
   '@wpt/shared + @wpt/api-client) — clean;  pnpm build (next build) — compiled + static pages generated '
   '(webpack extensionAlias ".js"→".ts" added for the shared package re-exports).')
kv('Overall verdict: ', '277/277 checks pass across all nine suites. web-22-verify.js runs the shared + api-client '
   'modules as real TS (Node type-stripping) and exercises the LIVE relay end-to-end.')
kv('web-22 dynamic coverage: ', 'text send keeps the legacy shape in history; voice + image accepted, stored, '
   'served back byte-exact at /api/media/:id, delivered LIVE over the WebSocket to the recipient, and previewed '
   'in recent-chats; explicit "video" kind, sub-1s voice, wrong mime and size-mismatch are all rejected; the '
   '100 MiB cap returns 413 with the shared copy.')

doc.add_paragraph()
h('4. Key Findings & Challenges', 1)
bullet('mKind (not "kind") carries the message kind on the wire because "kind" was already taken by the '
       'conversation type ("direct"/"group") in broadcasts — a collision that would have silently broken every '
       'existing assertion.', 'Finding 1 — ')
bullet('The web-21/web-15 harnesses ban "loading|spinner|toast|snackbar" inside chat-app/web-app/ws.ts. The media '
       'bubble used loading="lazy" on the image — removed; "Preparing…" and "Hold to record" copy were chosen '
       'around the guard instead of weakening it.', 'Finding 2 — ')
bullet('Order of rejections matters: the declared-size > cap check runs BEFORE the decoded-bytes-match check (and '
       'before any oversized read) so a huge claimed size is rejected instantly with a 413, and readBody has its '
       'own 150 MiB ceiling returning 413 payload_too_large.', 'Finding 3 — ')
bullet('Node 26 type-stripping made the harness dependency-light: web-22-verify.js imports the self-contained '
       'packages/shared + packages/api-client TS modules directly relative — no tsx, no bundling, no socket.io.',
       'Finding 4 — ')
bullet('Next webpack does not resolve Node-ESM ".js" specifiers to ".ts" sources inside transpiled packages; a '
       'resolve.extensionAlias ".js"→[".ts", ".js"] in next.config.js fixed it without touching the packages '
       '(tsc/Bundler, tsx and Node continue to use the same specifiers).', 'Finding 5 — ')
bullet('Media payloads never touch localStorage: the offline outbox persists metadata (kind/mime/size/duration) '
       'while the dataUrl stays in an in-memory Map, cleared on finalize/reset/failure — the persistence '
       'contract of web-web14/16 is unchanged.', 'Finding 6 — ')

doc.add_paragraph()
h('5. Learnings', 1)
h('5.1 Technical', 2)
bullet('A canonical shared module (kinds, cap, errors, validation) makes server and client parity contractually '
       'enforced — the harness imports the module itself, so the server can never drift from the advertised cap.')
bullet('Byte-exact /api/media round-trips (Content-Type + Content-Length + equality) prove the store is real, not '
       'a mock, and the 404-for-unknown-id check proves lookup discipline.')
bullet('Additive wire fields (mKind/attachmentId/…) keep legacy consumers and old harnesses green while new '
       'clients opt in — the safest evolution of a locked protocol.')
bullet('Web-only kinds are a first-class rejection surface: the server refuses explicit unknown kinds with '
       'bad_kind instead of silently downgrading them to text.')
h('5.2 Process', 2)
bullet('Verified the client UI against the real relay before wiring the client, then re-ran the whole chain — the '
       'single pnpm verify gate now covers 277 checks and the manual browser flow is the only remaining step.')
bullet('The BE-5.4 swap path is documented: the client helpers already speak the same body shape, so only the '
       'base URL / server handler must change; mobile-device receipt retest remains a pending manual item.')
bullet('Keeping text shots byte-identical protected the E2E + web-14 suites; parity was layered on without '
       'touching the legacy contract.')

doc.add_paragraph()
h('6. Next Steps / Pending Items', 1)
bullet('Confirm image + voice sent from the Web arrive on a physical mobile device (no device available now).',
       'Pending: ')
bullet('Implement the backend BE-5.4 relay path and repoint /api/media/:id at backend storage when the backend '
       'relay lands.', 'Pending: ')
bullet('Re-run pnpm verify + the manual browser flow on the final build (277/277 currently green).', 'Pending: ')

doc.add_paragraph()
p = doc.add_paragraph()
r = p.add_run('Generated: ')
r.bold = True
r.font.size = Pt(10)
p2 = p.add_run('24 September 2026')
p2.font.size = Pt(10)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   'WEB_2.2_Message_Send_Parity_Report.docx')
doc.save(out)
print('Saved:', out)