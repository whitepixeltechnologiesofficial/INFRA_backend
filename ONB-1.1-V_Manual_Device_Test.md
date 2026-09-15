# ONB-1.1-V — MANUAL DEVICE TEST PROCEDURE
### Android / Expo Go — Team Alpha Retest (Branch `permission` @ commit `6b1133b`)

Use this guide to manually verify all 12 test cases on your own Android device.
Tick PASS / FAIL / record notes. Do **not** tick PASS unless you actually observed the expected behavior.

---

## 0. PREREQUISITES (once)

| # | Step | Command / Action |
|---|------|------------------|
| 1 | Start the dev server (PC) | `cd apps/mobile` then `npx expo start --port 8081` |
| 2 | Install Expo Go on phone | Google Play → "Expo Go" (supports SDK 57) |
| 3 | Connect | Put phone on the **same Wi-Fi** as the PC |
| 4 | Get the app URL | Dev server shows it. Use the LAN IP, e.g. `exp://192.168.1.3:8081` |
| 5 | Open app in Expo Go | In Expo Go: `Enter URL manually` → paste `exp://192.168.1.3:8081` |
| 6 | Fresh state (IMPORTANT for TC-10) | Clear Expo Go data: `Settings > Apps > Expo Go > Clear data` (or reinstall) before starting |
| 7 | Optional: adb | For deep links + screenshots: `adb connect <PHONE_IP>:5555` (enable Wireless debugging) or USB |

> Replace `192.168.1.3` with your actual PC LAN IP shown in the terminal (it changes).

---

## 1. THE TEST CASES — QUICK REFERENCE

| TC | Type | Requirement | How to Test |
|----|------|-------------|-------------|
| TC-01 | UI/Nav | Splash CTA navigates | Tap splash → goes to Legal acceptance |
| TC-02 | UI/Nav | No Skip option | Look for any Skip button → must be none |
| TC-03 | UI/Nav | No swipe bypass | Swipe left/right/up on splash → must do nothing |
| TC-04 | UI/Nav | No "Continue as Guest" | Look for a Guest button → must be none |
| TC-05 | Hardware | Android Back can't exit/bypass | Press Back on splash → app must NOT close |
| TC-06 | Security | Protected deep links blocked | Open deep links → must bounce to splash |
| TC-07 | Security | Fabricated phone # rejected | Deep-link a fake number to device-handoff → must bounce to splash |
| TC-08 | Security | Second fabricated # rejected | Deep-link a DIFFERENT fake number → must bounce to splash |
| TC-09 | Security | Direct /profile-setup blocked | Deep-link /profile-setup → must bounce to splash |
| TC-10 | Security | Cold start / cleared state | Clear data → deep-link protected route → must bounce to splash |
| TC-11 | Nav | Second /splash removed | Deep-link /splash → route must not exist |
| TC-12 | VCS | Provenance | `git branch --show-current` = `permission`; `git log -1` = `6b1133b` |

---

## 2. DEEP LINK COMMANDS (adb)

EMAIN TEST = planned (before/after log). After each deep link, watch whether you land
on the routed screen or the **splash**.

> The separator between the Expo URL and the route is `/--/`.
> Replace `exp://192.168.1.3:8081` with your LAN URL.
> Alternatively, in Expo Go use "Open from Clipboard" and paste the full URL with route.

### Setup alias (Windows PowerShell)
```powershell
$ADB = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
```

### TC-06 — protected deep links (each must bounce to SPLASH)
```powershell
# phone-entry (needs legalAccepted=true first)  -> should show SPLASH
& $ADB shell am start -a android.intent.action.VIEW -d "exp://192.168.1.3:8081/--/phone-entry"

# otp-entry (needs phoneEntered=true)           -> should show SPLASH
& $ADB shell am start -a android.intent.action.VIEW -d "exp://192.168.1.3:8081/--/otp-entry"

# profile-setup (needs otpVerified=true)        -> should show SPLASH
& $ADB shell am start -a android.intent.action.VIEW -d "exp://192.168.1.3:8081/--/profile-setup"

# (tabs) / authenticated area                    -> should show SPLASH
& $ADB shell am start -a android.intent.action.VIEW -d "exp://192.168.1.3:8081/--/%28tabs%29"
```

### TC-07 — fabricated phone number (must bounce to SPLASH, no "Logged In")
```powershell
# No "+" prefix — clearly not E.164
& $ADB shell am start -a android.intent.action.VIEW -d "exp://192.168.1.3:8081/--/device-handoff?phoneNumber=1234567890"
```

### TC-08 — a DIFFERENT fabricated phone number (must bounce to SPLASH)
```powershell
# Well-formed-looking but not a real, valid number
& $ADB shell am start -a android.intent.action.VIEW -d "exp://192.168.1.3:8081/--/device-handoff?phoneNumber=%2B1111111111"
```

### TC-09 — direct profile-setup (must bounce to SPLASH)
```powershell
& $ADB shell am start -a android.intent.action.VIEW -d "exp://192.168.1.3:8081/--/profile-setup"
```

### TC-10 — cold start / cleared state
1. Clear Expo Go data (see §0 step 6) or reinstall Expo Go.
2. DO NOT open the app normally first. Immediately deep-link to a protected route:
```powershell
& $ADB shell am start -a android.intent.action.VIEW -d "exp://192.168.1.3:8081/--/otp-entry"
& $ADB shell am start -a android.intent.action.VIEW -d "exp://192.168.1.3:8081/--/device-handoff?phoneNumber=%2B12125550000"
```
3. Observed: app opens on **Splash only** — never the deep-linked screen.

### TC-11 — second /splash removed (route must NOT exist)
```powershell
& $ADB shell am start -a android.intent.action.VIEW -d "exp://192.168.1.3:8081/--/splash"
```

---

## 3. ANDROID BACK BUTTON test (TC-05)

### On splash (cold start)
1. Open the app → you see the ONB splash ("Tap to proceed").
2. Press the **hardware/gesture Back** button on the phone.
3. **EXPECTED:** App stays on splash. It must **NOT** close the app and must **NOT** navigate elsewhere.
   - BackHandler returns `true`, swallowing the event (already verified in code:
   `app/OnboardingScreen.tsx` `useFocusEffect` + `hardwareBackPress`).
4. Press Back, Back, Back repeatedly — the app must remain on splash.
5. Record PASS / FAIL.

### From Legal Acceptance (verify it returns to splash, not exits)
1. Splash → tap → Legal Acceptance screen.
2. Press Back → must return to Splash.
3. Press Back again on Splash → app must still stay open.

---

## 4. TAP / SWIPE tests (TC-01 to TC-04)

1. **TC-01:** On splash, tap anywhere → must navigate to the Legal Acceptance screen.
2. **TC-02:** Search the whole screen — there must be **no "Skip"** button anywhere.
3. **TC-03:** Swipe left, right, up, down on splash → nothing happens (no navigation).
4. **TC-04:** Look for **"Continue as Guest"** / any guest entry → must be absent.

---

## 5. SCREENSHOT EVIDENCE (optional but recommended)

```powershell
# Save a screenshot from the connected device
$ADB exec-out screencap -p > "TC-06_splash.png"
```

Capture one screenshot per test for the report:
`TC-05_back.png`, `TC-06_deeplink_bounce.png`, `TC-07_fake1.png`, `TC-08_fake2.png`,
`TC-09_profile_direct.png`, `TC-10_coldstart.png`, `TC-11_splash_route.png`.

---

## 6. RESULTS RECORDING TABLE

| TC ID | Expected | Observed (your notes) | Status |
|-------|----------|------------------------|--------|
| TC-01 | Tap → Legal Acceptance | | ☐ PASS  ☐ FAIL |
| TC-02 | No Skip button | | ☐ PASS  ☐ FAIL |
| TC-03 | No swipe navigation | | ☐ PASS  ☐ FAIL |
| TC-04 | No Guest mode | | ☐ PASS  ☐ FAIL |
| TC-05 | Back on splash → stays | | ☐ PASS  ☐ FAIL |
| TC-06 | Deep links → splash | | ☐ PASS  ☐ FAIL |
| TC-07 | Fake #1234567890 → splash | | ☐ PASS  ☐ FAIL |
| TC-08 | Fake #+1111111111 → splash | | ☐ PASS  ☐ FAIL |
| TC-09 | /profile-setup → splash | | ☐ PASS  ☐ FAIL |
| TC-10 | Cleared state → splash | | ☐ PASS  ☐ FAIL |
| TC-11 | /splash → route absent | | ☐ PASS  ☐ FAIL |
| TC-12 | Branch=permission, commit=6b1133b | | ☐ PASS  ☐ FAIL |

---

## 7. FINAL TOTALS

- Total Test Cases = 12
- PASS = ______
- FAIL = ______
- NOT TESTED = ______

---

## 8. TROUBLESHOOTING

| Symptom | Fix |
|---------|-----|
| Expo Go can't connect | Same Wi-Fi; allow `expo` through Windows firewall; use LAN IP not localhost |
| QR doesn't scan | Type URL manually: `exp://192.168.1.3:8081` |
| "Development server is unreachable" | Verify `expo start` still running; press `s` in the terminal to switch to Expo Go |
| Deep link opens but app reloads | Expected — Expo Go reloads the bundle; observe the final screen |
| Bracket route `(tabs)` fails | Use URL-encoded `%28tabs%29` (shown in §2) |