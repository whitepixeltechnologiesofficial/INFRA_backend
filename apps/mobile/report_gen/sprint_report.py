"""Generate Satheesh Kumar personal sprint report DOCX."""
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
run = title.add_run('Personal Sprint Report')
run.bold = True
run.font.size = Pt(20)
run.font.name = 'Calibri'
run.font.color.rgb = RGBColor(0x1A, 0x1A, 0x2E)
sub = doc.add_paragraph()
sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
rsub = sub.add_run('Satheesh Kumar  |  WPT  |  Team Alpha')
rsub.font.size = Pt(12)
rsub.font.color.rgb = RGBColor(0x3F, 0x3F, 0x3F)
doc.add_paragraph()

h('1. Sprint Overview', 1)
kv('Sprint period: ', '8 September 2026 – 17 September 2026')
kv('Role / focus: ', 'QA & test verification for the Onboarding (ONB) feature on Team Alpha')
kv('Branch: ', 'team-alpha (verification work landed as commit 76ce077 on 15 Sep)')

doc.add_paragraph()
h('2. Deliverables Completed', 1)

h('2.1 ONB-1.1 onboarding navigation-bypass retest (QA verification)', 2)
body('Authored the full retest verification for the ONB-1.1 deep-link / navigation-bypass fix '
     '(branch "permission", commit 6b1133b). Produced a 12 test-case (TC-01 to TC-12) retest '
     'report covering UI/navigation, hardware back-button handling, security deep-link guards, '
     'fabricated phone-number rejection, cold-start / cleared-state behavior, and source provenance (VCS).')

h('2.2 Manual device test procedure', 2)
body('Wrote ONB-1.1-V_Manual_Device_Test.md: a full Android / Expo Go step-by-step procedure with '
     'pre-requisites, LAN setup, adb deep-link commands (URL-encoded (tabs) route, fabricated numbers, '
     'cold start), back-button test steps, screenshot-evidence list, and a results-recording table.')

h('2.3 Automated report generator', 2)
body('Built a reusable 4-part DOCX report generator under apps/mobile/report_gen using python-docx '
     '(main.py, helpers.py, part1–part4.py) with themes, landscape layout, and color-coded '
     'PASS / FAIL / REQUIRES DEVICE TEST status cells. Output artifact: '
     'ONB-1.1-V_Team_Alpha_Retest_Report.docx (delivered at repo root and under report_gen/).')

h('2.4 Verification handoff artifact', 2)
body('Delivered RETEST_RESULTS_HANDOFF.json: machine-readable per-case results with code-level '
     'evidence references (app/_layout.tsx guards, app/device-handoff.tsx phone validation), '
     'summary counts, and a next-steps handoff for the follow-on device run.')

doc.add_paragraph()
h('3. Retest Results Summary', 1)

t = data_table(4, 3)
header_row(t, ['Outcome', 'Count', 'Test Cases'])
rows = [
    ('PASS (code-verified)', '6', 'TC-01, TC-02, TC-03, TC-04, TC-11, TC-12'),
    ('REQUIRES DEVICE TEST', '6', 'TC-05, TC-06, TC-07, TC-08, TC-09, TC-10'),
    ('FAIL', '0', '—'),
]
for i, (a, b, c) in enumerate(rows, start=1):
    status_cell(t.rows[i].cells[0], a)
    set_cell_text(t.rows[i].cells[1], b, align=WD_ALIGN_PARAGRAPH.CENTER)
    set_cell_text(t.rows[i].cells[2], c)

doc.add_paragraph()
kv('Key finding: ', 'TC-05 to TC-10 fixes were validated at code level — centralized BackHandler in '
   'OnboardingScreen, Stack.Protected route guards with onboarding-state flags, E.164 phone validation via '
   'libphonenumber-js, and in-memory-only state flags for cold-start safety. Six device-dependent cases were '
   'handed off with a fully documented execution procedure.')

doc.add_paragraph()
h('4. Next Steps / Pending Items', 1)
bullet('Run the 6 pending device tests (TC-05–TC-10) on Android via Expo Go (procedure already documented).', 'Pending: ')
bullet('Update part4.py summary counts + verdict and regenerate the DOCX (python main.py).', 'Pending: ')
bullet('Mark device-tested cases as "DEVICE TESTED" with screenshot evidence in the retest report.', 'Pending: ')

doc.add_paragraph()
p = doc.add_paragraph()
r = p.add_run('Generated: ')
r.bold = True
r.font.size = Pt(10)
p2 = p.add_run('17 September 2026')
p2.font.size = Pt(10)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   'Satheesh_Sprint_Report.docx')
doc.save(out)
print('Saved:', out)