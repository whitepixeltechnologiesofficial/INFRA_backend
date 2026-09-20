export interface OutboxEntry {
  id: string;
  chatId: string | null;
  tmpId: string | null;
  from: string | null;
  to: string | null;
  text: string;
  status: "pending" | "failed";
  attempts: number;
  queuedAt: number;
}

export interface WptOutboxApi {
  enqueue(entry: Partial<OutboxEntry> & { id: string }): OutboxEntry | null;
  all(): OutboxEntry[];
  pending(): OutboxEntry[];
  failed(): OutboxEntry[];
  byId(id: string): OutboxEntry | null;
  markSent(id: string): void;
  markFailed(id: string): void;
  retry(id: string): void;
  count(): { pending: number; failed: number };
  clear(): void;
}

export function createOutbox(load: () => unknown, save: (list: OutboxEntry[]) => void): WptOutboxApi;