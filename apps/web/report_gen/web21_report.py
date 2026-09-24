"""Generate the Satheesh Kumar WEB 2.1 (Sealine Phase-5 design restyle) report DOCX."""
import os
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import nsdecls
from docx.oxml import parse_xml

DARK = '1A1A2E'
TEAL = '3FC6B8'

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
rsub = sub.add_run('WPT Web App — WEB 2.1 Sealine Phase-5 Design Restyle  |  Satheesh Kumar  |  Team Alpha')
rsub.font.size = Pt(12)
rsub.font.color.rgb = RGBColor(0x3F, 0x3F, 0x3F)
doc.add_paragraph()

h('1. Sprint Overview', 1)
kv('Sprint period: ', '22 September 2026 – 24 September 2026')
kv('Role / focus: ', 'Front-end restyle of the WPT Web client to match the Sealine Web Phase-5 design prototype, '
   'while preserving every verified WEB-R1.1–1.8 behaviour (session, socket, outbox, logout).')
kv('Requirement source: ', 'Sealine — Web (Design Prototype, Phase 5) HTML pasted by the user (the shared '
   'Drive folder is not publicly readable).')
kv('Approach confirmed by user: ', '"Style existing app, keep logic" — replace presentation only; no session/socket/outbox changes.')

doc.add_paragraph()
h('2. Task Analysis (WEB 2.1)', 1)

h('2.1 Design system + theme', 2)
body('globs.css was rewritten as a token-based Phase-5 design system: Space Grotesk / Inter / IBM Plex Mono '
     '(wired in app/layout.tsx via Google Fonts), a teal Sealine palette (#0f9c90 family), radii 8/14/20/28, '
     'shadows and dark + light variable sets. Theme is applied through app/lib/theme.ts as body[data-theme] with '
     'light / dark / system modes persisted to a new localStorage key wpt_web_theme_v1; system follows '
     'prefers-color-scheme. Dark stays the canonical palette with light overrides, so no runtime re-theme is '
     'ever forced on a user.')
bullet('Tokened palettes, both themes, persisted theme choice — no sessionStorage, no console.log.', 'Cleanup: ')

h('2.2 QR gate + linking transition', 2)
body('The gate was restyled to the prototype: Sealine seal + "Sealine Web" wordmark, a conic-gradient countdown '
     'ring driven by --pct around the code, "Code expired / Generating a new one…" overlay on regen, the three '
     'linking steps, "Web only works alongside the phone app" note and Terms/Privacy/Help footer. A brief '
     'app/wpt/linking-screen.tsx ("Linking your device… Generating a fresh encryption identity") transitions into '
     'the chat. The force-logout "session ended — scan the QR below to reconnect" notice copy is byte-identical '
     '(web-e2e asserts it). The manual logoff now surfaces a "Logged off this browser" pill.')
bullet('Required copy kept verbatim; countdown pill + expiring state preserved under 10s.', 'Contract: ')

h('2.3 Chat surface (sidebar + thread + panels)', 2)
body('app/wpt/chat-app.tsx was rebuilt to the prototype: Space-Grotesk sidebar (seal brand, ✎ New chat + ⚙ '
     'Settings buttons, chat search, presence dot, mono timestamps, unread badges, selected accent bar, FAB), '
     'reconnecting banner driven by socketOk, date dividers ("Today / Yesterday…"), sender labels in groups, '
     'sent / delivered / read / failed status ticks on outbound bubbles (WebChatMessage.status — tmp→sent, '
     'server echo→delivered, outbox rejection→failed), in-chat search (highlighted <mark>, "N of N", prev/next '
     'with scroll-into-view), a composer with attach / voice-note affordances and a "stamp" send animation, and '
     'the Phase-5 empty E2E state.')
body('Panels (right-hand drawers): New chat ("On Sealine" people list + "not on Sealine yet" no-match block; '
     'contacts mirror the phone sync and Web requests no Contacts permission), Group info (OWNER/ADMIN role '
     'pills, member count, "who can send messages" from /api/groups settings, owner-protection note), Settings '
     '(read-only phone, theme light/dark/system, this device + linked date, Blocked contacts, About, "Log off '
     'this device"), and a blocked-contacts panel. Log-off stays confirm-gated and remains the only logout path '
     '(POST /api/session/logout + fresh QR).')

h('2.4 Data plumbing stays intact', 2)
body('web-app.tsx gained only loadServerGroups() (/api/groups → ServerGroup), the linking phase, the logoff '
     'flash and message-status lifecycle; all invariants the earlier harnesses lock were preserved: exactly 2 '
     'clearWebSession() call sites, handleLinked→showForceLogoutNotice(null), handleWSOpen→flushOutbox→'
     'loadRecentChats, "if (document.hidden) return", no sync tokens, no loading/spinner/toast/snackbar strings '
     'in the session-path files, no console.log.')

doc.add_paragraph()
h('3. Verification Results Summary', 1)

t = data_table(9, 4)
header_row(t, ['Suite', 'Focus', 'Checks', 'Result'])
rows = [
    ('web-qr13-verify.js', 'QR linking (existing)', '20', 'VERIFIED'),
    ('web-web14-verify.js', 'Offline survival (existing)', '30', 'VERIFIED'),
    ('web-web14-live.js', 'Live sockets (existing)', '22', 'VERIFIED'),
    ('web-web15-verify.js', 'Invisible sync (existing)', '32', 'VERIFIED'),
    ('web-web16-verify.js', 'Logoff + tab close (existing)', '31', 'VERIFIED'),
    ('web-web17-verify.js', 'New-phone kick (existing)', '29', 'VERIFIED'),
    ('web-e2e.js', 'End-to-end funnel (existing)', '19', 'VERIFIED'),
    ('web-21-verify.js', 'Phase-5 design contract (NEW)', '33', 'VERIFIED'),
]
total = 0
for i, (a, b, c, d) in enumerate(rows, start=1):
    set_cell_text(t.rows[i].cells[0], a)
    set_cell_text(t.rows[i].cells[1], b)
    set_cell_text(t.rows[i].cells[2], c, align=WD_ALIGN_PARAGRAPH.CENTER)
    status_cell(t.rows[i].cells[3], d)
    total += int(c)
set_cell_text(t.rows[8].cells[0], 'Total', bold=True)
set_cell_text(t.rows[8].cells[1], '')
set_cell_text(t.rows[8].cells[2], str(total), bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)
set_cell_text(t.rows[8].cells[3], '216/216 PASS', bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)

doc.add_paragraph()
kv('Gate checks: ', 'pnpm lint (source-lint offline gate) — clean;  pnpm typecheck (tsc --noEmit) — clean;  '
   'pnpm build (next build) — compiled + static pages generated.')
kv('Overall verdict: ', '216/216 checks pass across all eight suites. The restyle is machine-verified against '
   'the Phase-5 contract AND against every WEB-R1 regression — same verify command covers all of it.')

doc.add_paragraph()
h('4. Key Findings & Challenges', 1)
bullet('The prototype is a locked design: reconnect sync stays invisible (WEB-R1.5). The restyle therefore ships '
       'no sync UI and keeps the reconnecting banner as a connection-state affordance only.', 'Finding 1 — ')
bullet('Harness token traps are strict: web-web15-verify.js bans "loading|spinner|toast|snackbar" inside '
       'chat-app.tsx / web-app.tsx / ws.ts. The toast ("Logged off this browser") had to live in qr-gate.tsx and '
       'the linking spin in a separate component — presentation was structured around the regression contract.', 'Finding 2 — ')
bullet('Status ticks needed a message-lifecycle extension: WebChatMessage.status with tmp→sent, server echo→'
       'delivered, outbox failure→failed — a visual upgrade with zero protocol change (persisted app-state shape '
       'stays backward compatible).', 'Finding 3 — ')
bullet('/api/groups already returned members + settings, so Group Info needed only a client type + one fetch '
       '(loadServerGroups with a re-render bump) — no server change.', 'Finding 4 — ')
bullet('Light theme is a full second palette (not a backdrop filter trick): both palettes derived from shared '
       'tokens so future components stay theme-safe.', 'Finding 5 — ')

doc.add_paragraph()
h('5. Learnings', 1)
h('5.1 Technical', 2)
bullet('Design tokens as CSS custom properties + body[data-theme] gives an app-wide theme switch in one line '
       'and keeps components palette-agnostic.')
bullet('Regression harnesses double as architecture guard-rails: reading them first told us exactly where the '
       'new UI could and could not go (tokens, call sites, copy).')
bullet('A persisted, additive status field on existing persisted state scaled the UI without data migration — '
       'old snapshots simply render their messages as "delivered".')
bullet('Staging visual work in isolated components (seal, linking-screen, toast-in-gate) kept the orchestrator '
       'small and the strict token checks green.')
h('5.2 Process', 2)
bullet('Restyling "an app, keep logic" is safest when the presentation contract is made explicit first — the '
       'Phase-5 HTML was turned into a checklist and a static harness (web-21-verify.js) so nothing silently '
       'drifts from the prototype.')
bullet('The single pnpm verify gate now runs old + new suites together: a restyle that breaks a prior '
       'requirement fails the build, not a later review.')
bullet('Brand rename (WPT → Sealine) was swept in render-only strings; storage keys and API paths stay '
       'unchanged, so sessions and outbox survive the redesign untouched.')

doc.add_paragraph()
h('6. Next Steps / Pending Items', 1)
bullet('Manual visual pass on device (Chrome + Edge + mobile widths) to eyeball typography, ring animation and '
       'light-theme contrast beyond the machine contract.', 'Pending: ')
bullet('Optionally hydrate admin/ pages and the legacy docs with the new design tokens.', 'Pending: ')
bullet('Sync the report DOCX and README notes with the repo narrative (AGENTS.md) once returned to origin.', 'Pending: ')

doc.add_paragraph()
p = doc.add_paragraph()
r = p.add_run('Generated: ')
r.bold = True
r.font.size = Pt(10)
p2 = p.add_run('24 September 2026')
p2.font.size = Pt(10)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   'WEB_2.1_Sealine_Phase5_Restyle_Report.docx')
doc.save(out)
print('Saved:', out)