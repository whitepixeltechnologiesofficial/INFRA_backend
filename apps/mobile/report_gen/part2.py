"""Part 2: Section 5 (original failures) and Section 6 (implementation changes)."""
from helpers import h, body, kv, data_table, header_row, set_cell_text, LIGHT, set_cell_shading


def build(doc):
    _failures(doc)
    _changes(doc)


def _failures(doc):
    h(doc, '5. Original Failures — Root Cause Analysis', 1)
    body(doc, 'The seven originally-failing test cases are explained below: what failed, why it '
         'was a failure, which code/route caused it, the exact Team Alpha change, and how the '
         'change prevents the problem, followed by the post-fix test performed and its current '
         'result.')

    failures = [
        {
            'title': 'TC-05 — Android/OS Back Button',
            'what': 'Android hardware/gesture Back on the splash area could exit the app or drop '
                    'navigation into an uncontrolled state instead of staying locked inside the '
                    'onboarding flow.',
            'why': 'No universal back guard existed. The handler was attached only in app/index.tsx '
                   '(a thin wrapper), while the real splash component (OnboardingScreen) and the '
                   'second splash route (app/splash.tsx) had no BackHandler of their own.',
            'source': 'app/index.tsx contained BackHandler; app/splash.tsx (second splash) had none; '
                      'OnboardingScreen.tsx had none.',
            'change': 'Moved the BackHandler into OnboardingScreen.tsx and attach it via '
                      'useFocusEffect (attach on focus, detach on blur) returning true to swallow '
                      'the event. Deleted app/splash.tsx.',
            'prevents': 'The single entry screen swallows all back presses whenever focused, and the '
                        'unprotected second splash no longer exists.',
        },
        {
            'title': 'TC-06 — Protected Deep Links',
            'what': 'Onboarding and authenticated routes (otp-entry, profile-setup, device-handoff, '
                    '(tabs)) could be rendered directly by deep link, skipping prior steps.',
            'why': 'The root Stack listed screens flat with zero access control; there was no '
                   'onboarding-state mechanism to gate navigation.',
            'source': 'app/_layout.tsx — flat Stack, no Stack.Protected; no OnboardingContext existed.',
            'change': 'Created hooks/OnboardingContext.tsx (5 in-memory flags). RootNavigator wraps '
                      'every stage in Stack.Protected guard blocks keyed to the flags, and each '
                      'screen sets its flag on successful completion.',
            'prevents': 'expo-router Stack.Protected redirects a guarded screen to the anchor '
                        '(OnboardingScreen) whenever its flag is false — deep links cannot land on '
                        'a protected route.',
        },
        {
            'title': 'TC-07 — Device-Handoff Fabricated Phone Number',
            'what': 'A fabricated/malformed phoneNumber deep-link parameter to /device-handoff was '
                    'accepted and processed as a valid device handoff.',
            'why': 'device-handoff.tsx read phoneNumber straight from useLocalSearchParams and passed '
                   'it to mockOnboardingApi.loginNewDevice() without any format check.',
            'source': 'app/device-handoff.tsx — no phone validation.',
            'change': 'Added isValidPhoneNumber from libphonenumber-js/mobile. If the param does not '
                      'start with "+" or fails validation, router.replace(\'/\') immediately.',
            'prevents': 'Fabricated numbers fail structural E.164 validation before any handoff '
                        'logic/API call executes.',
        },
        {
            'title': 'TC-08 — Second Fabricated Phone Number',
            'what': 'A different fabricated phone number again reached the device-handoff logic — '
                    'confirming the bypass was systemic, not input-specific.',
            'why': 'Same root cause as TC-07: zero input validation.',
            'source': 'app/device-handoff.tsx — as TC-07.',
            'change': 'Same validation fix as TC-07.',
            'prevents': 'The check is format-based (libphonenumber-js), so it rejects every '
                        'non-E.164-compliant fabrication, not just one sample.',
        },
        {
            'title': 'TC-09 — Direct Profile Setup Deep Link',
            'what': '/profile-setup opened directly rendered the profile screen without OTP '
                    'verification, letting a user skip phone verification.',
            'why': 'profile-setup was a public Stack.Screen; no otpVerified state was consulted.',
            'source': 'app/_layout.tsx — profile-setup flat in Stack; app/otp-entry.tsx set no flag.',
            'change': 'Wrapped profile-setup (and device-handoff) in <Stack.Protected guard={otpVerified}>. '
                      'otp-entry.tsx now calls markOtpVerified() after successful verification '
                      '(new + existing users).',
            'prevents': 'A direct deep link hits otpVerified=false on cold start and bounces to the '
                        'anchor; only genuine OTP success can unlock profile-setup.',
        },
        {
            'title': 'TC-10 — Cold Start / Cleared State',
            'what': 'After clearing app data / Expo Go state or a cold launch, deep links still '
                    'opened the target screen — no state was required.',
            'why': 'No onboarding state existed at all, persisted or in-memory, so "cleared" state '
                   'was indistinguishable from a fresh, unguarded app.',
            'source': 'No OnboardingContext; _layout had no guards.',
            'change': 'OnboardingContext state is in-memory only (INITIAL_STATE, all flags false). '
                      'Every cold start / cleared state begins with all guards down.',
            'prevents': 'Cold start starts with every flag false, so every protected deep link is '
                        'rejected and routed to the anchor splash.',
        },
        {
            'title': 'TC-11 — Second /splash Implementation',
            'what': 'A second, duplicate splash implementation existed at app/splash.tsx, reachable '
                    'via /splash, with no BackHandler and no guard — an unprotected alternate entry.',
            'why': 'app/splash.tsx was auto-registered as a route by expo-router; it skipped the '
                   'legal-acceptance flow and had no BackHandler, so back could exit the app from '
                   'a cold deep link.',
            'source': 'app/splash.tsx (356 lines) — deleted route, absent from _layout.',
            'change': 'Deleted app/splash.tsx entirely; consolidated splash behavior into '
                      'OnboardingScreen.tsx (the single anchor).',
            'prevents': 'The /splash route no longer resolvable; the only entry point is the '
                        'guarded, BackHandler-protected anchor.',
        },
    ]

    for f in failures:
        h(doc, f['title'], 2)
        kv(doc, 'What was failing originally?', f['what'])
        kv(doc, 'Why was it a failure?', f['why'])
        kv(doc, 'Source code / route / navigation logic:', f['source'])
        kv(doc, 'Exact change made by Team Alpha:', f['change'])
        kv(doc, 'How the change prevents the problem:', f['prevents'])
    doc.add_page_break()


def _changes(doc):
    h(doc, '6. Implementation Changes Made by Team Alpha', 1)
    body(doc, 'Concise change records. Full source diff is in commit 6b1133b.')

    changes = [
        {
            'title': 'TC-06 — Deep-link protection (route guards)',
            'file': 'app/_layout.tsx; hooks/OnboardingContext.tsx (new)',
            'comp': 'RootNavigator / OnboardingProvider',
            'before': 'Flat Stack, 5 public screens, no access control.',
            'problem': 'Any route reachable by deep link without prerequisites.',
            'after': 'Stack.Protected blocks gate phone-entry (legalAccepted), otp-entry '
                     '(phoneEntered), profile-setup+device-handoff (otpVerified), '
                     'camera/contacts-permission (profileCreated), and (tabs)/done/modal '
                     '(onboardingComplete).',
            'why': 'Guards redirect to the anchor when false; flags are in-memory and false on '
                   'launch, so deep-link bypass is impossible.',
            'commit': '6b1133b',
        },
        {
            'title': 'TC-07 / TC-08 — Fabricated phone number rejection',
            'file': 'app/device-handoff.tsx',
            'comp': 'DeviceHandoffScreen useEffect',
            'before': 'phoneNumber passed directly from route params into loginNewDevice().',
            'problem': 'Arbitrary strings treated as valid phone numbers.',
            'after': 'Require "+" prefix and isValidPhoneNumber() (libphonenumber-js); otherwise '
                     'router.replace("/").',
            'why': 'Structural E.164 validation rejects every fabricated number before handoff',
            'commit': '6b1133b',
        },
        {
            'title': 'TC-09 — Profile-setup deep link blocked',
            'file': 'app/_layout.tsx; app/otp-entry.tsx',
            'comp': 'Stack.Protected guard={otpVerified}; OtpEntryScreen',
            'before': 'profile-setup public; no otpVerified state.',
            'problem': 'Direct /profile-setup skipped OTP verification.',
            'after': 'profile-setup inside guard={otpVerified}; otp-entry calls markOtpVerified() '
                     'after successful verification.',
            'why': 'Profile setup is unreachable unless OTP genuinely succeeded in the same session.',
            'commit': '6b1133b',
        },
        {
            'title': 'TC-10 — Cold start / cleared state protection',
            'file': 'hooks/OnboardingContext.tsx (new)',
            'comp': 'OnboardingProvider / INITIAL_STATE',
            'before': 'No onboarding state; cleared state != blocked.',
            'problem': 'Cleared data / cold start left every screen open.',
            'after': 'All five flags initialize to false; everything protected bounces to anchor.',
            'why': 'Flags are never persisted, so clearing state always returns to the "locked" '
                   'default.',
            'commit': '6b1133b',
        },
        {
            'title': 'TC-11 — Second /splash implementation removed',
            'file': 'app/splash.tsx (deleted, -356 lines)',
            'comp': 'Removed SplashScreen route',
            'before': 'Second splash auto-registered as /splash; no BackHandler, no guard.',
            'problem': 'Alternative unprotected entry that skipped legal acceptance.',
            'after': 'Deleted; splash consolidated into OnboardingScreen.tsx (anchor).',
            'why': 'The /splash route is gone; a single guarded entry remains.',
            'commit': '6b1133b',
        },
        {
            'title': 'TC-05 — Back button protection centralized',
            'file': 'app/OnboardingScreen.tsx; app/index.tsx',
            'comp': 'OnboardingScreen (useFocusEffect + BackHandler)',
            'before': 'BackHandler only in index.tsx wrapper; second splash none.',
            'problem': 'Back could exit or skip onboarding depending on entry route.',
            'after': 'Handler owned by the focused splash component; index.tsx becomes a pure '
                     're-export.',
            'why': 'The guard is bound to the screen that is actually rendered and focused.',
            'commit': '6b1133b',
        },
    ]

    for c in changes:
        h(doc, c['title'], 2)
        kv(doc, 'File:', c['file'])
        kv(doc, 'Component/Route:', c['comp'])
        kv(doc, 'Original behavior:', c['before'])
        kv(doc, 'Problem:', c['problem'])
        kv(doc, 'New behavior:', c['after'])
        kv(doc, 'Why it fixes the problem:', c['why'])
        kv(doc, 'Commit:', c['commit'])
    doc.add_page_break()