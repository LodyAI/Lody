import { Result, Schema } from 'effect';
import * as Bytes from '../internal/foundation/bytes';
import { keyId } from '../internal/foundation/identifiers';
import { verifySignature } from '../internal/foundation/signature';
import { authenticateEpochEnvelopeSignature } from '../internal/keys/envelope';
import { fromHex } from '../internal/keys/reports';
import {
  EpochStagingError,
  ownEpochStagedGroup,
  ownEpochStagedGroupKey,
  type EpochStagedGroup,
  type EpochStagedGroupKey,
} from '../internal/keys/staging';
import { decodeRecord, recordSigningBytes } from '../internal/ledger';

const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Hex = (maxBytes: number) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^(?:[0-9a-f]{2}){1,${maxBytes}}$`)));

/**
 * Wire form of an {@link EpochStagedGroupKey}: which workspace, epoch,
 * commitment and record a staged group belongs to. All hex is lowercase.
 *
 * @category Staging wire contract
 */
export const EpochStagedGroupKeyDto = Schema.Struct({
  genesis: Hash,
  epoch: Schema.Int,
  commitment: Hash,
  recordHash: Hash,
});
export type EpochStagedGroupKeyDto = typeof EpochStagedGroupKeyDto.Type;

/** Wire form of one staged envelope. @category Staging wire contract */
export const EpochStagedEnvelopeDto = Schema.Struct({ recipient: Hash, frameHex: Hex(512) });
export type EpochStagedEnvelopeDto = typeof EpochStagedEnvelopeDto.Type;

/**
 * Wire form of an {@link EpochStagedGroup}: the signed rotation record and one
 * envelope per recipient. Opaque encrypted originals, not ledger authority.
 *
 * @category Staging wire contract
 */
export const EpochStagedGroupDto = Schema.Struct({
  ...EpochStagedGroupKeyDto.fields,
  recordHex: Hex(8192),
  envelopes: Schema.Array(EpochStagedEnvelopeDto).check(Schema.isMaxLength(4096)),
});
export type EpochStagedGroupDto = typeof EpochStagedGroupDto.Type;

/** A request's device-possession proof (not an account or ledger authorization). @category Staging wire contract */
export const EpochStagingRequestProofDto = Schema.Struct({
  signer: Hash,
  signature: Schema.String,
});
export type EpochStagingRequestProofDto = typeof EpochStagingRequestProofDto.Type;

/** Encode a staged group for the wire. @category Staging wire contract */
export const encodeEpochStagedGroup = (group: EpochStagedGroup): EpochStagedGroupDto => ({
  genesis: group.genesis,
  epoch: group.epoch,
  commitment: group.commitment,
  recordHash: group.recordHash,
  recordHex: keyId(group.record),
  envelopes: group.envelopes.map((row) => ({
    recipient: row.recipient,
    frameHex: keyId(row.frame),
  })),
});

/** Decode and structurally validate a staged group from the wire. @category Staging wire contract */
export const decodeEpochStagedGroup = (
  value: unknown
): Result.Result<EpochStagedGroup, EpochStagingError> =>
  Result.gen(function* () {
    const dto = yield* Result.mapError(
      Schema.decodeUnknownResult(EpochStagedGroupDto)(value),
      () => new EpochStagingError({ code: 'invalid-group' })
    );
    return yield* ownEpochStagedGroup({
      genesis: dto.genesis,
      epoch: dto.epoch,
      commitment: dto.commitment,
      recordHash: dto.recordHash,
      record: fromHex(dto.recordHex),
      envelopes: dto.envelopes.map((row) => ({
        recipient: row.recipient,
        frame: fromHex(row.frameHex),
      })),
    });
  });

/** Decode and structurally validate a staged group key from the wire. @category Staging wire contract */
export const decodeEpochStagedGroupKey = (
  value: unknown
): Result.Result<EpochStagedGroupKey, EpochStagingError> =>
  Result.gen(function* () {
    const dto = yield* Result.mapError(
      Schema.decodeUnknownResult(EpochStagedGroupKeyDto)(value),
      () => new EpochStagingError({ code: 'invalid-group' })
    );
    return yield* ownEpochStagedGroupKey(dto);
  });

/**
 * Exact bytes a device signs to stage or delete a group. `scope` is the
 * backend's own identifier for the workspace (for Lody Cloud, the workspace
 * id). Fixed tuples avoid property-order and separator aliases; credentials and
 * the signature itself are excluded. Stage binds every original byte.
 *
 * Throws `TypeError` on malformed input.
 *
 * @category Staging wire contract
 */
export function epochStagingRequestSigningBytes(
  input:
    | {
        readonly operation: 'stage';
        readonly workspaceId: string;
        readonly group: EpochStagedGroupDto;
      }
    | {
        readonly operation: 'delete';
        readonly workspaceId: string;
        readonly key: EpochStagedGroupKeyDto;
        readonly occupied: { readonly epoch: number; readonly commitment: string };
      }
): Uint8Array {
  const invalid = () => {
    throw new TypeError('invalid epoch staging request');
  };
  const hash = (value: string) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  const hex = (value: string, max: number) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max * 2 &&
    value.length % 2 === 0 &&
    /^[0-9a-f]+$/.test(value);
  if (
    !input ||
    typeof input.workspaceId !== 'string' ||
    !input.workspaceId.length ||
    input.workspaceId.length > 256
  )
    return invalid();
  const key =
    input.operation === 'stage'
      ? input.group
      : input.operation === 'delete'
        ? input.key
        : invalid();
  if (
    !key ||
    !hash(key.genesis) ||
    !hash(key.commitment) ||
    !hash(key.recordHash) ||
    !Number.isInteger(key.epoch) ||
    key.epoch < 1 ||
    key.epoch > 0xffffffff
  )
    return invalid();
  const tuple: unknown[] = [
    input.operation,
    input.workspaceId,
    key.genesis,
    key.epoch,
    key.commitment,
    key.recordHash,
  ];
  if (input.operation === 'stage') {
    const group = input.group;
    if (
      !hex(group.recordHex, 8192) ||
      !Array.isArray(group.envelopes) ||
      group.envelopes.length < 1 ||
      group.envelopes.length > 4096
    )
      return invalid();
    const seen = new Set<string>();
    const rows: [string, string][] = [];
    const count = group.envelopes.length;
    for (let index = 0; index < count; index++) {
      const row = group.envelopes[index];
      if (!row || !hash(row.recipient) || !hex(row.frameHex, 512) || seen.has(row.recipient))
        return invalid();
      seen.add(row.recipient);
      rows.push([row.recipient, row.frameHex]);
    }
    if (group.envelopes.length !== count) return invalid();
    rows.sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
    tuple.push(group.recordHex, rows);
  } else {
    const occupied = input.occupied;
    if (
      !occupied ||
      occupied.epoch !== key.epoch ||
      !hash(occupied.commitment) ||
      occupied.commitment === key.commitment
    )
      return invalid();
    tuple.push(occupied.epoch, occupied.commitment);
  }
  return new TextEncoder().encode('lody-e2ee/epoch-staging-request/v1\0' + JSON.stringify(tuple));
}

/**
 * The checks a staging backend must apply before storing `group` for the
 * authenticated device `principal`, besides confirming that `principal` is a
 * current device of the workspace: the group is well formed for `genesis`, its
 * record is an ordinary record signed by `principal`, and every envelope is
 * signed by `principal` for its recipient. None of this needs the ledger tail;
 * a stored group stays inert until the ledger commits its exact record.
 *
 * @category Host rules
 */
export function checkEpochStageRequest(input: {
  readonly genesis: Bytes.GenesisHash;
  readonly principal: Bytes.SigningPublicKey;
  readonly group: EpochStagedGroup;
}) {
  return Result.gen(function* () {
    const unauthorized = () => Result.fail(new EpochStagingError({ code: 'invalid-group' }));
    const group = yield* ownEpochStagedGroup(input.group);
    if (group.genesis !== keyId(input.genesis.toBytes())) return yield* unauthorized();
    const record = yield* decodeRecord(group.record);
    if (record.body.type !== 'ordinary' || !record.body.signer.equals(input.principal))
      return yield* unauthorized();
    yield* verifySignature(
      input.principal.toBytes(),
      recordSigningBytes(record.bodyBytes),
      record.signature.toBytes()
    );
    const epoch = yield* Bytes.epochNumber(group.epoch);
    for (const row of group.envelopes)
      yield* authenticateEpochEnvelopeSignature(
        {
          genesis: input.genesis,
          epoch,
          sender: input.principal,
          recipient: yield* Bytes.signingPublicKey(fromHex(row.recipient)),
        },
        row.frame
      );
    return group;
  });
}
