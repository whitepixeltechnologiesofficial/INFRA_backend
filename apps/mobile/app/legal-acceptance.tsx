// app/legal-acceptance.tsx
import { hasAcceptedLegal, recordLegalAcceptance } from '@/lib/legal-acceptance';
import { Fonts } from '@/constants/typography';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  BackHandler,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

const C = {
  bg: '#0B0F14',
  bg2: '#15171C',
  card: '#12151B',
  ink: '#3FC6B8',
  inkDim: '#9AA0AC',
  accent: '#3FC6B8',
  border: '#242832',
  borderSoft: '#2E323C',
  text: '#F3F3F4',
  textDim: '#C6CAD2',
  disabled: '#1E5C55',
};

type LegalSection = { part?: string; title: string; body: string };

// Version of the in-app legal document. Keep this in sync with the
// web PDF (public/docs/WPT_Terms_of_Service_Privacy_Policy_v1.1.pdf)
// and the backend CURRENT_LEGAL_VERSION (apps/backend/src/auth/legal-gate.ts).
const LEGAL_DOCUMENT_VERSION = 'v1.1';

// Text copied word for word from "Terms of Service & Privacy Policy — Draft v1.1"
// (White Pixel Technologies, 11 Aug 2026). Only two kinds of edits were made:
// 1. "[App Name]" is shown as "the App" (the product name is not decided yet).
// 2. The internal "Flag for legal review" notes are left out (they are notes
// for our lawyer, not text for users).
const LEGAL_SECTIONS: LegalSection[] = [
  {
    part: 'Part A - Terms of Service',
    title: '1. Acceptance of Terms',
    body: `By creating an account or using the App (“the Service”), operated by White Pixel Technologies (“WPT,” “we,” “us”), you agree to these Terms of Service (“Terms”). If you do not agree, do not use the Service.`,
  },
  {
    title: '2. Eligibility',
    body: `You must be at least 16 years old to use the Service. We set this age uniformly across all regions for consistency, even though some jurisdictions (e.g., certain EU member states under GDPR, or the US under COPPA) permit a lower age with parental consent. If we learn an account belongs to someone under 16, we reserve the right to suspend or delete it.`,
  },
  {
    title: '3. Description of the Service',
    body: `The App is an end-to-end encrypted (E2EE) messaging application enabling 1:1 and group text messaging, media and voice note sharing, and related communication features across Android, iOS, and Web. Messages and media are encrypted such that WPT cannot read their content in transit or at rest, except in the limited circumstance described in Section 7 (Reporting).`,
  },
  {
    title: '4. Your Account',
    body: `You register using a valid phone number, verified via a one-time code (OTP). One account per phone number. You are responsible for maintaining control of the device(s) and phone number associated with your account.

You are responsible for all activity under your account. Notify us immediately if you suspect unauthorized access.

Logging into the Service on a new device automatically signs out any other active session (phone or Web) tied to that account, for security purposes. See our Privacy Policy for details.`,
  },
  {
    title: '5. Acceptable Use',
    body: `You agree not to use the Service to:
• Violate any applicable law or regulation;
• Harass, threaten, abuse, or harm another person;
• Send spam, unsolicited bulk messages, or fraudulent content;
• Distribute content depicting child sexual abuse, exploitation, or any illegal content;
• Impersonate another person or misrepresent your affiliation;
• Attempt to interfere with, disrupt, or reverse-engineer the Service or its encryption;
• Use the Service for any commercial messaging, automated bulk communication, or business purpose not explicitly authorized by WPT.`,
  },
  {
    title: '6. User Content',
    body: `You retain ownership of the messages, media, and other content you send (“User Content”).

Because the Service is end-to-end encrypted, WPT does not have routine access to the content of your messages. Messages are removed from our servers immediately upon successful delivery; undelivered messages are automatically deleted after 30 days.

The limited exception is described in Section 7.`,
  },
  {
    title: '7. Reporting & Enforcement',
    body: `If you report another user or group, the most recent messages from that conversation (as they exist on your device) and related metadata (phone number, timestamps, message type) are forwarded to WPT for review. This is the only circumstance in which WPT receives message content, and it occurs only because you — the reporter — voluntarily share content already visible on your own device.

Reported content is retained for up to 30 days for review purposes and then deleted.

We may issue warnings, temporarily restrict, or permanently ban accounts found to violate these Terms. We are not obligated to disclose the outcome of a report to the reporting party or to the reported user.

Blocks and reports associated with a phone number persist even if the associated account is deleted and a new account is later created with the same number.`,
  },
  {
    title: '8. Termination',
    body: `By you: You may delete your account at any time via the app. Deletion is permanent; your profile data and device-local message history are not recoverable by WPT. Other users’ existing conversation history with you is not remotely altered.

By us: We may suspend or terminate your account for violation of these Terms, at our discretion, with or without notice.

A phone number associated with a deleted account may not be used to create a new account for 48 hours.`,
  },
  {
    title: '9. Intellectual Property',
    body: `The Service, including its software, design, and branding, is owned by WPT and protected by applicable intellectual property laws. These Terms do not grant you any rights to WPT’s intellectual property beyond the limited right to use the Service as intended.`,
  },
  {
    title: '10. Disclaimers',
    body: `The Service is provided “as is” and “as available,” without warranties of any kind, express or implied, including but not limited to fitness for a particular purpose, merchantability, or non-infringement. WPT does not guarantee uninterrupted or error-free operation, particularly given the Service’s reliance on free-tier infrastructure during its initial phase.`,
  },
  {
    title: '11. Limitation of Liability',
    body: `To the maximum extent permitted by law, WPT shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the Service.`,
  },
  {
    title: '12. Governing Law',
    body: `Placeholder — governing law and dispute resolution jurisdiction to be determined with legal counsel, based on WPT’s country of incorporation and target markets.`,
  },
  {
    title: '13. Changes to These Terms',
    body: `We may update these Terms from time to time. Material changes will be notified in-app before taking effect. Continued use of the Service after changes take effect constitutes acceptance.`,
  },
  {
    title: '14. Contact',
    body: `Placeholder — insert WPT’s legal/support contact details once established.`,
  },
  {
    part: 'Part B - Privacy Policy',
    title: '1. Introduction',
    body: `This Privacy Policy explains what data White Pixel Technologies (“WPT”) collects through the App, why, and what rights you have over it. We’ve designed the Service around collecting as little as possible, consistent with its end-to-end encrypted design.`,
  },
  {
    title: '2. Data We Collect',
    body: `• Phone number — required for account creation and identification.
• Profile information — name (required), profile photo (optional), about/status text (has a default value, editable).
• Contact list matching — if you grant Contacts permission, your phone contacts are checked against our registered user database, using cryptographic hashing rather than uploading your raw contact list. Because phone numbers have a limited range of possible values, hashing provides strong but not absolute protection — it is a widely used, industry-standard technique for privacy-preserving contact discovery, though it does not offer the same guarantees as more advanced (and more resource-intensive) approaches some larger providers use. We consider this the right balance for the Service at its current stage and will revisit stronger techniques as the Service grows.
• Device and technical data — device type, OS version, app version, and connection metadata necessary for message delivery and troubleshooting.
• Message metadata — timestamps, sender/recipient identifiers, and delivery status, necessary to route encrypted messages. This does not include message content.
• Reported content — only when you submit a report (see Terms Section 7), and only from your own device’s already-decrypted view.`,
  },
  {
    title: '3. Data We Do Not Collect',
    body: `• Message content — text, voice notes, photos, videos, and documents are end-to-end encrypted using the Signal Protocol. WPT cannot read this content in normal operation.
• We do not retain message or media content on our servers beyond active delivery (immediate deletion on delivery; 30-day maximum for undelivered messages).
• We do not use message content for advertising, profiling, or any automated analysis, because we cannot access it.`,
  },
  {
    title: '4. How We Use Data',
    body: `• To provide and operate the Service (account creation, message routing, contact discovery).
• To maintain security (e.g., detecting and preventing abuse, enforcing the reporting/enforcement process in Section 7 of the Terms).
• To communicate with you about your account (e.g., OTP codes, security notices such as new-device login alerts).
• We do not sell your personal data to third parties, and we do not use your data for third-party advertising.`,
  },
  {
    title: '5. Legal Bases for Processing (where applicable, e.g., under GDPR)',
    body: `• Contractual necessity — processing your phone number and account data to provide the Service you’ve signed up for.
• Legitimate interest — security, fraud prevention, and abuse reporting.
• Consent — where required, e.g., for optional permissions like Contacts, Notifications, Microphone, Camera, and Photos/Files access, all of which can be declined or revoked at any time.`,
  },
  {
    title: '6. Data Sharing',
    body: `• We do not sell personal data.
• Reported content (Section 7 of the Terms) is accessible only to WPT’s internal review process.
• We may disclose data if legally compelled by a valid law enforcement request, to the extent we hold any relevant data (which, for message content, is limited to voluntarily reported content already described above).`,
  },
  {
    title: '7. Data Retention',
    body: `• Message/media content (server-side): Deleted immediately on successful delivery; max 30 days if undelivered
• Reported content (evidence): Up to 30 days from submission, then deleted
• Account/profile data: Until account deletion
• Deleted account — number reuse: 48-hour cooldown before the same number can register a new account
• Local device backup (optional): Stored at your own discretion, outside WPT’s control; password-protected with no recovery if forgotten,`,
  },
  {
    title: '8. Your Rights',
    body: `Depending on your jurisdiction, you may have rights including:
• Access — request a copy of the personal data we hold about you.
• Rectification — correct inaccurate profile data directly in-app.
• Erasure — delete your account and associated data at any time via the app. Once deleted, this is permanent and cannot be recovered by WPT.
• Portability — export your local message history via the in-app encrypted backup feature.
• Objection/restriction — object to certain processing, e.g., by declining optional permissions.
• Non-discrimination (California residents, CCPA/CPRA) — we will not deny you service for exercising your privacy rights.`,
  },
  {
    title: '9. International Data Transfers',
    body: `As a global service using managed free-tier infrastructure providers, your data may be processed in countries other than your own.`,
  },
  {
    title: '10. Children’s Privacy',
    body: `The Service is not directed at children under 16. We do not knowingly collect data from children under this age. See Terms Section 2 regarding eligibility.`,
  },
  {
    title: '11. Security',
    body: `We use the Signal Protocol to provide end-to-end encryption for message content. Encryption keys are generated and stored on your device (and, for Web, in your browser client) — WPT does not hold your private keys.`,
  },
  {
    title: '12. Web Client Data',
    body: `The Web client does not use advertising trackers or third-party analytics cookies. Only data strictly necessary for the Service to function (session/link state) is stored locally in your browser.

Your encryption keys for the Web client are generated and stored locally in your browser rather than in dedicated secure hardware (unlike our mobile apps, which use your device’s built-in secure hardware where available). This is standard practice among browser-based encrypted messaging clients. We recommend keeping your browser and operating system up to date and avoiding use on shared or public computers.`,
  },
  {
    title: '13. Changes to This Policy',
    body: `We may update this Privacy Policy from time to time. Material changes will be notified in-app before taking effect.`,
  },
  {
    title: '14. Contact',
    body: `Placeholder — insert WPT’s privacy/data protection contact details once established.`,
  },
];

const SCROLL_END_THRESHOLD = 24;

export default function LegalAcceptanceScreen() {
  const [hasReadTerms, setHasReadTerms] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [viewportH, setViewportH] = useState(0);
  const [contentH, setContentH] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  // True until the durable-acceptance check settles, so a returning user never
  // sees the terms flash before being resumed into the app.
  const [resuming, setResuming] = useState(true);

  const goBack = useCallback(() => {
    router.back();
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      goBack();
      return true;
    });
    return () => sub.remove();
  }, [goBack]);

  // Acceptance is durable: a returning user must not be made to re-read the
  // terms on every launch, and a stored session must resume instead of being
  // dropped back on the login screen. The (tabs) gate re-checks both values,
  // so an expired session still lands on phone-entry.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!(await hasAcceptedLegal())) return;

        const userId = await SecureStore.getItemAsync('userId');
        if (!cancelled) router.replace(userId ? '/(tabs)' : '/phone-entry');
      } catch {
        // Storage unavailable — fall through and show the terms.
      } finally {
        if (!cancelled) setResuming(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleAgree = async () => {
    if (!hasReadTerms || isSaving) return;
    setIsSaving(true);
    try {
      await recordLegalAcceptance();
      router.push('/phone-entry');
    } catch {
      Alert.alert('Error', 'Could not save your acceptance. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
      if (
        layoutMeasurement.height + contentOffset.y >=
        contentSize.height - SCROLL_END_THRESHOLD
      ) {
        setHasReadTerms(true);
      }
    },
    []
  );

  const checkContentFits = useCallback((ch: number, vh: number) => {
    if (ch > 0 && vh > 0 && ch <= vh) setHasReadTerms(true);
  }, []);

  const toggleAccepted = () => {
    if (!hasReadTerms) return;
    setAccepted((prev) => !prev);
  };

  if (resuming) {
    return <View style={styles.root} />;
  }

  return (
    <View style={styles.root}>
      <View style={styles.top}>
        <Pressable
          onPress={goBack}
          style={styles.backBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={26} color={C.ink} />
        </Pressable>
      </View>

      <View style={styles.body}>
        <View style={styles.header}>
          <Text style={styles.title}>Before we continue</Text>
          <Text style={styles.sub}>
            Please review our Terms and Conditions and Privacy Policy to proceed.
          </Text>
        </View>

        <View style={styles.listHeader}>
          <Text style={styles.cardTitle}>Terms and Conditions & Privacy Policy</Text>
        </View>

        <ScrollView
          style={styles.termsScroll}
          contentContainerStyle={styles.termsContent}
          onScroll={handleScroll}
          onLayout={(e) => {
            const h = e.nativeEvent.layout.height;
            setViewportH(h);
            checkContentFits(contentH, h);
          }}
          onContentSizeChange={(_w, h) => {
            setContentH(h);
            checkContentFits(h, viewportH);
          }}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator
          indicatorStyle="white"
          nestedScrollEnabled
        >
          {LEGAL_SECTIONS.map((section) => (
            <View key={`${section.part ?? ''}${section.title}`} style={styles.section}>
              {section.part ? <Text style={styles.partTitle}>{section.part}</Text> : null}
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <Text style={styles.sectionBody}>{section.body}</Text>
            </View>
          ))}
          <Text style={styles.endMark}>
            - End of Terms and Conditions & Privacy Policy ({LEGAL_DOCUMENT_VERSION}) -
          </Text>
        </ScrollView>

        {!hasReadTerms ? (
          <Text style={styles.hint} accessibilityLiveRegion="polite">
            Scroll to the end of the Terms and Privacy Policy to continue.
          </Text>
        ) : null}

        <Pressable
          style={[styles.checkboxRow, !hasReadTerms && styles.checkboxLocked]}
          onPress={toggleAccepted}
          disabled={!hasReadTerms}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: accepted, disabled: !hasReadTerms }}
          hitSlop={8}
        >
          <View style={[styles.checkbox, accepted && styles.checkboxChecked]}>
            {accepted ? <Text style={styles.checkmark}>✓</Text> : null}
          </View>
          <Text style={styles.checkboxText}>
            I have read and accept the Terms & Conditions and Privacy Policy
          </Text>
        </Pressable>

        <View style={styles.bottomSection}>
          <Pressable
            style={[styles.btn, (!hasReadTerms || !accepted || isSaving) && styles.btnDisabled]}
            onPress={handleAgree}
            disabled={!hasReadTerms || !accepted || isSaving}
            accessibilityRole="button"
            accessibilityLabel="I agree, I am 16+"
            accessibilityState={{ disabled: !hasReadTerms || !accepted || isSaving }}
          >
            <Text style={styles.btnText}>I agree, I am 16+</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 56 : 32,
    paddingHorizontal: 8,
  },
  backBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    paddingHorizontal: 24,
  },
  header: {
    marginTop: 20,
  },
  title: {
    color: C.text,
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '700',
    fontFamily: Fonts.heading,
  },
  sub: {
    color: C.inkDim,
    fontSize: 15,
    lineHeight: 21,
    marginTop: 10,
    fontFamily: Fonts.body,
  },
  listHeader: {
    marginTop: 18,
    marginBottom: 10,
  },
  cardTitle: {
    color: C.text,
    fontSize: 15,
    fontWeight: '600',
    fontFamily: Fonts.bodyMedium,
  },
  termsScroll: {
    flex: 1,
  },
  termsContent: {
    paddingVertical: 4,
    paddingBottom: 8,
  },
  section: {
    marginBottom: 14,
  },
  partTitle: {
    color: C.text,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '700',
    marginTop: 6,
    marginBottom: 12,
    fontFamily: Fonts.heading,
  },
  sectionTitle: {
    color: C.accent,
    fontSize: 13.5,
    fontWeight: '700',
    marginBottom: 4,
    fontFamily: Fonts.bodyMedium,
  },
  sectionBody: {
    color: C.textDim,
    fontSize: 13,
    lineHeight: 19,
    fontFamily: Fonts.body,
  },
  endMark: {
    color: C.inkDim,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 2,
    fontFamily: Fonts.body,
  },
  hint: {
    marginTop: 12,
    color: C.inkDim,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: Fonts.body,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 18,
  },
  checkboxLocked: {
    opacity: 0.45,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: C.borderSoft,
    marginRight: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: C.accent,
    borderColor: C.accent,
  },
  checkmark: {
    color: C.bg,
    fontSize: 14,
    fontWeight: '700',
  },
  checkboxText: {
    flex: 1,
    color: C.textDim,
    fontSize: 14.5,
    lineHeight: 21,
    fontFamily: Fonts.body,
  },
  bottomSection: {
    paddingBottom: Platform.OS === 'ios' ? 48 : 32,
    paddingTop: 20,
  },
  btn: {
    backgroundColor: C.ink,
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
  },
  btnDisabled: {
    backgroundColor: C.disabled,
    opacity: 0.6,
  },
  btnText: {
    color: C.bg,
    fontWeight: '700',
    fontSize: 15,
    letterSpacing: 0.5,
    fontFamily: Fonts.bodyMedium,
  },
});