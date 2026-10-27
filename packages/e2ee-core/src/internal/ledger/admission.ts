import { Effect, Result } from 'effect';
import * as Bytes from '../foundation/bytes';
import { encodeCbor, type CborValue } from '../foundation/cbor';
import { ContentError } from '../foundation/errors';
import { signVerified, type DeviceSigner } from '../foundation/signing';
import { commitEpochKey } from '../keys/history';
import {
  joinRequestSigningBytes,
  possessionSigningBytes,
  recordSigningBytes,
  hashRecordBytes,
  type JoinRequest,
  type DeviceKind,
  type Role,
} from './records';
import { LedgerError } from './errors';
import { encodeMachineId } from './machine-id';
import { verifyLedger, requireLedgerContinuation, type LedgerView } from './replay';
import { prepareLedgerRecord } from './signing';
const invalid = () => Result.fail(new LedgerError({ code: 'canonical' }));
const kindTag = (kind: DeviceKind) => (kind === 'personal' ? 0 : kind === 'machine' ? 1 : 2);
const ownSigner = (borrowed: DeviceSigner) =>
  Result.map(Bytes.signingPublicKey(borrowed.publicKey.toBytes()), (publicKey) =>
    Object.freeze({ publicKey, sign: borrowed.sign.bind(borrowed) })
  );
/** New device consent only. Trusted admission still checks identity, expiry and current permission. */
export const prepareJoinRequest = Effect.fnUntraced(function* (input: {
  readonly genesis: Bytes.GenesisHash;
  readonly requestId: Bytes.RequestId;
  readonly userId: Bytes.UserId;
  readonly encryptionPublicKey: Bytes.EncryptionPublicKey;
  readonly expiresAt: number | null;
  readonly signer: DeviceSigner;
}) {
  const genesis = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
  const signer = yield* Effect.fromResult(ownSigner(input.signer));
  const request = {
    requestId: yield* Effect.fromResult(Bytes.requestId(input.requestId.toBytes())),
    userId: yield* Effect.fromResult(Bytes.userId(input.userId.toBytes())),
    signingPublicKey: signer.publicKey,
    encryptionPublicKey: yield* Effect.fromResult(
      Bytes.encryptionPublicKey(input.encryptionPublicKey.toBytes())
    ),
    expiresAt: input.expiresAt,
  };
  if (
    request.expiresAt !== null &&
    (!Number.isSafeInteger(request.expiresAt) || request.expiresAt < 0)
  )
    return yield* new LedgerError({ code: 'canonical' });
  const message = yield* Effect.fromResult(joinRequestSigningBytes(genesis, request));
  const signature = yield* signVerified(signer, message);
  return Object.freeze({ ...request, signature }) satisfies JoinRequest;
});
/** The proof binds exact Org/membership/kind; it does not authorize its admission. */
export const prepareDeviceAdmission = Effect.fnUntraced(function* (input: {
  readonly genesis: Bytes.GenesisHash;
  readonly membershipId: Bytes.MembershipId;
  readonly encryptionPublicKey: Bytes.EncryptionPublicKey;
  readonly kind: DeviceKind;
  readonly machineId?: string;
  readonly signer: DeviceSigner;
}) {
  const genesis = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
  const membershipId = yield* Effect.fromResult(Bytes.membershipId(input.membershipId.toBytes()));
  const encryptionPublicKey = yield* Effect.fromResult(
    Bytes.encryptionPublicKey(input.encryptionPublicKey.toBytes())
  );
  const kind = input.kind;
  const machineId = input.machineId;
  if (kind !== 'personal' && kind !== 'machine' && kind !== 'recovery')
    return yield* new LedgerError({ code: 'canonical' });
  const signer = yield* Effect.fromResult(ownSigner(input.signer));
  const message = yield* Effect.fromResult(
    possessionSigningBytes({
      genesis,
      targetMembershipId: membershipId,
      signingPublicKey: signer.publicKey,
      encryptionPublicKey,
      kind,
      machineId,
    })
  );
  const possessionSignature = yield* signVerified(signer, message);
  return Object.freeze({
    _tag: 'AdmitDevice' as const,
    kind,
    signingPublicKey: signer.publicKey,
    encryptionPublicKey,
    possessionSignature,
    ...(kind === 'machine' ? { machineId, replaces: null } : {}),
  });
});
/** Existing ordinary intent only. Atomic removal and lifecycle rotation are separate gates. */
export type LedgerCommand =
  | {
      readonly _tag: 'AdmitMember';
      readonly membershipId: Bytes.MembershipId;
      readonly request: JoinRequest;
    }
  | {
      readonly _tag: 'SetRole';
      readonly membershipId: Bytes.MembershipId;
      readonly role: Exclude<Role, 'owner'>;
    }
  | {
      readonly _tag: 'AdmitDevice';
      readonly kind: DeviceKind;
      readonly signingPublicKey: Bytes.SigningPublicKey;
      readonly encryptionPublicKey: Bytes.EncryptionPublicKey;
      readonly possessionSignature: Bytes.Signature;
      readonly machineId?: string;
      readonly replaces?: Bytes.SigningPublicKey | null;
    }
  | { readonly _tag: 'RevokeDevice'; readonly target: Bytes.SigningPublicKey }
  | { readonly _tag: 'TransferOwner'; readonly successorMembershipId: Bytes.MembershipId };
function operation(command: LedgerCommand): Result.Result<CborValue, LedgerError> {
  switch (command._tag) {
    case 'AdmitMember': {
      const r = command.request;
      return Result.succeed([
        1,
        command.membershipId.toBytes(),
        [
          r.requestId.toBytes(),
          r.userId.toBytes(),
          r.signingPublicKey.toBytes(),
          r.encryptionPublicKey.toBytes(),
          r.expiresAt,
          r.signature.toBytes(),
        ],
      ]);
    }
    case 'SetRole':
      return command.role === 'admin' || command.role === 'member' || command.role === 'guest'
        ? Result.succeed([
            3,
            command.membershipId.toBytes(),
            command.role === 'admin' ? 1 : command.role === 'member' ? 2 : 3,
          ])
        : invalid();
    case 'AdmitDevice':
      return Result.gen(function* () {
        if (
          command.kind !== 'personal' &&
          command.kind !== 'machine' &&
          command.kind !== 'recovery'
        )
          return yield* invalid();
        if (
          command.kind !== 'machine' &&
          (command.machineId !== undefined || command.replaces !== undefined)
        )
          return yield* invalid();
        const binding =
          command.kind === 'machine'
            ? [yield* encodeMachineId(command.machineId), command.replaces?.toBytes() ?? null]
            : [];
        return [
          4,
          kindTag(command.kind),
          command.signingPublicKey.toBytes(),
          command.encryptionPublicKey.toBytes(),
          command.possessionSignature.toBytes(),
          ...binding,
        ];
      });
    case 'RevokeDevice':
      return Result.succeed([5, command.target.toBytes()]);
    case 'TransferOwner':
      return Result.succeed([6, command.successorMembershipId.toBytes()]);
    default:
      return Result.fail(new LedgerError({ code: 'unknown-operation' }));
  }
}
/** Pure proposal creation uses the existing genuine-view/proof/permission gate before signing. */
export function prepareLedgerCommand(
  view: LedgerView,
  signer: Bytes.SigningPublicKey,
  command: LedgerCommand
) {
  return Result.gen(function* () {
    yield* requireLedgerContinuation(view, view);
    const op = yield* operation(command);
    const key = yield* Result.mapError(
      Bytes.signingPublicKey(signer.toBytes()),
      (e) => new LedgerError({ code: e.code })
    );
    const body = yield* Result.mapError(
      encodeCbor([view.head.toBytes(), key.toBytes(), op]),
      (e) => new LedgerError({ code: e.code })
    );
    return yield* prepareLedgerRecord(view, body);
  });
}
/** Produces signed v1 genesis only. Caller retains the initial key durably before publication.
 * No identity/key generation, backup, publication, current endpoint trust or key storage is implied. */
export const signGenesisRecord = Effect.fnUntraced(function* (input: {
  readonly userId: Bytes.UserId;
  readonly membershipId: Bytes.MembershipId;
  readonly encryptionPublicKey: Bytes.EncryptionPublicKey;
  readonly initialKey: Bytes.EpochKey;
  readonly signer: DeviceSigner;
}) {
  const signer = yield* Effect.fromResult(ownSigner(input.signer));
  const userId = yield* Effect.fromResult(Bytes.userId(input.userId.toBytes()));
  const membership = yield* Effect.fromResult(Bytes.membershipId(input.membershipId.toBytes()));
  const encryption = yield* Effect.fromResult(
    Bytes.encryptionPublicKey(input.encryptionPublicKey.toBytes())
  );
  // Epoch-zero commitment deliberately omits genesis, avoiding circular record-hash input.
  const commitment = yield* Effect.fromResult(
    Result.mapError(
      commitEpochKey(Result.getOrThrow(Bytes.genesisHash(new Uint8Array(32))), 0, input.initialKey),
      () => new ContentError({ code: 'invalid-initial-key' })
    )
  );
  const body: CborValue = [
    1,
    signer.publicKey.toBytes(),
    userId.toBytes(),
    membership.toBytes(),
    encryption.toBytes(),
    commitment.toBytes(),
  ];
  const bodyBytes = yield* Effect.fromResult(encodeCbor(body));
  const signature = yield* signVerified(signer, recordSigningBytes(bodyBytes));
  const record = yield* Effect.fromResult(encodeCbor([body, signature.toBytes()]));
  const head = hashRecordBytes(record),
    genesis = yield* Effect.fromResult(Bytes.genesisHash(head.toBytes()));
  yield* Effect.fromResult(
    verifyLedger({ anchor: genesis, records: [record], checkpoint: { head, length: 1 } })
  );
  return Object.freeze({ genesis, record });
});
