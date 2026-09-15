"""Part 1: Title page, TOC, repository info, scope, provenance, original summary."""
import datetime
from docx.shared import Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from helpers import (set_cell_text, set_cell_shading, header_row, h, body,
                     kv, data_table, DARK, LIGHT, status_cell)


def build(doc, meta):
    _title_page(doc)
    _toc(doc)
    _project_info(doc)
    _scope(doc)
    _provenance(doc)
    _original_summary(doc)


def _title_page(doc):
    for _ in range(5):
        doc.add_paragraph()
    t = doc.add_paragraph()
    t.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = t.add_run('ONB-1.1-V')
    r.bold = True
    r.font.size = Pt(36)
    r.font.color.rgb = RGBColor(0x1A, 0x1A, 0x2E)

    s = doc.add_paragraph()
    s.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = s.add_run('Team Alpha Retest / Verification Report')
    r.bold = True
    r.font.size = Pt(20)
    r.font.color.rgb = RGBColor(0x3F, 0xC6, 0xB8)

    d = doc.add_paragraph()
    d.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = d.add_run('Onboarding Deep-Link Bypass Fix — Post-Fix Verification')
    r.font.size = Pt(13)
    r.font.color.rgb = RGBColor(0x55, 0x55, 0x55)

    for _ in range(3):
        doc.add_paragraph()

    meta_items = [
        ('Document Type:', 'Retest / Verification Report'),
        ('Project:', 'INFRA_backend — Mobile Application'),
        ('Module:', 'ONB-1.0 through ONB-1.7 (Onboarding Flow)'),
        ('Test Case Source:', 'ONB-1.1-V Test Case File'),
        ('Branch:', 'permission (Team Alpha fix branch)'),
        ('Fix Commit:', '6b1133b'),
        ('Date:', datetime.datetime.now().strftime('%d %B %Y')),
        ('Status:', 'CODE-LEVEL VERIFIED / DEVICE TESTS PENDING'),
    ]
    t = data_table(doc, len(meta_items), 2)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, (lab, val) in enumerate(meta_items):
        set_cell_text(t.rows[i].cells[0], lab, bold=True, font_size=10)
        set_cell_text(t.rows[i].cells[1], val, font_size=10)
    doc.add_page_break()


def _toc(doc):
    h(doc, 'Table of Contents', 1)
    items = [
        '1. Project / Repository Information',
        '2. Testing Scope',
        '3. Branch Provenance & Fix Commit Identification',
        '4. Original Test Summary (ONB-1.1-V)',
        '5. Original Failures — Root Cause Analysis',
        '6. Implementation Changes Made by Team Alpha',
        '7. Detailed 12-Test-Case Retest Table',
        '8. Before Fix vs After Fix Comparison',
        '9. Physical Device Testing Procedure',
        '10. Evidence Classification',
        '11. Final PASS / FAIL Summary',
        '12. Overall Verdict',
        '13. Conclusion',
    ]
    for it in items:
        doc.add_paragraph(it, style='List Number')
    doc.add_page_break()


def _project_info(doc):
    h(doc, '1. Project / Repository Information', 1)
    data = [
        ('Repository', 'INFRA_backend'),
        ('Remote URL', 'https://github.com/wpt-project/INFRA_backend.git'),
        ('Mobile App Path', 'apps/mobile/'),
        ('Framework', 'Expo SDK 54 / React Native / expo-router'),
        ('Routing', 'expo-router Stack with Stack.Protected guards'),
        ('Phone Validation', 'libphonenumber-js (mobile metadata bundle)'),
        ('Current Branch', 'permission'),
        ('Branch State', 'ahead of origin/permission by 1 commit'),
        ('Fix Commit', '6b1133b — "fix(onboarding): add Stack.Protected route guards"'),
        ('Base / Previous', '9572fee (main — Merge PR #15)'),
    ]
    t = data_table(doc, len(data), 2)
    for i, (lab, val) in enumerate(data):
        set_cell_shading(t.rows[i].cells[0], LIGHT)
        set_cell_text(t.rows[i].cells[0], lab, bold=True, font_size=10)
        set_cell_text(t.rows[i].cells[1], val, font_size=10)
    doc.add_paragraph()


def _scope(doc):
    h(doc, '2. Testing Scope', 1)
    body(doc, 'This report documents the retest / verification of the 12 test cases from the '
         'ONB-1.1-V test case file, executed against the current Team Alpha code. The suite '
         'verifies that the onboarding flow cannot be bypassed via Android back button, deep links, '
         'fabricated phone numbers, cleared-state / cold-start access, or a second splash route.')
    body(doc, 'Verification is separated into two classes:')
    for b in [
        'CODE VERIFIED — source-code inspection, git diff review, route-guard verification, '
        'and static analysis of navigation logic. No physical device required.',
        'REQUIRES DEVICE TEST — the behavior depends on the Android framework / Expo Go and must '
        'be confirmed on a physical device. Not automatically counted as PASS.',
    ]:
        doc.add_paragraph(b, style='List Bullet')
    doc.add_page_break()


def _provenance(doc):
    h(doc, '3. Branch Provenance & Fix Commit Identification', 1)

    h(doc, '3.1 Current Branch / Version Control Details', 2)
    kv(doc, 'git branch --show-current:', 'permission')
    kv(doc, 'git status:', 'On branch permission; ahead of origin/permission by 1 commit; working tree clean')
    kv(doc, 'git remote -v:', 'origin  https://github.com/wpt-project/INFRA_backend.git')

    h(doc, '3.2 Fix Commit Identity', 2)
    t = data_table(doc, 5, 2)
    data = [
        ('Hash', '6b1133bb27edb18bd2958d3c8a1da8b9813efd3f'),
        ('Author', 'wpt-project'),
        ('Date', 'Tue Sep 15 16:48:29 2026 +0530'),
        ('Message', 'fix(onboarding): add Stack.Protected route guards to prevent bypass via deep link'),
        ('Scope', '22 files changed (+10,016 / -5,152) in apps/mobile'),
    ]
    for i, (lab, val) in enumerate(data):
        set_cell_shading(t.rows[i].cells[0], LIGHT)
        set_cell_text(t.rows[i].cells[0], lab, bold=True, font_size=10)
        set_cell_text(t.rows[i].cells[1], val, font_size=10)
    doc.add_paragraph()

    h(doc, '3.3 Key Files Touched by the Fix', 2)
    t = data_table(doc, 12, 3)
    header_row(t, ['File', 'Status', 'Relevance'], font_size=9)
    rows = [
        ('hooks/OnboardingContext.tsx', 'NEW', 'In-memory state flags gating Stack.Protected'),
        ('hooks/PermissionsContext.tsx', 'NEW', 'Permission re-grant reconciliation (foundation)'),
        ('hooks/usePermissions.ts', 'NEW', 'Permission status tracking hook (foundation)'),
        ('app/_layout.tsx', 'MOD', 'Root stack rebuilt with Stack.Protected guard blocks'),
        ('app/OnboardingScreen.tsx', 'MOD', 'BackHandler centralized; sole splash entry'),
        ('app/device-handoff.tsx', 'MOD', 'E.164 validation via libphonenumber-js'),
        ('app/legal-acceptance.tsx', 'MOD', 'Sets markLegalAccepted() on continue'),
        ('app/phone-entry.tsx', 'MOD', 'Sets markPhoneEntered() before OTP nav'),
        ('app/otp-entry.tsx', 'MOD', 'Sets markOtpVerified() / markOnboardingComplete()'),
        ('app/profile-setup.tsx', 'MOD', 'Sets markProfileCreated(); routes via permission steps'),
        ('app/splash.tsx', 'DELETED', 'Removed second splash bypass vector'),
    ]
    for i, row in enumerate(rows):
        for j, val in enumerate(row):
            set_cell_text(t.rows[i + 1].cells[j], val, font_size=9,
                          bold=(j == 1))
    doc.add_page_break()


def _original_summary(doc):
    h(doc, '4. Original Test Summary (ONB-1.1-V)', 1)
    body(doc, 'The ONB-1.1-V test case document defined 12 test cases. Seven were reported '
         'failing (TC-05 through TC-11) and five passing (TC-01 through TC-04, TC-12).')
    t = data_table(doc, 13, 3)
    header_row(t, ['TC ID', 'Description', 'Original Result'], font_size=9)
    rows = [
        ('TC-01', 'Splash screen CTA navigation', 'PASS'),
        ('TC-02', 'No Skip option', 'PASS'),
        ('TC-03', 'No swipe bypass', 'PASS'),
        ('TC-04', 'No Continue as Guest', 'PASS'),
        ('TC-05', 'Android/OS Back button', 'FAIL'),
        ('TC-06', 'Protected deep links', 'FAIL'),
        ('TC-07', 'Device-handoff fabricated phone number', 'FAIL'),
        ('TC-08', 'Second fabricated phone number', 'FAIL'),
        ('TC-09', 'Direct Profile Setup deep link', 'FAIL'),
        ('TC-10', 'Cold start / cleared state', 'FAIL'),
        ('TC-11', 'Second /splash implementation', 'FAIL'),
        ('TC-12', 'Team Alpha branch provenance', 'PASS'),
    ]
    for i, (tc, desc, res) in enumerate(rows):
        set_cell_text(t.rows[i + 1].cells[0], tc, bold=True, font_size=9)
        set_cell_text(t.rows[i + 1].cells[1], desc, font_size=9)
        status_cell(t.rows[i + 1].cells[2], res)
    doc.add_paragraph()
    kv(doc, 'Original Summary:', '5 PASS  |  7 FAIL', size=10.5)
    doc.add_page_break()