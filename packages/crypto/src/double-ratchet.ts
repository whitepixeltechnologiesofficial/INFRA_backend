import type { KeyPair } from "./primitives.js";
import {
  generateX25519KeyPair,
  diffieHellman,
  deriveKeys,
  aeadEncrypt,
  aeadDecrypt,
  randomNonce,
} from "./primitives.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Double Ratchet — per-message forward secrecy + post-compromise security
 * for an established 1:1 session (output of x3dh.ts).
 *
 * DESIGN NOTES (flag for review):
 * - Uses one AEAD key per message (ChaCha20-Poly1305 from primitives.ts)
 *   rather than Signal's original separate encrypt+MAC keys — AEAD already
 *   gives integrity, so a second MAC key would be redundant.
 * - RatchetState now stores the *full* sending keypair (private + public),
 *   not just a public key — the ratchet needs the private half to do DH.
 * - Added `previousChainLength` to the message header (spec-required: lets
 *   the receiver know how many messages were in the sender's prior chain).
 * - Added `nonce` to RatchetMessage — AEAD decryption is impossible
 *   without the nonce used to encrypt, so it must travel with the message.
 */

export interface RatchetState {
  rootKey: Uint8Array;
  sendingChainKey?: Uint8Array;
  receivingChainKey?: Uint8Array;
  sendingRatchetKeyPair: KeyPair;
  receivingRatchetKey?: Uint8Array;
  sendMessageNumber: number;
  receiveMessageNumber: number;
  previousChainLength: number;
  skippedMessageKeys: Map<string, Uint8Array>;
}

export interface RatchetMessage {
  header: {
    ratchetKey: Uint8Array;
    messageNumber: number;
    previousChainLength: number;
  };
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

const ROOT_INFO = "WPT-DR-root";
const CHAIN_INFO = "WPT-DR-chain";
const MESSAGE_INFO = "WPT-DR-msg";
const KEY_LENGTH = 32;
const MAX_SKIP = 1000; // cap stored skipped-message keys to avoid unbounded memory (DoS guard)

function kdfRootKey(rootKey: Uint8Array, dhOutput: Uint8Array): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const output = deriveKeys(dhOutput, ROOT_INFO, KEY_LENGTH * 2, rootKey);
  return { rootKey: output.slice(0, KEY_LENGTH), chainKey: output.slice(KEY_LENGTH, KEY_LENGTH * 2) };
}

function kdfChainKey(chainKey: Uint8Array): { chainKey: Uint8Array; messageKey: Uint8Array } {
  return {
    chainKey: deriveKeys(chainKey, CHAIN_INFO, KEY_LENGTH),
    messageKey: deriveKeys(chainKey, MESSAGE_INFO, KEY_LENGTH),
  };
}

/**
 * Sets up ratchet state right after X3DH finishes.
 * - Alice (isInitiator=true) must pass theirRatchetKey: Bob's SPK public key.
 * - Bob (isInitiator=false) must pass ourSignedPreKeyPair: his own SPK keypair
 *   from x3dh.ts's generatePreKeyBundle — he reuses it, he does NOT generate
 *   a new one here.
 */
export function initRatchet(
  rootKey: Uint8Array,
  isInitiator: boolean,
  options: { theirRatchetKey?: Uint8Array; ourSignedPreKeyPair?: KeyPair } = {},
): RatchetState {
  if (isInitiator) {
    if (!options.theirRatchetKey) {
      throw new Error("initRatchet: initiator requires theirRatchetKey (the responder's SPK public key)");
    }
    const sendingRatchetKeyPair = generateX25519KeyPair();
    const dhOutput = diffieHellman(sendingRatchetKeyPair.privateKey, options.theirRatchetKey);
    const { rootKey: newRootKey, chainKey } = kdfRootKey(rootKey, dhOutput);

    return {
      rootKey: newRootKey,
      sendingChainKey: chainKey,
      sendingRatchetKeyPair,
      receivingRatchetKey: options.theirRatchetKey,
      sendMessageNumber: 0,
      receiveMessageNumber: 0,
      previousChainLength: 0,
      skippedMessageKeys: new Map(),
    };
  }

  if (!options.ourSignedPreKeyPair) {
    throw new Error("initRatchet: responder requires ourSignedPreKeyPair (their own SPK keypair from X3DH)");
  }
  return {
    rootKey,
    sendingRatchetKeyPair: options.ourSignedPreKeyPair,
    sendMessageNumber: 0,
    receiveMessageNumber: 0,
    previousChainLength: 0,
    skippedMessageKeys: new Map(),
  };
}

export function ratchetEncrypt(
  state: RatchetState,
  plaintext: Uint8Array,
): { state: RatchetState; message: RatchetMessage } {
  if (!state.sendingChainKey) {
    throw new Error("ratchetEncrypt: no sending chain established yet");
  }

  const { chainKey, messageKey } = kdfChainKey(state.sendingChainKey);
  const nonce = randomNonce();
  const header = {
    ratchetKey: state.sendingRatchetKeyPair.publicKey,
    messageNumber: state.sendMessageNumber,
    previousChainLength: state.previousChainLength,
  };
  const ciphertext = aeadEncrypt(messageKey, nonce, plaintext);

  const newState: RatchetState = {
    ...state,
    sendingChainKey: chainKey,
    sendMessageNumber: state.sendMessageNumber + 1,
  };

  return { state: newState, message: { header, ciphertext, nonce } };
}

export function ratchetDecrypt(
  state: RatchetState,
  message: RatchetMessage,
): { state: RatchetState; plaintext: Uint8Array } {
  const id = skippedKeyId(message.header.ratchetKey, message.header.messageNumber);
  const skippedKey = state.skippedMessageKeys.get(id);
  if (skippedKey) {
    const plaintext = aeadDecrypt(skippedKey, message.nonce, message.ciphertext);
    const newSkipped = new Map(state.skippedMessageKeys);
    newSkipped.delete(id);
    return { state: { ...state, skippedMessageKeys: newSkipped }, plaintext };
  }

  let workingState = state;
  const isNewRatchetKey =
    !state.receivingRatchetKey || !bytesEqual(state.receivingRatchetKey, message.header.ratchetKey);

  if (isNewRatchetKey) {
    workingState = skipMessageKeys(workingState, message.header.previousChainLength);
    workingState = dhRatchetStep(workingState, message.header.ratchetKey);
  }

  workingState = skipMessageKeys(workingState, message.header.messageNumber);

  if (!workingState.receivingChainKey) {
    throw new Error("ratchetDecrypt: no receiving chain established");
  }
  const { chainKey, messageKey } = kdfChainKey(workingState.receivingChainKey);
  const plaintext = aeadDecrypt(messageKey, message.nonce, message.ciphertext);

  const newState: RatchetState = {
    ...workingState,
    receivingChainKey: chainKey,
    receiveMessageNumber: message.header.messageNumber + 1,
  };

  return { state: newState, plaintext };
}

function skipMessageKeys(state: RatchetState, until: number): RatchetState {
  if (!state.receivingChainKey) return state;
  if (until - state.receiveMessageNumber > MAX_SKIP) {
    throw new Error("ratchetDecrypt: too many skipped messages (possible attack)");
  }

  let chainKey = state.receivingChainKey;
  let messageNumber = state.receiveMessageNumber;
  const newSkipped = new Map(state.skippedMessageKeys);

  while (messageNumber < until) {
    const stepped = kdfChainKey(chainKey);
    newSkipped.set(skippedKeyId(state.receivingRatchetKey!, messageNumber), stepped.messageKey);
    chainKey = stepped.chainKey;
    messageNumber += 1;
  }

  return { ...state, receivingChainKey: chainKey, receiveMessageNumber: messageNumber, skippedMessageKeys: newSkipped };
}

function dhRatchetStep(state: RatchetState, theirNewRatchetKey: Uint8Array): RatchetState {
  const dhRecv = diffieHellman(state.sendingRatchetKeyPair.privateKey, theirNewRatchetKey);
  const { rootKey: rootAfterRecv, chainKey: receivingChainKey } = kdfRootKey(state.rootKey, dhRecv);

  const newSendingRatchetKeyPair = generateX25519KeyPair();
  const dhSend = diffieHellman(newSendingRatchetKeyPair.privateKey, theirNewRatchetKey);
  const { rootKey: rootAfterSend, chainKey: sendingChainKey } = kdfRootKey(rootAfterRecv, dhSend);

  return {
    ...state,
    rootKey: rootAfterSend,
    receivingRatchetKey: theirNewRatchetKey,
    receivingChainKey,
    previousChainLength: state.sendMessageNumber,
    sendMessageNumber: 0,
    receiveMessageNumber: 0,
    sendingRatchetKeyPair: newSendingRatchetKeyPair,
    sendingChainKey,
  };
}

function skippedKeyId(ratchetKey: Uint8Array, messageNumber: number): string {
  return `${bytesToHex(ratchetKey)}:${messageNumber}`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}