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