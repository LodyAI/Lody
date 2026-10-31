import { getPublicKey, hashes } from '@noble/ed25519';
import { hkdf } from '@noble/hashes/hkdf.js';
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
  const info = new Uint8Array(domain.length + 32);
  try {
    if (!bytesEqual(getPublicKey(seed), owned.signingPublic)) throw vaultError('authentication');
    info.set(domain);
    info.set(owned.signingPublic, domain.length);
    const credential = hkdf(sha256, seed, fromHex(owned.genesis), info, 32);
    return { credential, credentialHash: sha256(credential) };
  } finally {
    info.fill(0);
    wipeRecoveryPackage(owned);
  }
}
