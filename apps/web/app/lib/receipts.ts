// Read receipts — a pure four-state machine for a message's delivery status,
// mirrored on the mobile four-state spec:
//
//     sent -> delivered -> read      (plus the terminal `failed` state)
//
// `sent` is the optimistic bubble; `echo` (relay accepted) moves it to
// `delivered`; a read-receipt broadcast moves it to `read`; a rejection (relay
// refused / outbox exhausted) is terminal `failed`. Nothing ever downgrades.
// This module is deliberately self-contained with erasable-only syntax so Node
// harnesses import it directly with type stripping.

export type ReceiptStatus = "sent" | "delivered" | "failed" | "read";

export type ReceiptEvent = "echo" | "rejected" | "read";

export const RECEIPT_STATUSES: readonly ReceiptStatus[] = ["sent", "delivered", "failed", "read"];

export const RECEIPT_EVENTS: readonly ReceiptEvent[] = ["echo", "rejected", "read"];

export function isReceiptStatus(value: unknown): value is ReceiptStatus {
  return value === "sent" || value === "delivered" || value === "failed" || value === "read";
}

// Four-state transition. Rules:
//   - `failed` is terminal; nothing can leave it.
//   - `rejected` -> failed (from sent, delivered or read-unknown active states).
//   - `echo` -> delivered only from sent; any later state is kept.
//   - `read` -> read only from sent/delivered; failed stays failed.
export function nextMessageStatus(current: ReceiptStatus | null | undefined, event: ReceiptEvent): ReceiptStatus {
  if (current === "failed") return "failed";
  if (event === "rejected") return "failed";
  if (event === "echo") return current === "sent" ? "delivered" : current ?? "sent";
  if (event === "read") return current === "sent" || current === "delivered" ? "read" : current ?? "read";
  return current ?? "sent";
}

export interface ReceiptItem {
  id: string;
  from: string;
  status?: string;
}

// Apply a read receipt to a history slice: message ids the peer has now read.
// Only the reader's peer (my own outbound) messages elevate, so a broadcast
// that echoes back to the reader never touches their own incoming messages.
// Mutates the input list in place (the app-state arrays are mutable by design)
// and returns how many messages changed.
export function applyReadReceipt(list: readonly ReceiptItem[], messageIds: readonly string[], meId: string): number {
  const ids = new Set(messageIds.map(String));
  let changed = 0;
  for (const m of list) {
    if (m.from !== meId || !ids.has(String(m.id))) continue;
    const next = nextMessageStatus(isReceiptStatus(m.status) ? m.status : null, "read");
    if (next !== m.status) {
      m.status = next;
      changed += 1;
    }
  }
  return changed;
}

// The read-receipt wire body for POST /api/messages/read. Direct chats carry
// the peer id as `to`; group chats carry the group id. `messageId` is the
// furthest message the reader now has read (the server reads-through to it).
export function buildReadRequest(p: { from: string; isGroup: boolean; to?: string | null; groupId?: string | null; messageId: string }): Record<string, unknown> {
  if (p.isGroup) {
    return { from: p.from, type: "group", groupId: p.groupId ?? undefined, messageId: String(p.messageId) };
  }
  return { from: p.from, type: "direct", to: p.to ?? undefined, messageId: String(p.messageId) };
}

// The last message in a thread that I did not write — the read-through point
// to report when I open a chat. Never reports my own messages as "read by me".
export function lastPeerMessage(list: readonly ReceiptItem[], meId: string): ReceiptItem | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (item && item.from !== meId) return item;
  }
  return null;
}