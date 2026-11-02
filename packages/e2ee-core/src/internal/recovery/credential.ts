import { getPublicKey, hashes } from '@noble/ed25519';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesEqual } from '../foundation/cbor';
import { fromHex, vaultError } from './crypto';
import { ownRecoveryPackage, wipeRecoveryPackage, type RecoveryPrivatePackage } from './vault';

// The pinned synchronous Ed25519 implementation always uses this fixed hash.
hashes.sha512 = sha512;

const domain = new TextEncoder().encode('lody-e2ee/recovery-credential/v1\0');

/** R's service access credential and the SHA-256 hash registered for it. Wipe `credential` after use. */
export interface RecoveryAccessCredential {
  readonly credential: Uint8Array;
  readonly credentialHash: Uint8Array;
}

/**
 * Derive R's service access credential from its private package: HKDF-SHA256
 * over the 32-byte Ed25519 seed, salt = genesis hash, info =
 * `lody-e2ee/recovery-credential/v1\0` followed by R's signing public key
 * (owner-approved, specs/e2ee/recovery-vault.md). The seed must derive the
 * package's signing public key. The credential only authenticates R to the
 * service; it grants no ledger authority and adds nothing beyond holding R's key.
 */
export function deriveRecoveryAccessCredential(
  input: RecoveryPrivatePackage
): RecoveryAccessCredential {
  const owned = ownRecoveryPackage(input);
  const seed = owned.signingPrivate.subarray(16, 48);
  // RFC 5869 with SHA-256 and L = 32, so expand is one block: T(1) = HMAC(PRK,
  // info | 0x01). The pinned library hkdf returns a copy of an unwiped OKM and
  // never wipes PRK, so every output here is written into a buffer this
  // function owns and wipes; HMAC/SHA-256 instances wipe their state on digest/destroy.
  const salt = fromHex(owned.genesis),
    message = new Uint8Array(domain.length + 33),
    prk = new Uint8Array(32),
    credential = new Uint8Array(32),
    credentialHash = new Uint8Array(32);
  let returned = false;
  try {
    if (!bytesEqual(getPublicKey(seed), owned.signingPublic)) throw vaultError('authentication');
    message.set(domain);
    message.set(owned.signingPublic, domain.length);
    message[message.length - 1] = 1;
    hmac.create(sha256, salt).update(seed).digestInto(prk);
    hmac.create(sha256, prk).update(message).digestInto(credential);
    const hasher = sha256.create();
    hasher.update(credential).digestInto(credentialHash);
    hasher.destroy();
    returned = true;
    return { credential, credentialHash };
  } finally {
    prk.fill(0);
    message.fill(0);
    salt.fill(0);
    if (!returned) {
      credential.fill(0);
      credentialHash.fill(0);
    }
    wipeRecoveryPackage(owned);
  }
}
