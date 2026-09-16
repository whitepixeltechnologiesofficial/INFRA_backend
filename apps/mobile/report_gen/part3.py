"""Part 3: Section 7 (retest table), Section 8 (before/after)."""
from docx.enum.text import WD_ALIGN_PARAGRAPH
from helpers import h, body, kv, data_table, header_row, set_cell_text, set_cell_shading, LIGHT, status_cell


def build(doc):
    _retest_table(doc)
    _before_after(doc)


def _retest_table(doc):
    h(doc, '7. Detailed 12-Test-Case Retest Table', 1)
    body(doc, 'Every test case from ONB-1.1-V is evaluated against the current code at commit '
         '6b1133b. "Retest Method" states how verification was performed. "Final Status" uses '
         'PASS only where the evidence is conclusive; device-dependent cases are marked '
         'REQUIRES DEVICE TEST and are NOT counted as PASS.')

    cols = ['TC ID', 'Type', 'Objective', 'Original Result', 'Problem Found',
            'Fix / Change Made', 'Retest Method', 'Expected Result', 'Actual Result',
            'Evidence', 'Final Status']
    t = data_table(doc, 13, len(cols))
    header_row(t, cols, font_size=8.5)

    rows = [
        ('TC-01', 'UI / Nav', 'Splash CTA tap navigates to legal acceptance',
         'PASS', 'None',
         'No change needed',
         'CODE VERIFIED', 'Tap opens /legal-acceptance',
         'handlePress runs router.push("/legal-acceptance")',
         'app/OnboardingScreen.tsx:68-72',
         'PASS'),
        ('TC-02', 'UI / Nav', 'No Skip option on splash',
         'PASS', 'None',
         'No change needed',
         'CODE VERIFIED', 'No skip/link controls',
         'Only "Tap to proceed" CTA; component renders no skip control',
         'app/OnboardingScreen.tsx (full render)',
         'PASS'),
        ('TC-03', 'UI / Nav', 'No swipe gesture bypasses splash',
         'PASS', 'None',
         'No change needed',
         'CODE VERIFIED', 'Swipe does not advance flow',
         'Root is a Pressable; no gesture-enabled container',
         'app/OnboardingScreen.tsx (structure)',
         'PASS'),
        ('TC-04', 'UI / Nav', 'No "Continue as Guest" option',
         'PASS', 'None',
         'No change needed',
         'CODE VERIFIED', 'Guest path absent',
         'No guest control in splash or any onboarding screen',
         'OnboardingScreen.tsx + onboard_flow.md principles',
         'PASS'),
        ('TC-05', 'Hardware', 'Android Back cannot exit/bypass onboarding',
         'FAIL', 'BackHandler only in index.tsx; second splash had none',
         'BackHandler centralized into OnboardingScreen via useFocusEffect; splash.tsx deleted',
         'REQUIRES DEVICE TEST', 'Back on splash is swallowed; app stays',
         'Code attaches handler returning true on focus; OS-level behavior untested',
         'CODE: OnboardingScreen.tsx:36-41. DEVICE: not executed',
         'REQUIRES DEVICE TEST'),
        ('TC-06', 'Security', 'Protected deep links cannot reach screens early',
         'FAIL', 'Flat unguarded Stack exposed every route',
         'Stack.Protected guards + OnboardingContext flags',
         'REQUIRES DEVICE TEST', 'Direct deep link bounces to /',
         'Guards present for otp-entry/profile-setup/device-handoff/(tabs); real deep-link open not executed',
         'CODE: _layout.tsx guard blocks. DEVICE: not executed',
         'REQUIRES DEVICE TEST'),
        ('TC-07', 'Security', 'Fabricated phone deep link to /device-handoff rejected',
         'FAIL', 'No phone validation in device-handoff',
         'isValidPhoneNumber (libphonenumber-js) + "+" prefix guard',
         'REQUIRES DEVICE TEST', 'Fake number redirected to /',
         'Validation logic rejects non-E.164; fabricated-number link not opened on device',
         'CODE: device-handoff.tsx:27-30. DEVICE: not executed',
         'REQUIRES DEVICE TEST'),
        ('TC-08', 'Security', 'Different fabricated phone number also rejected',
         'FAIL', 'Same missing validation',
         'Same as TC-07 (format-based, covers all fabrications)',
         'REQUIRES DEVICE TEST', 'Any fake number redirected to /',
         'Validation is format-based so covers arbitrary inputs; not executed on device',
         'CODE: device-handoff.tsx:27-30. DEVICE: not executed',
         'REQUIRES DEVICE TEST'),
        ('TC-09', 'Security', 'Direct /profile-setup deep link blocked',
         'FAIL', 'profile-setup was public; no otpVerified state',
         'Guard otpVerified around profile-setup; flag set on OTP success',
         'REQUIRES DEVICE TEST', 'Direct open bounces to splash',
         'Guard present; direct-link opening not executed on device',
         'CODE: _layout.tsx guard; otp-entry.tsx markOtpVerified. DEVICE: not executed',
         'REQUIRES DEVICE TEST'),
        ('TC-10', 'Security', 'Cold start / cleared state blocks deep links',
         'FAIL', 'No onboarding state existed',
         'In-memory flags, all false at start (never persisted)',
         'REQUIRES DEVICE TEST', 'Cleared state = all links bounce to splash',
         'State design guarantees false defaults on cold start; cleared-state run not executed',
         'CODE: OnboardingContext.tsx INITIAL_STATE. DEVICE: not executed',
         'REQUIRES DEVICE TEST'),
        ('TC-11', 'Nav', 'Second /splash implementation removed',
         'FAIL', 'Duplicate splash route, no BackHandler/guard',
         'app/splash.tsx deleted (-356 lines)',
         'CODE VERIFIED', '/splash no longer resolves',
         'File absent from app/; no /splash route can register',
         'git show 6b1133b (deletion) + Test-Path False on app/splash.tsx',
         'PASS'),
        ('TC-12', 'VCS', 'Tested code provenance = Team Alpha',
         'PASS', 'None',
         'Verified on permission branch, commit 6b1133b',
         'CODE VERIFIED', 'Branch/commit match Team Alpha fix',
         'git branch --show-current = permission; git log -1 = 6b1133b',
         'Terminal: git status / git log (run 2026-09-15)',
         'PASS'),
    ]

    for i, row in enumerate(rows):
        for j, val in enumerate(row):
            cell = t.rows[i + 1].cells[j]
            if j == 3 or j == 10:
                status_cell(cell, val)
            else:
                set_cell_text(cell, val, font_size=8.5,
                              bold=(j == 0))
    doc.add_paragraph()
    body(doc, 'Notes: "REQUIRES DEVICE TEST" entries hold CODE-LEVEL evidence that the fix is '
         'implemented correctly, but the physical/OS behavior has not been executed in this '
         'session, so they cannot be counted as PASS.')
    doc.add_page_break()


def _before_after(doc):
    h(doc, '8. Before Fix vs After Fix Comparison', 1)
    body(doc, 'The table contrasts the original ONB-1.1-V result with the current retest outcome. '
         '"After" reflects only verification actually performed: CODE-verified PASS for '
         'code-conclusive cases; REQUIRES DEVICE TEST for device-dependent cases.')

    t = data_table(doc, 13, 4)
    header_row(t, ['TC ID', 'Before (Original)', 'Fix / Change', 'After (Current Retest)'],
               font_size=9)
    rows = [
        ('TC-01', 'PASS', 'None needed', 'PASS (code verified)'),
        ('TC-02', 'PASS', 'None needed', 'PASS (code verified)'),
        ('TC-03', 'PASS', 'None needed', 'PASS (code verified)'),
        ('TC-04', 'PASS', 'None needed', 'PASS (code verified)'),
        ('TC-05', 'FAIL', 'BackHandler centralized in OnboardingScreen; second splash removed', 'REQUIRES DEVICE TEST'),
        ('TC-06', 'FAIL', 'Stack.Protected guards over all onboarding/authenticated routes', 'REQUIRES DEVICE TEST'),
        ('TC-07', 'FAIL', 'E.164 phone validation (libphonenumber-js) in device-handoff', 'REQUIRES DEVICE TEST'),
        ('TC-08', 'FAIL', 'Same validation covers all fabricated numbers', 'REQUIRES DEVICE TEST'),
        ('TC-09', 'FAIL', 'otpVerified guard wraps profile-setup + device-handoff', 'REQUIRES DEVICE TEST'),
        ('TC-10', 'FAIL', 'In-memory flags all-false on cold start; guards enforce', 'REQUIRES DEVICE TEST'),
        ('TC-11', 'FAIL', 'app/splash.tsx deleted; single anchor remains', 'PASS (code verified)'),
        ('TC-12', 'PASS', 'Provenance confirmed (permission @ 6b1133b)', 'PASS (code verified)'),
    ]
    for i, row in enumerate(rows):
        for j, val in enumerate(row):
            cell = t.rows[i + 1].cells[j]
            if j in (1, 3):
                status_cell(cell, 'PASS' if val.startswith('PASS') else
                            ('REQUIRES DEVICE TEST' if 'REQUIRES' in val else val))
            else:
                set_cell_text(cell, val, font_size=9, bold=(j == 0))
    doc.add_paragraph()
    body(doc, 'Summary of fixes:')
    fix_pairs = [
        ('TC-05', 'Android back handling moved to the focused splash component; unprotected second splash deleted.'),
        ('TC-06', 'expo-router Stack.Protected guards added to every stage of the onboarding/authenticated stack.'),
        ('TC-07 / TC-08', 'libphonenumber-js E.164 validation rejects fabricated numbers before any handoff call.'),
        ('TC-09', 'profile-setup and device-handoff gated behind otpVerified, set only by real OTP success.'),
        ('TC-10', 'OnboardingContext flags are in-memory and default false, so a cleared state returns to locked.'),
        ('TC-11', 'The /splash route was deleted; the onboarding entry is a single guarded anchor.'),
    ]
    t2 = data_table(doc, len(fix_pairs) + 1, 2)
    header_row(t2, ['Fixed By', 'Change'], font_size=9)
    for i, (tc, change) in enumerate(fix_pairs):
        set_cell_shading(t2.rows[i + 1].cells[0], LIGHT)
        set_cell_text(t2.rows[i + 1].cells[0], tc, bold=True, font_size=9)
        set_cell_text(t2.rows[i + 1].cells[1], change, font_size=9)
    doc.add_page_break()