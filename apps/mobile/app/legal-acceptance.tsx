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
// web PDF (public/docs/WPT_Terms_of_Service_Privacy_Policy_v2.0.pdf)
// and the backend legalVersion recorded by /onboarding/accept-legal.
const LEGAL_DOCUMENT_VERSION = 'v2.0';

const LEGAL_SECTIONS: LegalSection[] = [
  {
    part: 'Part A - Terms and Conditions',
    title: '1. Introduction and Acceptance',
    body: `These Terms and Conditions (the "Terms") form a legally binding agreement between you and White Pixel Technologies ("WPT", "we", "us" or "our") governing your access to and use of Sealine (the "Service"), an end-to-end encrypted messaging application available on Android, iOS and Web.

By tapping the acceptance button during registration, or by otherwise accessing or using the Service, you confirm that you have read, understood and agree to be bound by these Terms and by our Privacy Policy, which is incorporated into these Terms by reference. If you do not agree, you must not create an account or use the Service.

We record the time at which you accept these Terms. The full Terms and Privacy Policy remain available to you at any time through the Settings section of the app.`,
  },
  {
    title: '2. Eligibility',
    body: `You must be at least 16 years old to use the Service. By accepting these Terms you confirm that you meet this requirement. If your local law sets a higher minimum age for entering into a binding agreement or for consenting to the processing of personal data, you must meet that higher age.

You must also be legally capable of entering into a binding agreement, must not be barred from using the Service under any applicable law, and must not have been previously banned from the Service.`,
  },
  {
    title: '3. Your Account',
    body: `3.1 Registration and Verification
Accounts are created using a mobile phone number verified by a one-time passcode (OTP). You agree to provide an accurate phone number that you own or are authorised to use, and to keep your profile information (name, profile picture and about text) accurate. A name and an about text are required for every account. OTP entry is limited to three attempts, after which input is locked for 30 seconds, and a new code may only be requested after a short cooldown. These limits exist to protect your account and may be adjusted from time to time.

3.2 Delivery of Verification Codes
Verification codes are delivered by SMS through infrastructure operated by or for us. Delivery depends on mobile networks and carriers outside our control, and we do not guarantee that any code will be delivered within a particular time or at all. Standard carrier charges from your mobile provider may apply.

3.3 One Active Phone Session
The Service does not support independent use on multiple phones. When you successfully verify your number on a new phone, any session on your previous phone and any active Web session are signed out automatically. The previous device is not notified and this action cannot be undone. You are responsible for ensuring that you want to move your account before logging in on a new device.

3.4 Web Access
The Web version can only be used after it has been linked to your account from your phone by scanning a QR code displayed in your browser. Once linked, the Web session operates independently of your phone until it is signed out, unlinked, or ended by a new phone login. You may view and unlink linked devices from within the app at any time. You are responsible for logging out of Web sessions on shared or public computers.

3.5 Account Security
You are responsible for maintaining the security of your phone number, your SIM card, your devices and any access to your messages through those devices. You are responsible for all activity that occurs under your account. If you believe your account has been accessed without your authorisation, you should notify us promptly. Because verification relies on your phone number, loss or transfer of that number may affect your ability to access your account, and there is no special account recovery process beyond completing standard verification on the number.

3.6 Changing Your Phone Number
You may change the phone number associated with your account by completing OTP verification on the new number. Your account history and contacts carry over once the change is completed.`,
  },
  {
    title: '4. The Service',
    body: `4.1 Core Features
The Service allows you to exchange one-to-one and group text messages, images, videos, documents and voice notes with other registered users, with read receipts, typing indicators, and online and last-seen status (each of which you may limit through your privacy settings where the app allows). Voice and video calls are not part of the Service at this time.

4.2 Limits
To maintain reliability and prevent abuse, the Service applies limits that currently include:
- A maximum message length of 65,536 characters.
- A maximum file size of 10 MB for images, 50 MB for videos and 20 MB for documents. Voice notes are automatically divided into separate messages when a recording reaches 1 MB.
- A maximum of 70 members per group.
- Rate limits on actions such as sending messages, creating groups, initiating new chats, syncing contacts and submitting reports, with stricter limits applying to newly created accounts.
We may change these limits at any time to protect the Service or its users.

4.3 Contact Discovery
If you grant access to your contacts, the Service uses a privacy-preserving matching process in which phone numbers are normalised and compared using hashed values, rather than uploading your contact list in readable form. You may decline contacts access and still start chats by entering a phone number manually. You may only start a chat with a number that belongs to a registered user. You are responsible for having the right to use the contact information you choose to match.

4.4 Permissions
The Service may request permission to access your contacts, notifications, microphone, camera, and photos or files. No single permission is required to use core messaging functionality, but some features will be unavailable without the relevant permission. You can change permissions at any time through your device settings.

4.5 Notifications
Push notifications never display message content. Notifications for one-to-one chats show only the sender, and notifications for groups show the sender and group name where this can be decrypted on your device in time, or a generic notice otherwise.

4.6 Early-Stage Service
The Service is a new product under active development. Features may be added, changed or removed, and the Service may experience interruptions, delays or defects. We do not provide any formal uptime commitment.`,
  },
  {
    title: '5. Encryption and Your Messages',
    body: `5.1 End-to-End Encryption
Messages, media, voice notes and group details (name, icon and description) are protected by end-to-end encryption using the Signal Protocol. This means that content is encrypted on the sender's device and can only be decrypted on the recipient's device. We cannot read the content of your messages, and we are technically unable to provide it to any third party, including in response to legal requests.

5.2 Delivery and Temporary Storage
Encrypted messages are held on our servers only as needed for delivery. Encrypted content that has been delivered is removed from our servers promptly after delivery, and encrypted messages that cannot be delivered because the recipient remains offline are held for up to 30 days, after which they are permanently deleted. Encrypted media is removed from our servers immediately after successful delivery. A message that is still only queued on your device when you log out is not sent.

5.3 Your Responsibility
Encryption protects the content of your conversations in transit and on our servers, but it cannot protect you from risks on your own device or from the people you communicate with. Anyone who receives a message can copy, screenshot, store or share it. Features such as "Delete for everyone" remove messages from the Service and from the participants' chat views on a best-efforts basis, but we cannot guarantee that a recipient has not already copied, saved or captured the content.

5.4 Local Backups
The Service allows you to export an encrypted backup of your chats to your own device, protected by a password that you choose. We do not store a copy of your backup or your password, and we cannot recover either of them. If you lose the password or the backup file, your backed-up data cannot be restored by us or by anyone else. We do not offer cloud backup of chat history.

5.5 Device Loss
Because message content is not stored on our servers after delivery, we cannot restore your message history if you lose, reset or replace your device without a local backup.`,
  },
  {
    title: '6. Acceptable Use',
    body: `You agree to use the Service lawfully and with respect for other users. You must not:
- Use the Service for any unlawful purpose or to promote or facilitate illegal activity.
- Send, share or store content that exploits or endangers children, or that depicts or promotes sexual abuse of minors.
- Harass, threaten, stalk, intimidate, defame or abuse any person, or incite violence or hatred against any person or group.
- Send unsolicited bulk, commercial or repetitive messages, run scams or phishing campaigns, or otherwise use the Service to deceive others.
- Distribute malware or any content intended to disrupt, damage or gain unauthorised access to any device, system or account.
- Impersonate any person or entity, or misrepresent your identity or affiliation.
- Share the personal information of others without their consent.
- Infringe the intellectual property, privacy or other rights of any person.
- Attempt to access another person's account, or the Service's systems, data or Admin Dashboard, without authorisation.
- Reverse engineer, decompile, scrape or interfere with the Service, bypass its security, rate limits or restrictions, or use automated means to create accounts or send messages.
- Create accounts through false or misleading means, or circumvent a restriction or ban by creating a new account.
- Use the Service in any way that could damage, overburden or impair it.
You are solely responsible for the content you send and for your conduct on the Service.`,
  },
  {
    title: '7. Groups',
    body: `Any user may create a group, subject to the group size limit and applicable rate limits. Each group has one Owner, who is the creator, and may have Admins. Only the Owner and Admins can add or remove members, and edit the group name, icon and description. The Owner and Admins may also restrict who can send messages to the group. The Owner's role is protected and can only be given up by the Owner voluntarily leaving the group.

If a group would be left without an Owner or Admin because of a departure, the longest-tenured remaining member is promoted automatically so that the group remains manageable. If you are the sole member and Owner of a group and you leave, the group is dissolved after your confirmation.

By joining a group, you understand that other members can see your name, profile picture, about text and messages in that group, and that group members you have blocked can still see and communicate in shared groups. Group Owners and Admins are responsible for the way they administer their groups. We do not manage or monitor the content of groups.`,
  },
  {
    title: '8. Blocking, Reporting and Moderation',
    body: `8.1 Blocking
You may block any user at any time. Blocking is mutual for one-to-one interactions: while a block is active, neither of you can message the other, and neither can see the other's online or last-seen status. The blocked user is not notified. Blocking does not remove either person from a shared group. You may unblock a user at any time from your list of blocked contacts.

8.2 Reporting
You may report a user or a group by selecting a reason for the report. Because we cannot access the content of encrypted conversations, the only way we can review reported content is if you choose to submit a report. When you submit a report, the Service sends to us the most recent messages in the conversation, being the last 20 messages or all messages from the previous 7 days, whichever is fewer, together with related metadata. The app explains this before you submit.

By submitting a report, you consent to this content being shared with us for review and understand that it will be decrypted for that purpose. Reported evidence is available only to authorised personnel through a restricted dashboard and is automatically deleted 30 days after submission. Submitting a knowingly false or abusive report is a breach of these Terms.

8.3 Our Actions
We do not proactively scan or monitor private messages. We review reports that are submitted to us and may take any of the following actions against an account at our discretion:
- Warning: a notice delivered to the user with no restriction on the account.
- Restriction: limits on the account, such as being unable to create new groups or start chats with new numbers, and tighter rate limits. Existing conversations are not affected.
- Ban: suspension of the account, which signs the user out of all devices and prevents future logins.
- Dismissal: closure of the report without action.
We are not obliged to give notice of the outcome of a report to the person who made it. There is currently no formal in-app appeals process. If you believe an action was taken against your account by mistake, you may contact us at the address in Section 17 and we may, at our discretion, review the matter.

8.4 Emergencies
The Service is not an emergency service and is not monitored in real time. If you or someone else is in immediate danger, contact your local emergency services.`,
  },
  {
    title: '9. Content and Licence',
    body: `You retain ownership of the content that you send through the Service. Because your messages are end-to-end encrypted, we do not have access to them and we do not claim any rights over them. You grant us a limited, non-exclusive, worldwide, royalty-free licence to transmit, temporarily store in encrypted form, and process your content solely as necessary to operate the Service and deliver it to your intended recipients, and, where you submit a report, to review the reported content in accordance with Section 8.

Your name, profile picture and about text are visible to other users as described in the Privacy Policy, and you grant us the right to display them within the Service for that purpose.`,
  },
  {
    title: '10. Intellectual Property',
    body: `The Service, including its software, design, visual identity, trademarks, logos and documentation, is owned by WPT or its licensors and is protected by intellectual property laws. Subject to these Terms, we grant you a personal, limited, non-exclusive, non-transferable, revocable licence to use the app for your own personal, non-commercial use on devices that you own or control. Parts of the Service make use of open-source software, which is licensed under the terms of the relevant open-source licences.

You must not copy, modify, distribute, sell, lease or create derivative works of the Service except as permitted by law or by these Terms. If you believe that content on the Service infringes your intellectual property rights, you may contact us as set out in Section 17, although we may be unable to review end-to-end encrypted content that has not been reported to us.`,
  },
  {
    title: '11. Privacy and Data Retention',
    body: `Our collection and use of personal data is described in our Privacy Policy. In summary, and subject to that policy:
- Message and media content: not retained on our servers after delivery; undelivered encrypted messages are held for up to 30 days.
- Reported content: up to 30 days from submission, then automatically deleted.
- Account and profile data: until you delete your account.
- Local backups: held only on your device, at your discretion.

If we are legally required to disclose information, we will disclose only what we are able and compelled to provide. Because we do not hold the content of your messages, this is expected to be limited to the account and technical information that we hold, such as the information described in the Privacy Policy.`,
  },
  {
    title: '12. Deleting Your Account',
    body: `You may delete your account at any time from the Settings section of the app, after reading the warning shown and typing the confirmation word requested. Account deletion is permanent. When you delete your account:
- Your account and profile data are deleted and any active Web session is signed out.
- You are removed from all groups, a system message is posted in each group, and the ownership rules in Section 7 apply where relevant.
- Messages that you previously sent and that were already delivered to other users remain on their devices, and we have no ability to remove content from other users' devices.
- Other users can still view their earlier conversations with you, but any new messages sent to your account will fail.
- The same phone number cannot be used to register a new account for 48 hours after deletion.
- Blocks and reports that are connected with your phone number continue to apply if you register again.
- Deleting your account does not cancel any pending report made about you, and does not prevent us from retaining reported content for the period in Section 8.
Because backups are stored only on your device, deleting your account does not delete your local backups.`,
  },
  {
    title: '13. Suspension and Termination',
    body: `You may stop using the Service at any time. We may suspend, restrict or terminate your access, with or without notice, if we reasonably believe that you have breached these Terms, that your use creates a risk of harm to other users, the Service or us, that you have been involved in unlawful activity, or if we are required to do so by law. We may also discontinue all or part of the Service. Where reasonably practicable and lawful, we will give you notice before discontinuing the Service as a whole.

Sections that by their nature should survive termination, including Sections 5.3, 9, 10, 14, 15, 16 and 17, will continue to apply after your access ends.`,
  },
  {
    title: '14. Disclaimers',
    body: `To the fullest extent permitted by applicable law, the Service is provided on an "as is" and "as available" basis, without warranties of any kind, whether express, implied or statutory, including warranties of merchantability, fitness for a particular purpose, non-infringement, accuracy, availability or uninterrupted operation.

Without limiting the above, we do not warrant that:
- the Service will be uninterrupted, timely, secure or error-free, or that messages or verification codes will be delivered successfully or within any particular time;
- the Service will meet your requirements, or that defects will be corrected;
- any content sent by other users is accurate, lawful or safe, and we are not responsible for the conduct of other users, whether online or offline; or
- the Service is free from all vulnerabilities, since no system can be guaranteed to be completely secure.
Nothing in these Terms excludes or limits any warranty or right that cannot be excluded or limited under the law that applies to you.`,
  },
  {
    title: '15. Limitation of Liability',
    body: `To the fullest extent permitted by applicable law, WPT and its founders, directors, officers, employees, interns, contractors and affiliates will not be liable for any indirect, incidental, special, consequential, exemplary or punitive damages, or for any loss of profits, revenue, data, goodwill or business opportunity, arising out of or related to your use of, or inability to use, the Service, even if we have been advised that such damages are possible.

To the fullest extent permitted by applicable law, our total aggregate liability to you for all claims arising out of or relating to the Service or these Terms will not exceed the greater of the amount you paid us for the Service in the twelve months before the claim arose, or [Liability Cap Amount]. Because the Service is currently provided free of charge, this amount may be nil or minimal.

Nothing in these Terms limits or excludes liability that cannot be limited or excluded by law, including liability for fraud, for death or personal injury caused by negligence, or for any other liability that applicable law does not allow to be excluded.`,
  },
  {
    title: '16. Indemnity',
    body: `To the extent permitted by law, you agree to indemnify and hold harmless WPT and its founders, directors, officers, employees, interns, contractors and affiliates from and against any claims, liabilities, damages, losses and expenses, including reasonable legal fees, arising out of or connected with your breach of these Terms, your content, your misuse of the Service, or your violation of any law or the rights of any third party.`,
  },
  {
    title: '17. Contact Us',
    body: `If you have questions about these Terms, wish to report a breach, or wish to raise a concern about an action taken on your account, please contact us:

White Pixel Technologies
Email: support@sealine.app
Address: [Registered Business Address]`,
  },
  {
    title: '18. Changes to These Terms',
    body: `We may update these Terms from time to time, for example to reflect changes to the Service, to our practices, or to legal requirements. When we make material changes we will notify you through the app or by other reasonable means, and the updated Terms will take effect on the date stated in the notice. Your continued use of the Service after the effective date of the updated Terms means that you accept them. If you do not agree to the updated Terms, you must stop using the Service and may delete your account.

We may introduce paid features or other forms of monetisation in the future. The Service is currently free of charge, and any such change will be communicated in advance and will not take effect without the updated Terms or additional terms being presented to you.`,
  },
  {
    title: '19. Governing Law and Dispute Resolution',
    body: `These Terms, and any dispute or claim arising out of or in connection with them or the Service, are governed by the laws of [Governing Law Jurisdiction], without regard to its conflict of law rules.

You and WPT agree to first try to resolve any dispute informally by contacting each other using the details in Section 17. If the dispute is not resolved within 30 days, it will be submitted to the exclusive jurisdiction of the courts of [Jurisdiction and City], except where mandatory consumer protection laws of your place of residence give you the right to bring proceedings in another court, in which case those rights are not affected.`,
  },
  {
    title: '20. General Provisions',
    body: `- Entire agreement: These Terms, together with the Privacy Policy, are the entire agreement between you and WPT regarding the Service and replace any earlier understanding on the same subject.
- Severability: If any provision of these Terms is found to be unenforceable, the remaining provisions will remain in full force and effect.
- No waiver: A failure or delay by us in enforcing any right or provision is not a waiver of that right or provision.
- Assignment: You may not assign or transfer your rights or obligations under these Terms without our written consent. We may assign our rights and obligations to an affiliate or to a successor to our business.
- Third-party services: The Service relies on third-party infrastructure and service providers. We are not responsible for the acts, omissions or outages of third-party providers.
- Compliance with law: You agree to comply with all laws that apply to your use of the Service, including laws relating to export controls, privacy and communications. The Service may not be available in every country, and we may change its availability at any time.
- Language: These Terms are provided in English. Any translation is provided for convenience only, and the English version will prevail if there is a conflict.
- Headings: Headings are provided for convenience only and do not affect the interpretation of these Terms.

By tapping the acceptance button, you confirm that you are at least 16 years old and that you have read and agree to these Terms and the Privacy Policy.`,
  },
  {
    part: 'Part B - Privacy Policy',
    title: '1. Introduction',
    body: `This Privacy Policy explains what data White Pixel Technologies ("WPT") collects through Sealine, why, and what rights you have over it. We have designed the Service around collecting as little as possible, consistent with its end-to-end encrypted design.`,
  },
  {
    title: '2. Data We Collect',
    body: `- Phone number: required for account creation and identification.
- Profile information: name (required), profile photo (optional), about/status text (has a default value, editable).
- Contact list matching: if you grant Contacts permission, your phone contacts are checked against our registered user database, using cryptographic hashing rather than uploading your raw contact list. Because phone numbers have a limited range of possible values, hashing provides strong but not absolute protection. It is a widely used, industry-standard technique for privacy-preserving contact discovery, though it does not offer the same guarantees as more advanced (and more resource-intensive) approaches some larger providers use. We consider this the right balance for the Service at its current stage and will revisit stronger techniques as the Service grows.
- Device and technical data: device type, OS version, app version, and connection metadata necessary for message delivery and troubleshooting.
- Message metadata: timestamps, sender/recipient identifiers, and delivery status, necessary to route encrypted messages. This does not include message content.
- Reported content: only when you submit a report (see Terms Section 8), and only from your own device's already-decrypted view.`,
  },
  {
    title: '3. Data We Do Not Collect',
    body: `- Message content: text, voice notes, photos, videos, and documents are end-to-end encrypted using the Signal Protocol. WPT cannot read this content in normal operation.
- We do not retain message or media content on our servers beyond active delivery (immediate deletion on delivery; 30-day maximum for undelivered messages).
- We do not use message content for advertising, profiling, or any automated analysis, because we cannot access it.`,
  },
  {
    title: '4. How We Use Data',
    body: `- To provide and operate the Service (account creation, message routing, contact discovery).
- To maintain security (e.g., detecting and preventing abuse, enforcing the reporting/enforcement process in Section 8 of the Terms).
- To communicate with you about your account (e.g., OTP codes, security notices such as new-device login alerts).
- We do not sell your personal data to third parties, and we do not use your data for third-party advertising.`,
  },
  {
    title: '5. Legal Bases for Processing (where applicable, e.g., under GDPR)',
    body: `- Contractual necessity: processing your phone number and account data to provide the Service you have signed up for.
- Legitimate interest: security, fraud prevention, and abuse reporting.
- Consent: where required, e.g., for optional permissions like Contacts, Notifications, Microphone, Camera, and Photos/Files access, all of which can be declined or revoked at any time.`,
  },
  {
    title: '6. Data Sharing',
    body: `- We do not sell personal data.
- Reported content (Section 8 of the Terms) is accessible only to WPT's internal review process.
- We may disclose data if legally compelled by a valid law enforcement request, to the extent we hold any relevant data (which, for message content, is limited to voluntarily reported content already described above).`,
  },
  {
    title: '7. Data Retention',
    body: `- Message/media content (server-side): deleted immediately on successful delivery; maximum 30 days if undelivered.
- Reported content (evidence): up to 30 days from submission, then deleted.
- Account/profile data: until account deletion.
- Deleted account / number reuse: 48-hour cooldown before the same number can register a new account.
- Local device backup (optional): stored at your own discretion, outside WPT's control; password-protected with no recovery if forgotten.`,
  },
  {
    title: '8. Your Rights',
    body: `Depending on your jurisdiction, you may have rights including:
- Access: request a copy of the personal data we hold about you.
- Rectification: correct inaccurate profile data directly in-app.
- Erasure: delete your account and associated data at any time via the app. Once deleted, this is permanent and cannot be recovered by WPT.
- Portability: export your local message history via the in-app encrypted backup feature.
- Objection/restriction: object to certain processing, e.g., by declining optional permissions.
- Non-discrimination (California residents, CCPA/CPRA): we will not deny you service for exercising your privacy rights.`,
  },
  {
    title: '9. International Data Transfers',
    body: `As a global service using managed free-tier infrastructure providers, your data may be processed in countries other than your own. The actual data-hosting regions and any appropriate transfer safeguards (e.g., GDPR Standard Contractual Clauses if EU user data is involved) will be confirmed as the infrastructure is finalised.`,
  },
  {
    title: "10. Children's Privacy",
    body: `The Service is not directed at children under 16. We do not knowingly collect data from children under this age. See Terms Section 2 regarding eligibility.`,
  },
  {
    title: '11. Security',
    body: `We use the Signal Protocol to provide end-to-end encryption for message content. Encryption keys are generated and stored on your device (and, for Web, in your browser client). WPT does not hold your private keys.`,
  },
  {
    title: '12. Web Client Data',
    body: `The Web client does not use advertising trackers or third-party analytics cookies. Only data strictly necessary for the Service to function (session/link state) is stored locally in your browser.

Your encryption keys for the Web client are generated and stored locally in your browser rather than in dedicated secure hardware (unlike our mobile apps, which use your device's built-in secure hardware where available). This is standard practice among browser-based encrypted messaging clients. We recommend keeping your browser and operating system up to date and avoiding use on shared or public computers.`,
  },
  {
    title: '13. Changes to This Policy',
    body: `We may update this Privacy Policy from time to time. Material changes will be notified in-app before taking effect.`,
  },
  {
    title: '14. Contact',
    body: `WPT's privacy and data protection contact details will be published once established. Under GDPR, a Data Protection Officer or equivalent contact point may be required depending on processing scale.`,
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