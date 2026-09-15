"""Part 4: Section 9-13 (device procedure, evidence, summary, verdict, conclusion)."""
from helpers import (h, body, kv, data_table, header_row, set_cell_text,
                     set_cell_shading, LIGHT, status_cell)


def build(doc, summary):
    _device_procedure(doc)
    _evidence(doc)
    _final_summary(doc, summary)
    _verdict(doc, summary)
    _conclusion(doc)


def _device_procedure(doc):
    h(doc, '9. Physical Device Testing Procedure', 1)
    body(doc, 'The following cases require a physical Android device running Expo Go connected to '
         'the current Team Alpha development server (branch permission, commit 6b1133b). Testers '
         'must record PASS/FAIL per step and attach a screenshot / screen recording.')

    procs = [
        ('TC-05', [
            'Start the Expo application (permission branch, commit 6b1133b).',
            'The splash screen (OnboardingScreen) appears.',
            'Press the Android hardware or gesture Back button.',
            'Observe: the app must NOT exit; the splash must remain focused.',
            'Proceed to legal-acceptance, then press Back and observe the app returns to splash.',
            'Record PASS or FAIL.',
        ]),
        ('TC-06', [
            'Start Expo Go and connect to the Team Alpha dev server.',
            'Deep-link to /device-handoff?phoneNumber=%2B15555550100 (or similar valid-format number).',
            'Deep-link to /profile-setup and to /(tabs).',
            'Observe each protected screen cannot render; the app must land on the splash anchor.',
            'Record PASS or FAIL per route.',
        ]),
        ('TC-07', [
            'Start Expo Go and connect to the Team Alpha dev server.',
            'Deep-link to /device-handoff?phoneNumber=1234567890 (fabricated, no "+").',
            'Observe the screen redirects to the splash; no "Logged In!" screen appears.',
            'Record PASS or FAIL.',
        ]),
        ('TC-08', [
            'Repeat TC-07 using a different fabricated number, e.g. /device-handoff?phoneNumber=%2B1111111111.',
            'Observe the fabricated number is rejected and redirects to the splash.',
            'Record PASS or FAIL.',
        ]),
        ('TC-09', [
            'Deep-link directly to /profile-setup.',
            'Observe the profile screen cannot open before OTP verification; app bounces to splash.',
            'Record PASS or FAIL.',
        ]),
        ('TC-10', [
            'Clear Expo Go app data / reinstall, or cold-launch after force-stop.',
            'Immediately deep-link to a protected route (profile-setup, device-handoff, tabs).',
            'Observe the protected screen is rejected; app starts at the splash anchor.',
            'Record PASS or FAIL.',
        ]),
        ('TC-11', [
            'Deep-link to /splash.',
            'Observe the route does not exist (Expo Go shows the anchor/not found), i.e. the second '
            'splash cannot be opened.',
            'Verify the sole splash entry is the anchor with BackHandler protection.',
            'Record PASS or FAIL.',
        ]),
    ]
    for tc, steps in procs:
        h(doc, f'{tc}', 2)
        for k, s in enumerate(steps, start=1):
            doc.add_paragraph(f'{k}. {s}', style='List Number')
    doc.add_page_break()


def _evidence(doc):
    h(doc, '10. Evidence Classification', 1)
    body(doc, 'Each test case is supported by the evidence below, clearly labelled.')

    t = data_table(doc, 14, 3)
    header_row(t, ['TC ID', 'Evidence Label', 'Evidence'], font_size=9)
    rows = [
        ('TC-01', 'CODE VERIFIED', 'OnboardingScreen.tsx:68-72 handlePress -> router.push("/legal-acceptance")'),
        ('TC-02', 'CODE VERIFIED', 'OnboardingScreen render tree contains no skip control'),
        ('TC-03', 'CODE VERIFIED', 'Splash root is Pressable; no swipeable/gesture container'),
        ('TC-04', 'CODE VERIFIED', 'No guest control anywhere in onboarding screens; onboard_flow.md'),
        ('TC-05', 'CODE VERIFIED (DEVICE NOT TESTED)', 'OnboardingScreen.tsx:36-41 BackHandler(false-provider returns true); OS behavior pending'),
        ('TC-06', 'CODE VERIFIED (DEVICE NOT TESTED)', '_layout.tsx Stack.Protected blocks + OnboardingContext flags'),
        ('TC-07', 'CODE VERIFIED (DEVICE NOT TESTED)', 'device-handoff.tsx:27-30 validation + router.replace("/")'),
        ('TC-08', 'CODE VERIFIED (DEVICE NOT TESTED)', 'device-handoff.tsx same format-based guard'),
        ('TC-09', 'CODE VERIFIED (DEVICE NOT TESTED)', '_layout.tsx guard={otpVerified}; otp-entry.tsx markOtpVerified()'),
        ('TC-10', 'CODE VERIFIED (DEVICE NOT TESTED)', 'OnboardingContext.tsx INITIAL_STATE all false; no persistence'),
        ('TC-11', 'CODE VERIFIED', 'Commit 6b1133b deletes app/splash.tsx (-356); file absent (Test-Path False)'),
        ('TC-12', 'CODE VERIFIED (TERMINAL)', 'git status/log/remote output captured 2026-09-15'),
    ]
    for i, row in enumerate(rows):
        for j, val in enumerate(row):
            cell = t.rows[i + 1].cells[j]
            if j == 1:
                label = 'CODE VERIFIED' if 'DEVICE NOT TESTED' not in val else 'REQUIRES DEVICE TEST'
                status_cell(cell, label)
            else:
                set_cell_text(cell, val, font_size=8.5, bold=(j == 0))
    doc.add_paragraph()
    body(doc, 'No automated unit/integration tests were executed in this session because no test '
         'runner/cases are configured for the mobile app; all evidence above is source-level and '
         'version-control output.')
    doc.add_page_break()


def _final_summary(doc, summary):
    h(doc, '11. Final PASS / FAIL Summary', 1)

    t = data_table(doc, 13, 3)
    header_row(t, ['TC ID', 'Original Result', 'Current Retest'], font_size=9)
    rows = [
        ('TC-01', 'PASS', 'PASS'),
        ('TC-02', 'PASS', 'PASS'),
        ('TC-03', 'PASS', 'PASS'),
        ('TC-04', 'PASS', 'PASS'),
        ('TC-05', 'FAIL', 'REQUIRES DEVICE TEST'),
        ('TC-06', 'FAIL', 'REQUIRES DEVICE TEST'),
        ('TC-07', 'FAIL', 'REQUIRES DEVICE TEST'),
        ('TC-08', 'FAIL', 'REQUIRES DEVICE TEST'),
        ('TC-09', 'FAIL', 'REQUIRES DEVICE TEST'),
        ('TC-10', 'FAIL', 'REQUIRES DEVICE TEST'),
        ('TC-11', 'FAIL', 'PASS'),
        ('TC-12', 'PASS', 'PASS'),
    ]
    for i, (tc, orig, cur) in enumerate(rows):
        set_cell_text(t.rows[i + 1].cells[0], tc, bold=True, font_size=9)
        status_cell(t.rows[i + 1].cells[1], orig)
        status_cell(t.rows[i + 1].cells[2], cur)
    doc.add_paragraph()

    body(doc, 'Totals (REQUIRES DEVICE TEST is not counted as PASS):', bold=True)
    s = summary
    for line in [
        f'Total Test Cases = 12',
        f'PASS = {s["pass"]}',
        f'FAIL = {s["fail"]}',
        f'NOT RETESTED = {s["not_retested"]}',
        f'REQUIRES DEVICE TEST = {s["device"]}',
    ]:
        doc.add_paragraph(line, style='List Bullet').runs[0].font.name = 'Calibri'
    doc.add_page_break()


def _verdict(doc, summary):
    h(doc, '12. Overall Verdict', 1)
    s = summary
    body(doc, f'OVERALL RETEST VERDICT: INCOMPLETE', bold=True)
    body(doc, 'Code-level verification demonstrates that the Team Alpha fixes for TC-05 through '
         'TC-11 are correctly implemented (route guards, E.164 validation, single guarded splash '
         'entry, centralized BackHandler). However, the device-dependent behavior — deep-link '
         'opening, Android hardware back, and cold-start / cleared-state handling — has not been '
         'executed on a physical Android device in this session, so those cases remain open.')
    body(doc, f'Reasoning:')
    body(doc, f'- Closed at code level: {s["pass"]} of 12 test cases are verified PASS '
              '(TC-01, TC-02, TC-03, TC-04, TC-11, TC-12).', size=10)
    body(doc, f'- Still required: TC-05, TC-06, TC-07, TC-08, TC-09 and TC-10 '
              f'({s["device"]} cases) require physical-device / Expo Go execution per Section 9.',
              size=10)
    doc.add_page_break()


def _conclusion(doc):
    h(doc, '13. Conclusion', 1)
    body(doc, 'The onboarding/deep-link bypass defects reported in ONB-1.1-V have been addressed '
         'by Team Alpha in commit 6b1133b. The implementation introduces an in-memory onboarding '
         'state machine with expo-router Stack.Protected guards, E.164 phone validation in the '
         'device-handoff route, a single guarded splash entry point, and centralized Android back '
         'handling.')
    body(doc, 'Code-level review confirms each originally-failing test case has a concrete, '
         'mechanically-sound fix. Physical-device execution (Expo Go on Android) is required to '
         'close the remaining six test cases before the suite can be reported as fully PASS.')
    body(doc, 'Recommendation: schedule the Section 9 device runs, capture screenshots, annotate '
         'each TC in the Section 11 summary, and re-issue this report with those cases marked '
         'DEVICE TESTED once confirmed.', bold=False)
    doc.add_paragraph()