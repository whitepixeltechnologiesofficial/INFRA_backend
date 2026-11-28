import { strict as assert } from "node:assert";
import { MAX_TEXT_LENGTH, MAX_TEXT_CIPHERTEXT_HEX, countChars } from "@wpt/shared";
import { isOversizedTextCiphertext, isValidHexCiphertext, maxCiphertextHex } from "./relay.js";

let pass = 0;
let fail = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (err) {
    console.log(`  FAIL  ${name} -> ${(err as Error).message}`);
    fail++;
  }
}

console.log("BE-5.4 limits");

check("constants match the agreed numbers", () => {
  assert.equal(MAX_TEXT_LENGTH, 65536);
  assert.equal(MAX_TEXT_CIPHERTEXT_HEX, 532480);
});

check("text ciphertext of exactly 532,480 hex chars is not oversized", () => {
  assert.equal(isOversizedTextCiphertext("a".repeat(532480), "text"), false);
});

check("text ciphertext of 532,482 hex chars is oversized (413)", () => {
  assert.equal(isOversizedTextCiphertext("a".repeat(532482), "text"), true);
});

check("non-text types are never reported as oversized-text", () => {
  assert.equal(isOversizedTextCiphertext("a".repeat(532482), "image"), false);
});

check("text cap lets 532,480 valid hex chars through", () => {
  assert.equal(isValidHexCiphertext("ab".repeat(266240), maxCiphertextHex("text")), true);
});

check("non-text types keep the old 200,000 cap", () => {
  assert.equal(maxCiphertextHex("image"), 200_000);
  assert.equal(isValidHexCiphertext("ab".repeat(100_001), maxCiphertextHex("image")), false);
  assert.equal(isValidHexCiphertext("ab".repeat(100_000), maxCiphertextHex("image")), true);
});

check("default cap (no argument) is still 200,000", () => {
  assert.equal(isValidHexCiphertext("ab".repeat(100_001)), false);
});

check("bad hex is still rejected", () => {
  assert.equal(isValidHexCiphertext("zz", maxCiphertextHex("text")), false);
  assert.equal(isValidHexCiphertext("abc", maxCiphertextHex("text")), false);
  assert.equal(isValidHexCiphertext("", maxCiphertextHex("text")), false);
});

check("countChars: 65,536 plain characters = 65,536", () => {
  assert.equal(countChars("a".repeat(65536)), 65536);
});

check("countChars: 65,536 emoji = 65,536 (not 131,072)", () => {
  assert.equal(countChars("😀".repeat(65536)), 65536);
});

check("countChars: 65,537 characters = 65,537 (over the limit)", () => {
  assert.equal(countChars("a".repeat(65537)), 65537);
  assert.ok(countChars("a".repeat(65537)) > MAX_TEXT_LENGTH);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);