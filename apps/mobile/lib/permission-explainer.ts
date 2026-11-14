// lib/permission-explainer.ts
//
// PERM-2.1 — the static copy for the permissions explainer. Kept free of
// React Native so the order/coverage contract is checked in Node.

import type { PermissionKey } from './permission-sequence';

export interface ExplainerItem {
  key: PermissionKey;
  title: string;
  reason: string;
  icon: string;
}

export const EXPLAINER_ITEMS: readonly ExplainerItem[] = [
  {
    key: 'contacts',
    title: 'Contacts',
    reason: 'Find friends already on the app. Numbers are hashed on your phone and never uploaded.',
    icon: 'people-outline',
  },
  {
    key: 'notifications',
    title: 'Notifications',
    reason: 'Get alerted about new messages when the app is closed.',
    icon: 'notifications-outline',
  },
  {
    key: 'microphone',
    title: 'Microphone',
    reason: 'Record and send voice notes.',
    icon: 'mic-outline',
  },
  {
    key: 'camera',
    title: 'Camera',
    reason: 'Take a photo from inside a chat and send it.',
    icon: 'camera-outline',
  },
  {
    key: 'photos',
    title: 'Photos & Files',
    reason: 'Attach photos you already have.',
    icon: 'images-outline',
  },
];
