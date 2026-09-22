"""Generate Satheesh Kumar WEB 1.1-1.9 task analysis & learning report DOCX."""
import os
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import nsdecls
from docx.oxml import parse_xml

DARK = '1A1A2E'
TEAL = '3FC6B8'
LIGHT = 'E8EAF6'

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


def header_row(table, labels, font_size=10):
    for j, h in enumerate(labels):
        set_cell_shading(table.rows[0].cells[j], DARK)
        set_cell_text(table.rows[0].cells[j], h, bold=True, font_size=font_size,
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
rsub = sub.add_run('WPT Web App — WEB 1.1 to 1.9  |  Satheesh Kumar  |  Team Alpha')
rsub.font.size = Pt(12)
rsub.font.color.rgb = RGBColor(0x3F, 0x3F, 0x3F)
doc.add_paragraph()

h('1. Sprint Overview', 1)
kv('Sprint period: ', '15 September 2026 – 21 September 2026')
kv('Role / focus: ', 'Implementation + independent verification for the WPT Web client (WEB-R1.1–R1.9) on Team Alpha')
kv('Branch: ', 'team-alpha (web work landed as commit cace73c on 20 Sep; WEB-R1.4–R1.8 verification harnesses run clean)')

doc.add_paragraph()
h('2. Task Analysis (WEB 1.1 – 1.9)', 1)

h('2.1 WEB 1.1–1.3 — QR linking gate (Jakob UX)', 2)
body('Built the scan-to-link experience: server owns QR minting with a strict 60s TTL, one live QR at a time, '
     'token regeneration that never reuses a minted token, and the phone link page (/phone/link/:token). '
     'The Web gate (app/wpt/qr-gate.tsx) listens on a dedicated qrSession socket for accountLinked / qrExpired '
     'and mirrors the server TTL with a live countdown (expiring pill under 10s).')
bullet('QR-1.3/1.4 baseline: mint, expiry, regeneration, confirm, real-time accountLinked, post-link hardening.', 'Scope: ')
bullet('Verify: web-qr13-verify.js — 20/20 PASS', 'Verify: ')

h('2.2 WEB 1.4 — Web session survives phone going offline', 2)
body('Only a hard 401 logs the Web out; a connectivity blip or an offline phone never ends the session. '
     'Sends are backend-mediated through POST /api/messages/send (phone-independent relay), queued first in a '
     'localStorage offline outbox (wpt_web_outbox_v1) with a pure Node-testable UMD module '
     '(lib/wptOutbox.js: enqueue/dedupe/pending/failed/retry/markSent/count/clear). Optimistic sends render '
     'identically and are swapped for the server message id on delivery (finalizeEcho).')
bullet('Outbox contract + persistence round-trip; session valid before/while/after offline; relay send stored + previewed; ', 'Verify: ')
bullet('live wire-level socket test with a real WebSocket client.', 'Verify: ')
bullet('web-web14-verify.js — 30/30 PASS;  web-web14-live.js — 22/22 PASS (real sockets)', 'Verify: ')

h('2.3 WEB 1.5 — Invisible reconnect sync', 2)
body('Reconnect re-sync is 100% background: the socket-open handler does flushOutbox() + loadRecentChats() '
     'and nothing visible is ever rendered. Removed the early #syncChip pill and .pending-send dim that leaked '
     'a progress UI; large-backlog refetch is single-flight (inFlightRef guard) so reconnect bursts coalesce. '
     'Console is clean (no console.log).')
bullet('web-web15-verify.js — 32/32 PASS (static tokens absent + 3 dynamic offline/online cycles)', 'Verify: ')

h('2.4 WEB 1.6 — Manual logoff (distinct mechanism)', 2)
body('Settings → Logout is the ONLY explicit logout: it revokes server-side via POST /api/session/logout, '
     'clears the session, and returns to a fresh QR. clearWebSession() has exactly 2 call sites — manual logout '
     'and performSessionLogout() — so tab close and manual logoff can never be confused.')
bullet('Verified inside web-web16-verify.js (31 checks).', 'Verify: ')

h('2.5 WEB 1.7 — Tab-close persistence', 2)
body('Closing a browser tab never ends the session. Session (webToken + userId), chat state and the outbox all '
     'live in localStorage (wpt_web_session_v1 / wpt_web_app_state_v1 / wpt_web_outbox_v1), never sessionStorage. '
     'There are NO beforeunload/pagehide/unload handlers; boot restores the saved session and short-circuits the '
     'QR gate. Server webSessions registry has no TTL — an idle/closed-tab session is never expired server-side. '
     'Private/incognito browsers may clear storage by design (documented, accepted).')
bullet('web-web16-verify.js — 31/31 PASS', 'Verify: ')

h('2.6 WEB 1.8 — New-phone login force-logs the Web off', 2)
body('When the account owner logs into mobile on a new phone, every active Web session is terminated immediately '
     '— no advance warning, no grace period. Server invalidateWebForUser() clears the registry synchronously and '
     'broadcasts webForceLoggedOut {reason} to each live Web socket. The client shows a reason-aware "Your session '
     'ended — a new phone signed in… Scan the QR below to reconnect." notice, and the 401 validate fallback uses '
     'reason revoked.')
bullet('web-web17-verify.js — 29/29 PASS (live kick of real sockets, repeat kicks, re-link)', 'Verify: ')

h('2.7 WEB 1.9 — qr-login retirement & replacement', 2)
body('Completed the standing "works end to end" guardrail: built a fully functional replacement in @wpt/web '
     '(apps/web) — a standalone server on Node built-ins node:http + ws (no Express / Socket.io) plus a Next.js '
     'React client — verified it against the full migration of every harness, then deleted the legacy '
     'apps/web/qr-login folder and all its deps. The vendored QR encoder is genuinely reused in the replacement.')
bullet('Verification chain: qr13(20) + web14(30) + web14-live(22) + web15(32) + web16(31) + web17(29) + E2E(19) ', 'Verify: ')
bullet('web-e2e.js — 19/19 PASS (link → auth → chat → close/reopen → manual logout → new-phone kick → rescan → re-link)', 'E2E: ')
bullet('tsc --noEmit clean; next build clean; source-lint offline gate clean.', 'Added gates: ')

doc.add_paragraph()
h('3. Verification Results Summary', 1)

t = data_table(8, 4)
header_row(t, ['Suite', 'Requirement', 'Checks', 'Result'])
rows = [
    ('web-qr13-verify.js', 'WEB 1.1–1.3 (QR linking)', '20', 'PASS'),
    ('web-web14-verify.js', 'WEB 1.4 (offline survival)', '30', 'PASS'),
    ('web-web14-live.js', 'WEB 1.4 (live sockets)', '22', 'PASS'),
    ('web-web15-verify.js', 'WEB 1.5 (invisible sync)', '32', 'PASS'),
    ('web-web16-verify.js', 'WEB 1.6 / 1.7 (logoff + tab close)', '31', 'PASS'),
    ('web-web17-verify.js', 'WEB 1.8 (new-phone kick)', '29', 'PASS'),
    ('web-e2e.js', 'WEB 1.9 (end-to-end funnel)', '19', 'PASS'),
]
total = 0
for i, (a, b, c, d) in enumerate(rows, start=1):
    set_cell_text(t.rows[i].cells[0], a)
    set_cell_text(t.rows[i].cells[1], b)
    set_cell_text(t.rows[i].cells[2], c, align=WD_ALIGN_PARAGRAPH.CENTER)
    status_cell(t.rows[i].cells[3], d)
    total += int(c)
set_cell_text(t.rows[7].cells[0], 'Total', bold=True)
set_cell_text(t.rows[7].cells[1], '', )
set_cell_text(t.rows[7].cells[2], str(total), bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)
set_cell_text(t.rows[7].cells[3], '183/183 PASS', bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)

doc.add_paragraph()
kv('Overall verdict: ', '183/183 checks pass across all seven suites — WEB 1.1–1.9 fully verified at machine '
   'level against the replacement stack.')

doc.add_paragraph()
h('4. Key Findings & Challenges', 1)
bullet('Stale requirement path: the template points WEB-R1.x at apps/web/app, but the Next.js app had no session '
       'logic — the real surface was apps/web/qr-login. Recorded the standing scope decision and later replaced '
       'it entirely.', 'Finding 1 — ')
bullet('Offline-send correctness: naive direct sends would die with the phone; the fix was a backend-relay send '
       'path + localStorage outbox, so Web is independent of phone presence.', 'Finding 2 — ')
bullet('Sync-UI leak: the first R1.4 build exposed a #syncChip progress pill. Locked Phase-5 decision removed it '
       '— reconnect sync must be invisible.', 'Finding 3 — ')
bullet('Reconnect thundering herd: repeated offline→online cycles tens of rapid reconnect bursts; made '
       'loadRecentChats single-flight.', 'Finding 4 — ')
bullet('Legacy tech debt: Express + Socket.io pull-ins were entirely replaceable with node:http + ws, deleting '
       '~3900 lines of legacy code and all dead deps.', 'Finding 5 — ')

doc.add_paragraph()
h('5. Learnings', 1)
h('5.1 Technical', 2)
bullet('Session survival is a storage + lifecycle contract: enforce "sessionStorage never used / no unload '
       'handlers / clearWebSession exactly 2 call sites" with static checks, not just runtime discipline.')
bullet('A pure, Node-testable UMD module (outbox) lets a browser feature be unit-verified with zero browser '
       'dependency — huge for CI speed.')
bullet('Realtime broadcast + synchronous registry clear is the correct force-logout primitive: sessions see a '
       'reason and are hard-401 immediately, with no grace window to exploit.')
bullet('Standalone Node built-ins servers keep a demo surface deployable with no framework lock-in and are '
       'spawnable per-test on private ports.')
h('5.2 Process', 2)
bullet('One verify command (pnpm --filter @wpt/web run verify) that spans every requirement is durable regression '
       'insurance — all seven suites rerun green together.')
bullet('"Verify EVERY requirement with an executable harness before deleting the legacy app" let the retirement '
       'land cleanly with zero regressions.')
bullet('Documenting decisions (scope, incognito edge, sync-invisible) in the README/AGENTS narrative keeps the '
       'next session from re-litigating them.')

doc.add_paragraph()
h('6. Next Steps / Pending Items', 1)
bullet('Manual device VERIFY remains: link Web on real phone+desktop, close tab, force new-phone login, confirm '
       'the rescan end-state on screen (no blocking issue expected — all wire-level paths proven).', 'Pending: ')
bullet('Optionally harden validate interval jitter and add exponential backoff on repeated reconnects.', 'Pending: ')
bullet('Sync dependent PRs/teams on the retired qr-login path (docs already updated).', 'Pending: ')

doc.add_paragraph()
p = doc.add_paragraph()
r = p.add_run('Generated: ')
r.bold = True
r.font.size = Pt(10)
p2 = p.add_run('21 September 2026')
p2.font.size = Pt(10)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   'WEB_1.1_1.9_Task_Analysis_Learning_Report.docx')
doc.save(out)
print('Saved:', out)