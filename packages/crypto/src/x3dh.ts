import type { KeyPair } from "./primitives.js";
import {
  generateX25519KeyPair,
  diffieHellman,
  deriveKeys,
  sign,
  verify,
} from "./primitives.js";

/**
 * X3DH (Extended Triple Diffie-Hellman) — initial key agreement, run once
 * per new session before the Double Ratchet takes over.
 *
 * DESIGN NOTE (flag for review): identity is split into a dedicated X25519
 * keypair (IK, used for DH) and a separate Ed25519 keypair (signingKey,
 * used only to sign/verify the SPK). Classic Signal uses one Curve25519
 * key for both via XEdDSA conversion — we're avoiding an unverified
 * conversion helper for now. Confirm against the TAD before merging.
 */

export interface IdentityBundle {
  identityKey: Uint8Array;            // IK — X25519 public key, used for DH
  signingKey: Uint8Array;             // Ed25519 public key, verifies the SPK signature
  signedPreKey: Uint8Array;           // SPK — X25519 public key
  signedPreKeySignature: Uint8Array;  // signature over signedPreKey, by signingKey
  oneTimePreKey?: Uint8Array;         // OPK — X25519 public key, consumed on use
}

export interface X3dhSessionKeys {
  rootKey: Uint8Array;
  associatedData: Uint8Array;
}

const INFO = "WPT-X3DH-v1";
const KEY_LENGTH = 32;

/** Bob's side: generate the bundle he publishes to the server for others to fetch. */
export function generatePreKeyBundle(
  identity: KeyPair, // X25519 IK keypair
  signing: KeyPair,  // Ed25519 signing keypair
): {
  bundle: IdentityBundle;
  signedPreKeyPair: KeyPair;
  oneTimePreKeyPair: KeyPair;
} {
  const signedPreKeyPair = generateX25519KeyPair();
  const signedPreKeySignature = sign(signing.privateKey, signedPreKeyPair.publicKey);
  const oneTimePreKeyPair = generateX25519KeyPair();

  const bundle: IdentityBundle = {
    identityKey: identity.publicKey,
    signingKey: signing.publicKey,
    signedPreKey: signedPreKeyPair.publicKey,
    signedPreKeySignature,
    oneTimePreKey: oneTimePreKeyPair.publicKey,
  };

  return { bundle, signedPreKeyPair, oneTimePreKeyPair };
}

/** Alice's side: she fetched Bob's bundle from the server and starts a session. */
export function initiateSession(
  ourIdentity: KeyPair,        // our X25519 IK
  theirBundle: IdentityBundle,
): { sessionKeys: X3dhSessionKeys; ephemeralKeyPair: KeyPair } {
  const signatureValid = verify(
    theirBundle.signingKey,
    theirBundle.signedPreKey,
    theirBundle.signedPreKeySignature,
  );
  if (!signatureValid) {
    throw new Error("X3DH: signed prekey signature verification failed");
  }

  const ephemeralKeyPair = generateX25519KeyPair();

  const dh1 = diffieHellman(ourIdentity.privateKey, theirBundle.signedPreKey);
  const dh2 = diffieHellman(ephemeralKeyPair.privateKey, theirBundle.identityKey);
  const dh3 = diffieHellman(ephemeralKeyPair.privateKey, theirBundle.signedPreKey);
  const dh4 = theirBundle.oneTimePreKey
    ? diffieHellman(ephemeralKeyPair.privateKey, theirBundle.oneTimePreKey)
    : new Uint8Array(0);

  const ikm = concatBytes(dh1, dh2, dh3, dh4);
  const rootKey = deriveKeys(ikm, INFO, KEY_LENGTH);
  const associatedData = concatBytes(ourIdentity.publicKey, theirBundle.identityKey);

  return { sessionKeys: { rootKey, associatedData }, ephemeralKeyPair };
}

/** Bob's side: Alice's first message arrived with her IK + ephemeral key; derive the same root key. */
export function respondToSession(
  ourIdentity: KeyPair,           // our X25519 IK
  ourSignedPreKey: KeyPair,       // our SPK keypair (need the private half)
  theirIdentityKey: Uint8Array,   // Alice's X25519 IK (public)
  theirEphemeralKey: Uint8Array,  // Alice's ephemeral key (public)
  ourOneTimePreKey?: KeyPair,     // our OPK keypair, only if Alice's message says she used one
): X3dhSessionKeys {
  const dh1 = diffieHellman(ourSignedPreKey.privateKey, theirIdentityKey);
  const dh2 = diffieHellman(ourIdentity.privateKey, theirEphemeralKey);
  const dh3 = diffieHellman(ourSignedPreKey.privateKey, theirEphemeralKey);
  const dh4 = ourOneTimePreKey
    ? diffieHellman(ourOneTimePreKey.privateKey, theirEphemeralKey)
    : new Uint8Array(0);

  const ikm = concatBytes(dh1, dh2, dh3, dh4);
  const rootKey = deriveKeys(ikm, INFO, KEY_LENGTH);
  const associatedData = concatBytes(theirIdentityKey, ourIdentity.publicKey);

  return { rootKey, associatedData };
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}