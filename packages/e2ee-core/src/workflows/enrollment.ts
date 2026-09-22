import { Effect } from 'effect';
import { DeviceSigner } from '../ports/ledger';
import type {
  EncryptionPublicKey,
  GenesisHash,
  MembershipId,
  RequestId,
  UserId,
} from '../pure/bytes';
import type { DeviceGrant, LedgerCommand } from '../pure/commands';
import { asNullOrUint } from '../pure/cbor';
import { assertSignature } from '../ledger/crypto';
import { joinRequestSigningBytes, possessionSigningBytes } from '../ledger/schema';
import { protocol } from './protocol';

/** Run on the new device. Approval on an existing device still rechecks live membership.
 * A possession proof is not authorization and is never reusable for another membership. */
export function prepareDeviceAdmission(input: {
  readonly genesis: GenesisHash;
  readonly membershipId: MembershipId;
  readonly encryptionPublicKey: EncryptionPublicKey;
  readonly grant: DeviceGrant;
}) {
  const { genesis, membershipId, encryptionPublicKey } = input;
  const grant = { ...input.grant };
  return Effect.gen(function* () {
    const signer = yield* DeviceSigner;
    const message = yield* protocol(() =>
      possessionSigningBytes({
        genesis: genesis.toBytes(),
        targetMembershipId: membershipId.toBytes(),
        signingPublicKey: signer.publicKey.toBytes(),
        encryptionPublicKey: encryptionPublicKey.toBytes(),
        ...grant,
      })
    );
    const proof = yield* signer.sign(message);
    yield* protocol(() =>
      assertSignature(signer.publicKey.toBytes(), message, proof.toBytes(), 'bad-proof')
    );
    return {
      _tag: 'AdmitDevice',
      ...grant,
      signingPublicKey: signer.publicKey,
      encryptionPublicKey,
      possessionSignature: proof,
    } satisfies LedgerCommand;
  });
}

/** Signed joining consent, not a claim that a cloud account owns this userId.
 * The trusted admission gateway still binds identity and checks request expiry. */
export function prepareJoinRequest(input: {
  readonly genesis: GenesisHash;
  readonly requestId: RequestId;
  readonly userId: UserId;
  readonly encryptionPublicKey: EncryptionPublicKey;
  readonly expiresAt: number | null;
}) {
  const { genesis, requestId, userId, encryptionPublicKey, expiresAt } = input;
  return Effect.gen(function* () {
    yield* asNullOrUint(expiresAt);
    const signer = yield* DeviceSigner;
    const message = yield* protocol(() =>
      joinRequestSigningBytes(genesis.toBytes(), {
        requestId: requestId.toBytes(),
        userId: userId.toBytes(),
        signingPublicKey: signer.publicKey.toBytes(),
        encryptionPublicKey: encryptionPublicKey.toBytes(),
        expiresAt,
      })
    );
    const signature = yield* signer.sign(message);
    yield* protocol(() =>
      assertSignature(signer.publicKey.toBytes(), message, signature.toBytes(), 'bad-proof')
    );
    return {
      requestId,
      userId,
      signingPublicKey: signer.publicKey,
      encryptionPublicKey,
      expiresAt,
      signature,
    };
  });
}
