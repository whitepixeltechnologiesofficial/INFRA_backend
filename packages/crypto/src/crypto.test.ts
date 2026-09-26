/**
 * BE-5.1 Test: Crypto primitives round-trip verification.
 *
 * Verifies the newly-implemented X3DH, Double Ratchet, and Sender Key
 * protocols in packages/crypto/src/ actually produce matching keys and
 * correctly encrypt/decrypt across two (or more) independent parties —
 * not just that the code compiles.
 */

import { generateX25519KeyPair, generateIdentityKeyPair } from "./primitives.js";
import { generatePreKeyBundle, initiateSession, respondToSession } from "./x3dh.js";
import { initRatchet, ratchetEncrypt, ratchetDecrypt } from "./double-ratchet.js";
import {
  createSenderKey,
  distributeSenderKey,
  receiveSenderKeyDistribution,
  senderKeyEncrypt,
  senderKeyDecrypt,
} from "./sender-key.js";

console.log("=".repeat(70));
console.log("BE-5.1: Crypto Primitives Round-Trip Test");
console.log("=".repeat(70));
console.log();

let allTestsPass = true;

function check(label: string, passed: boolean) {
  console.log(`${passed ? "✅ PASS" : "❌ FAIL"}  ${label}`);
  if (!passed) allTestsPass = false;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function textEqual(plaintext: Uint8Array, expected: string): boolean {
  return new TextDecoder().decode(plaintext) === expected;
}

// ---------------------------------------------------------------------
// Test 1: X3DH — Alice and Bob derive the same root key
// ---------------------------------------------------------------------
console.log("Test 1: X3DH key agreement");
console.log("-".repeat(70));

const aliceIK = generateX25519KeyPair();
const bobIK = generateX25519KeyPair();
const bobSigning = generateIdentityKeyPair();

const { bundle: bobBundle, signedPreKeyPair: bobSPK, oneTimePreKeyPair: bobOPK } =
  generatePreKeyBundle(bobIK, bobSigning);

const { sessionKeys: aliceKeys, ephemeralKeyPair: aliceEphemeral } = initiateSession(aliceIK, bobBundle);

const bobKeys = respondToSession(bobIK, bobSPK, aliceIK.publicKey, aliceEphemeral.publicKey, bobOPK);

check("Alice and Bob derive identical root keys", bytesEqual(aliceKeys.rootKey, bobKeys.rootKey));
check("Alice and Bob derive identical associated data", bytesEqual(aliceKeys.associatedData, bobKeys.associatedData));

// Tampered signature should be rejected
console.log();
console.log("Test 1b: X3DH rejects a tampered signed prekey signature");
console.log("-".repeat(70));
const tamperedBundle = { ...bobBundle, signedPreKeySignature: generateX25519KeyPair().publicKey };
let rejectedTamperedSig = false;
try {
  initiateSession(aliceIK, tamperedBundle);
} catch {
  rejectedTamperedSig = true;
}
check("Tampered SPK signature throws", rejectedTamperedSig);
console.log();

// ---------------------------------------------------------------------
// Test 2: Double Ratchet — in-order messages, both directions
// ---------------------------------------------------------------------
console.log("Test 2: Double Ratchet — in-order round trip");
console.log("-".repeat(70));

let aliceState = initRatchet(aliceKeys.rootKey, true, { theirRatchetKey: bobBundle.signedPreKey });
let bobState = initRatchet(bobKeys.rootKey, false, { ourSignedPreKeyPair: bobSPK });

const msg1Plain = new TextEncoder().encode("hello bob");
const enc1 = ratchetEncrypt(aliceState, msg1Plain);
aliceState = enc1.state;
const dec1 = ratchetDecrypt(bobState, enc1.message);
bobState = dec1.state;
check("Bob decrypts Alice's first message correctly", textEqual(dec1.plaintext, "hello bob"));

const msg2Plain = new TextEncoder().encode("hi alice, got it");
const enc2 = ratchetEncrypt(bobState, msg2Plain);
bobState = enc2.state;
const dec2 = ratchetDecrypt(aliceState, enc2.message);
aliceState = dec2.state;
check("Alice decrypts Bob's reply correctly (DH ratchet step)", textEqual(dec2.plaintext, "hi alice, got it"));

console.log();
console.log("Test 2b: Double Ratchet — out-of-order delivery (skipped keys)");
console.log("-".repeat(70));

const aMsg1 = ratchetEncrypt(aliceState, new TextEncoder().encode("msg A"));
aliceState = aMsg1.state;
const aMsg2 = ratchetEncrypt(aliceState, new TextEncoder().encode("msg B"));
aliceState = aMsg2.state;
const aMsg3 = ratchetEncrypt(aliceState, new TextEncoder().encode("msg C"));
aliceState = aMsg3.state;

// Bob receives msg C first, then msg A, then msg B — out of order
const decC = ratchetDecrypt(bobState, aMsg3.message);
bobState = decC.state;
check("Out-of-order: msg C decrypts correctly", textEqual(decC.plaintext, "msg C"));

const decA = ratchetDecrypt(bobState, aMsg1.message);
bobState = decA.state;
check("Out-of-order: msg A decrypts correctly (from skipped-key store)", textEqual(decA.plaintext, "msg A"));

const decB = ratchetDecrypt(bobState, aMsg2.message);
bobState = decB.state;
check("Out-of-order: msg B decrypts correctly (from skipped-key store)", textEqual(decB.plaintext, "msg B"));
console.log();

// ---------------------------------------------------------------------
// Test 3: Sender Key — group messaging
// ---------------------------------------------------------------------
console.log("Test 3: Sender Key — group round trip (3 members)");
console.log("-".repeat(70));

// Alice creates a sender key and distributes it to Bob and Carol
let aliceSenderKey = createSenderKey();
const distribution = distributeSenderKey(aliceSenderKey);

let bobCopyOfAlice = receiveSenderKeyDistribution(distribution);
let carolCopyOfAlice = receiveSenderKeyDistribution(distribution);

const groupMsg1 = new TextEncoder().encode("hey group, it's alice");
const senderEnc1 = senderKeyEncrypt(aliceSenderKey, groupMsg1);
aliceSenderKey = senderEnc1.state;

const bobDec1 = senderKeyDecrypt(bobCopyOfAlice, senderEnc1.message);
bobCopyOfAlice = bobDec1.state;
check("Bob decrypts Alice's group message", textEqual(bobDec1.plaintext, "hey group, it's alice"));

const carolDec1 = senderKeyDecrypt(carolCopyOfAlice, senderEnc1.message);
carolCopyOfAlice = carolDec1.state;
check("Carol decrypts Alice's group message", textEqual(carolDec1.plaintext, "hey group, it's alice"));

// Second message, chain should have advanced correctly for everyone
const groupMsg2 = new TextEncoder().encode("second message");
const senderEnc2 = senderKeyEncrypt(aliceSenderKey, groupMsg2);
aliceSenderKey = senderEnc2.state;
const bobDec2 = senderKeyDecrypt(bobCopyOfAlice, senderEnc2.message);
check("Bob decrypts Alice's second group message (chain advanced)", textEqual(bobDec2.plaintext, "second message"));

console.log();
console.log("Test 3b: Sender Key rejects a forged/tampered message");
console.log("-".repeat(70));

const forged = { ...senderEnc1.message, ciphertext: senderEnc2.message.ciphertext };
let rejectedForgery = false;
try {
  senderKeyDecrypt(bobCopyOfAlice, forged);
} catch {
  rejectedForgery = true;
}
check("Tampered ciphertext with mismatched signature is rejected", rejectedForgery);
console.log();

// ---------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------
console.log("=".repeat(70));
console.log("SUMMARY");
console.log("=".repeat(70));

if (allTestsPass) {
  console.log("✅ ALL TESTS PASS — BE-5.1 crypto primitives verified");
  process.exit(0);
} else {
  console.log("❌ SOME TESTS FAILED — see above");
  process.exit(1);
}