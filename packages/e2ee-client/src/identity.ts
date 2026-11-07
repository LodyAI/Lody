import { Result } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeCbor, encodeCbor } from '@lody/e2ee-core/protocol';
import type { ClientCustodyBinding } from '@lody/e2ee-core/services';
import { verifyPersonalOffer, type PersonalPairingOffer } from './pairing';
import { toHex } from './bytes';
import { fail } from './errors';

// This is a local credential payload, inside the approved fixed-purpose AES-GCM wrapper.
// Reopening authenticates the independently imported pin rather than trusting a saved label.
const pinDigest = (binding: ClientCustodyBinding, offer: PersonalPairingOffer) => {
  Result.getOrThrow(verifyPersonalOffer(offer));
  if (
    offer.workspaceId !== binding.workspaceId ||
    offer.genesisHash !== toHex(binding.genesis.toBytes()) ||
    !/^[0-9a-f]{64}$/.test(binding.installationId)
  )
    throw fail('scope-mismatch');
  return sha256(
    new TextEncoder().encode(
      JSON.stringify([
        'lody-e2ee/client-credential-pin/v1\0',
        binding.accountId,
        binding.workspaceId,
        toHex(binding.genesis.toBytes()),
        toHex(binding.device.toBytes()),
        binding.installationId,
        offer.genesisRecordHex,
        offer.endorser,
        offer.membershipId,
      ])
    )
  );
};
/** Internal current-only credential payload. Never export through a UI/IPC method. */
export function credentialPacket(
  binding: ClientCustodyBinding,
  offer: PersonalPairingOffer,
  credential: Uint8Array
) {
  return Result.try({
    try: () => {
      if (!(credential instanceof Uint8Array) || credential.length !== 32)
        throw fail('invalid-input');
      return Result.getOrThrow(encodeCbor([1, credential, pinDigest(binding, offer)]));
    },
    catch: (cause) => fail('corrupt', cause),
  });
}
/** Internal owned credential readback; session retries keep the original immutable offer pin. */
export function openCredentialPacket(
  binding: ClientCustodyBinding,
  offer: PersonalPairingOffer,
  packet: Uint8Array
) {
  return Result.try({
    try: () => {
      if (!(packet instanceof Uint8Array) || packet.length > 256) throw fail('corrupt');
      const owned = new Uint8Array(packet);
      let parsed: unknown;
      try {
        parsed = Result.getOrThrow(decodeCbor(owned));
        const expected = pinDigest(binding, offer);
        if (
          !Array.isArray(parsed) ||
          parsed.length !== 3 ||
          parsed[0] !== 1 ||
          !(parsed[1] instanceof Uint8Array) ||
          parsed[1].length !== 32 ||
          !(parsed[2] instanceof Uint8Array) ||
          parsed[2].length !== 32 ||
          !parsed[2].every((byte, index) => byte === expected[index])
        )
          throw fail('conflict');
        return new Uint8Array(parsed[1]);
      } finally {
        owned.fill(0);
        if (Array.isArray(parsed!) && parsed[1] instanceof Uint8Array) parsed[1].fill(0);
      }
    },
    catch: (cause) => fail('corrupt', cause),
  });
}
