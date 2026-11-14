import { createOutbox, type WptOutboxApi } from "../../lib/wptOutbox.js";

export type { WptOutboxApi } from "../../lib/wptOutbox.js";

export const OUTBOX_KEY = "wpt_web_outbox_v1";
export const OUTBOX_MAX_TRIES = 5;
export const OUTBOX_RETRY_MS = 4000;

// localStorage-backed outbox. The module pair wholesale (lib/wptOutbox.js) is
// UMD so the same contract is loadable both by the browser and by Node
// verification harnesses.
function readOutbox(): unknown {
  try {
    const raw = window.localStorage.getItem(OUTBOX_KEY);
    return raw ? (JSON.parse(raw) as unknown) : [];
  } catch (err) {
    console.warn("Outbox could not be read.", err);
    return [];
  }
}

function writeOutbox(list: unknown): void {
  try {
    window.localStorage.setItem(OUTBOX_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn("Outbox could not be written.", err);
  }
}

export function createLocalOutbox(): WptOutboxApi {
  return createOutbox(readOutbox, writeOutbox);
}

export function clearOutboxStorage(): void {
  try {
    window.localStorage.removeItem(OUTBOX_KEY);
  } catch (err) {
    console.warn("Outbox could not be cleared.", err);
  }
}