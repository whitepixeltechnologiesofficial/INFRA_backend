import type { KeyPair } from "./primitives.js";
import {
  generateIdentityKeyPair,
  sign,
  verify,
  deriveKeys,
  aeadEncrypt,
  aeadDecrypt,
  randomNonce,
} from "./primitives.js";


/**
 * Sender Key — group messaging efficiency layer on top of pairwise
 * Double Ratchet sessions (each sender distributes one symmetric chain
 * key to the group instead of ratcheting per-recipient per-message).
 *
 * DESIGN NOTES (flag for review):
 * - `signingKeyPair.privateKey` is optional: your OWN state (the one you
 *   encrypt with) has it; everyone else's copy of your sender key (built
 *   via receiveSenderKeyDistribution) only ever has your public signing
 *   key, never your private one.
 * - Signing exists because ALL group members share the same chain key —
 *   without a signature, any member could forge a message and it would
 *   look like it came from someone else. The signature is what proves
 *   authorship.
 * - Added skippedMessageKeys + MAX_SKIP (same pattern as double-ratchet.ts)
 *   so out-of-order group message delivery doesn't break decryption.
 * - Added receiveSenderKeyDistribution(), missing from the original
 *   scaffold — without it there's no way to turn an incoming
 *   SenderKeyDistributionMessage into usable state.
 * - Changed senderKeyEncrypt/Decrypt to pass a structured SenderKeyMessage
 *   (iteration + ciphertext + nonce + signature) instead of a bare
 *   Uint8Array — AEAD can't decrypt without its nonce, and there's no way
 *   to verify authorship without iteration + signature travelling with it.
 * - The DistributionMessage itself is assumed to be sent over an existing
 *   pairwise Double Ratchet session (already encrypted), per standard
 *   Sender Key design — this file doesn't re-encrypt it.
 */

export interface SenderKeyState {
  chainKey: Uint8Array;
  signingKeyPair: { publicKey: Uint8Array; privateKey?: Uint8Array };
  iteration: number;
  skippedMessageKeys: Map<string, Uint8Array>;
}

export interface SenderKeyDistributionMessage {
  chainKey: Uint8Array;
  signingPublicKey: Uint8Array;
  iteration: number;
}

export interface SenderKeyMessage {
  iteration: number;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  signature: Uint8Array;
}

const CHAIN_INFO = "WPT-SK-chain";
const MESSAGE_INFO = "WPT-SK-msg";
const KEY_LENGTH = 32;
const MAX_SKIP = 1000;

function kdfChainKey(chainKey: Uint8Array): { chainKey: Uint8Array; messageKey: Uint8Array } {
  return {
    chainKey: deriveKeys(chainKey, CHAIN_INFO, KEY_LENGTH),
    messageKey: deriveKeys(chainKey, MESSAGE_INFO, KEY_LENGTH),
  };
}

/** Binds ciphertext + nonce + iteration together so a signature can't be replayed onto a different message. */
function signingPayload(ciphertext: Uint8Array, nonce: Uint8Array, iteration: number): Uint8Array {
  const iterBytes = new Uint8Array(4);
  new DataView(iterBytes.buffer).setUint32(0, iteration, false);
  const out = new Uint8Array(ciphertext.length + nonce.length + iterBytes.length);
  out.set(ciphertext, 0);
  out.set(nonce, ciphertext.length);
  out.set(iterBytes, ciphertext.length + nonce.length);
  return out;
}

/** Call this once per group you're in, to create YOUR sender key before distributing it. */
export function createSenderKey(): SenderKeyState {
  const signingKeyPair: KeyPair = generateIdentityKeyPair();
  const chainKey = randomNonce(KEY_LENGTH); // 32 random bytes; randomNonce is just randomBytes under a nonce-flavored name

  return {
    chainKey,
    signingKeyPair,
    iteration: 0,
    skippedMessageKeys: new Map(),
  };
}

/** Package your current sender key to send to other group members (over an existing pairwise session). */
export function distributeSenderKey(state: SenderKeyState): SenderKeyDistributionMessage {
  return {
    chainKey: state.chainKey,
    signingPublicKey: state.signingKeyPair.publicKey,
    iteration: state.iteration,
  };
}

/** Call this when YOU receive someone else's distribution message, to start tracking their sender key. */
export function receiveSenderKeyDistribution(message: SenderKeyDistributionMessage): SenderKeyState {
  return {
    chainKey: message.chainKey,
    signingKeyPair: { publicKey: message.signingPublicKey }, // no privateKey — this isn't ours
    iteration: message.iteration,
    skippedMessageKeys: new Map(),
  };
}

export function senderKeyEncrypt(
  state: SenderKeyState,
  plaintext: Uint8Array,
): { state: SenderKeyState; message: SenderKeyMessage } {
  if (!state.signingKeyPair.privateKey) {
    throw new Error("senderKeyEncrypt: no private signing key — this isn't your own sender key");
  }

  const { chainKey, messageKey } = kdfChainKey(state.chainKey);
  const nonce = randomNonce();
  const ciphertext = aeadEncrypt(messageKey, nonce, plaintext);
  const signature = sign(state.signingKeyPair.privateKey, signingPayload(ciphertext, nonce, state.iteration));

  const message: SenderKeyMessage = { iteration: state.iteration, ciphertext, nonce, signature };
  const newState: SenderKeyState = { ...state, chainKey, iteration: state.iteration + 1 };

  return { state: newState, message };
}

export function senderKeyDecrypt(
  state: SenderKeyState,
  message: SenderKeyMessage,
): { state: SenderKeyState; plaintext: Uint8Array } {
  const signatureValid = verify(
    state.signingKeyPair.publicKey,
    signingPayload(message.ciphertext, message.nonce, message.iteration),
    message.signature,
  );
  if (!signatureValid) {
    throw new Error("senderKeyDecrypt: signature verification failed — possible forgery");
  }

  const id = String(message.iteration);
  const skippedKey = state.skippedMessageKeys.get(id);
  if (skippedKey) {
    const plaintext = aeadDecrypt(skippedKey, message.nonce, message.ciphertext);
    const newSkipped = new Map(state.skippedMessageKeys);
    newSkipped.delete(id);
    return { state: { ...state, skippedMessageKeys: newSkipped }, plaintext };
  }

  if (message.iteration < state.iteration) {
    throw new Error("senderKeyDecrypt: message key already consumed (replay or duplicate)");
  }

  if (message.iteration - state.iteration > MAX_SKIP) {
    throw new Error("senderKeyDecrypt: too many skipped messages (possible attack)");
  }

  let chainKey = state.chainKey;
  let iteration = state.iteration;
  const newSkipped = new Map(state.skippedMessageKeys);

  while (iteration < message.iteration) {
    const stepped = kdfChainKey(chainKey);
    newSkipped.set(String(iteration), stepped.messageKey);
    chainKey = stepped.chainKey;
    iteration += 1;
  }

  const { chainKey: nextChainKey, messageKey } = kdfChainKey(chainKey);
  const plaintext = aeadDecrypt(messageKey, message.nonce, message.ciphertext);

  const newState: SenderKeyState = {
    ...state,
    chainKey: nextChainKey,
    iteration: iteration + 1,
    skippedMessageKeys: newSkipped,
  };

  return { state: newState, plaintext };
}