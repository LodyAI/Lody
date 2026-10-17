import { Data, Result, Schema } from 'effect';
import { bytesEqual } from '../foundation/cbor';
import { keyId } from '../foundation/identifiers';
import {
  decodeRecord,
  epochHistoryPacket,
  epochPublicationRecord,
  hasVerifiedRecordHash,
  hashRecordBytes,
  type LedgerView,
} from '../ledger';
import { authenticateEpochEnvelope, authenticateEpochEnvelopeSignature } from './envelope';
import * as Bytes from '../foundation/bytes';

/** Untrusted storage locator. A matching row is never publication authority. */
export interface EpochStagedGroupKey {
  readonly genesis: string;
  readonly epoch: number;
  readonly commitment: string;
  readonly recordHash: string;
}
/** One rotation's staged envelope group: its key plus the signed record and one envelope frame per recipient. */
export interface EpochStagedGroup extends EpochStagedGroupKey {
  readonly record: Uint8Array;
  readonly envelopes: readonly { readonly recipient: string; readonly frame: Uint8Array }[];
}
/** A staged group is malformed, not committed, incomplete or not obsolete. */
export class EpochStagingError extends Data.TaggedError('EpochStagingError')<{
  readonly code: 'invalid-group' | 'uncommitted' | 'incomplete' | 'not-obsolete';
}> {}
const fail = (code: EpochStagingError['code']) => new EpochStagingError({ code });
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Key = Schema.Struct({ genesis: Hash, epoch: Schema.Int, commitment: Hash, recordHash: Hash });
const Group = Schema.Struct({
  ...Key.fields,
  record: Schema.Uint8Array,
  envelopes: Schema.Array(Schema.Struct({ recipient: Hash, frame: Schema.Uint8Array })),
});
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));
/** Validate and copy a staged group key. */
export function ownEpochStagedGroupKey(input: EpochStagedGroupKey) {
  return Result.gen(function* () {
    const key = yield* Result.mapError(Schema.decodeUnknownResult(Key)(input), () =>
      fail('invalid-group')
    );
    if (key.epoch < 1 || key.epoch > 0xffffffff) return yield* Result.fail(fail('invalid-group'));
    return Object.freeze({ ...key });
  });
}
/** Own all originals before yielding; bounded canonical routing only, no authority. */
export function ownEpochStagedGroup(input: EpochStagedGroup) {
  return Result.gen(function* () {
    // Bound the array before Schema walks its contents.
    if (
      !input ||
      !Array.isArray(input.envelopes) ||
      input.envelopes.length < 1 ||
      input.envelopes.length > 4096 ||
      !(input.record instanceof Uint8Array) ||
      input.record.length < 1 ||
      input.record.length > 8192
    )
      return yield* Result.fail(fail('invalid-group'));
    const decoded = yield* Result.mapError(Schema.decodeUnknownResult(Group)(input), () =>
      fail('invalid-group')
    );
    const key = yield* ownEpochStagedGroupKey(decoded);
    const record = new Uint8Array(decoded.record);
    const parsed = yield* Result.mapError(decodeRecord(record), () => fail('invalid-group'));
    if (
      keyId(hashRecordBytes(record).toBytes()) !== key.recordHash ||
      parsed.body.type !== 'ordinary' ||
      (parsed.body.operation.type !== 'publishEpoch' &&
        parsed.body.operation.type !== 'removeMemberAndPublishEpoch') ||
      parsed.body.operation.epoch !== key.epoch ||
      keyId(parsed.body.operation.commitment.toBytes()) !== key.commitment
    )
      return yield* Result.fail(fail('invalid-group'));
    const recipients = new Set<string>();
    const envelopes: { readonly recipient: string; readonly frame: Uint8Array }[] = [];
    const count = decoded.envelopes.length;
    for (let index = 0; index < count; index++) {
      const row = decoded.envelopes[index]!;
      if (recipients.has(row.recipient) || row.frame.length < 1 || row.frame.length > 512)
        return yield* Result.fail(fail('invalid-group'));
      recipients.add(row.recipient);
      envelopes.push(Object.freeze({ recipient: row.recipient, frame: new Uint8Array(row.frame) }));
    }
    envelopes.sort((a, b) => a.recipient.localeCompare(b.recipient));
    return Object.freeze({ ...key, record, envelopes: Object.freeze(envelopes) });
  });
}
/** Byte-for-byte equality of two staged groups. */
export const sameEpochStagedGroup = (a: EpochStagedGroup, b: EpochStagedGroup) =>
  a.genesis === b.genesis &&
  a.epoch === b.epoch &&
  a.commitment === b.commitment &&
  a.recordHash === b.recordHash &&
  bytesEqual(a.record, b.record) &&
  a.envelopes.length === b.envelopes.length &&
  a.envelopes.every(
    (row, i) =>
      row.recipient === b.envelopes[i]?.recipient && bytesEqual(row.frame, b.envelopes[i]!.frame)
  );
/** Candidate poststate must come from the fixed ledger verifier, never a projection. */
export function authenticateEpochStagedGroup(
  view: LedgerView,
  input: EpochStagedGroup,
  complete = false
) {
  return Result.gen(function* () {
    const group = yield* ownEpochStagedGroup(input);
    const record = yield* Result.mapError(decodeRecord(group.record), () => fail('invalid-group'));
    const packet = yield* Result.mapError(epochHistoryPacket(view, group.epoch), () =>
      fail('uncommitted')
    );
    if (
      keyId(view.genesis.toBytes()) !== group.genesis ||
      !(yield* Result.mapError(hasVerifiedRecordHash(view, hashRecordBytes(group.record)), () =>
        fail('uncommitted')
      )) ||
      keyId(packet.commitment.toBytes()) !== group.commitment ||
      record.body.type !== 'ordinary'
    )
      return yield* Result.fail(fail('uncommitted'));
    const sender = record.body.signer;
    for (const row of group.envelopes) {
      const context = {
        genesis: view.genesis,
        epoch: yield* Bytes.epochNumber(group.epoch),
        sender,
        recipient: yield* Bytes.signingPublicKey(fromHex(row.recipient)),
      };
      // Later revocation of an unrelated recipient cannot block an eligible
      // receiver's recovery. Its own current eligibility is checked before open.
      yield* complete
        ? authenticateEpochEnvelope(view, context, row.frame)
        : authenticateEpochEnvelopeSignature(context, row.frame);
    }
    if (complete) {
      const targets = [...view.inspectState().devices.keys()].sort();
      if (
        targets.length !== group.envelopes.length ||
        targets.some((key, i) => key !== group.envelopes[i]!.recipient)
      )
        return yield* Result.fail(fail('incomplete'));
    }
    return { group, sender };
  });
}
/** Deletion is permitted only after this exact epoch slot has another commitment. */
export function obsoleteEpochStagedGroup(view: LedgerView, input: EpochStagedGroupKey) {
  return Result.gen(function* () {
    const key = yield* ownEpochStagedGroupKey(input);
    const packet = yield* Result.mapError(epochHistoryPacket(view, key.epoch), () =>
      fail('not-obsolete')
    );
    const commitment = keyId(packet.commitment.toBytes());
    if (key.genesis !== keyId(view.genesis.toBytes()) || commitment === key.commitment)
      return yield* Result.fail(fail('not-obsolete'));
    return { epoch: key.epoch, commitment };
  });
}

/** Discovery comes only from original tag7/8 bytes replayed by the genuine ledger. */
export function getCommittedEpochStagingKey(view: LedgerView, epoch: number) {
  return Result.gen(function* () {
    const record = yield* epochPublicationRecord(view, epoch);
    const parsed = yield* decodeRecord(record);
    const packet = yield* epochHistoryPacket(view, epoch);
    if (parsed.body.type !== 'ordinary') return yield* Result.fail(fail('uncommitted'));
    return {
      genesis: keyId(view.genesis.toBytes()),
      epoch,
      commitment: keyId(packet.commitment.toBytes()),
      recordHash: keyId(hashRecordBytes(record).toBytes()),
      signer: parsed.body.signer,
    };
  });
}
