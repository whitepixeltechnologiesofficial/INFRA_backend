export interface ServerUser {
  id: string;
  name: string;
  role: string;
}

export interface ServerSentMessage {
  id: string | number;
  from: string;
  text: string;
  time: string;
  demo?: boolean;
  mKind?: "text" | "image" | "voice" | string;
  attachmentId?: string | number;
  mimeType?: string;
  sizeBytes?: number;
  durationSec?: number;
}

export interface ServerChatSummaryItem {
  type: "direct" | "group";
  id: string;
  name: string;
  preview: string;
  time: string;
  online: boolean;
}

export interface ServerRecentChats {
  items: ServerChatSummaryItem[];
}

export interface ServerGroupSettings {
  membersCanMessage: boolean;
  membersCanAdd: boolean;
}

export interface ServerGroup {
  id: string;
  name: string;
  description: string;
  memberIds: string[];
  settings: ServerGroupSettings;
  members: ServerUser[];
}