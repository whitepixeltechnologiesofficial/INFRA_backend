export const MAX_TEXT_LENGTH = 65536;
export const MAX_TEXT_CIPHERTEXT_BYTES = 266240; // 65,536 chars x 4 bytes + 4,096 margin
export const MAX_TEXT_CIPHERTEXT_HEX = MAX_TEXT_CIPHERTEXT_BYTES * 2; // 532,480

/** Counts characters the way a user sees them (an emoji counts as 1). */
export function countChars(text: string): number {
  return Array.from(text).length;
}