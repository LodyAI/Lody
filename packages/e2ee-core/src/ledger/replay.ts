import { Result } from 'effect';
import { genesisHash, type GenesisHash, type RecordHash } from '../bytes';
import { bytesEqual } from '../cbor';
import { keyId } from '../identifiers';
import { verifySignature } from '../signature';
import { LedgerError } from './errors';
import {
  applyOperation,
  cloneState,
  genesisState,
  inspectState,
  type InternalState,
  type LedgerState,
} from './policy';
import {
  decodeRecord,
  fail,
  hashRecordBytes,
  joinRequestSigningBytes,
  possessionSigningBytes,
  recordSigningBytes,
} from './records';

/** Independently obtained expected endpoint. Not proof of global freshness. */
export interface LedgerCheckpoint {
  readonly head: RecordHash;
  readonly length: number;
}
declare const verified: unique symbol;
export interface LedgerView {
  readonly [verified]: true;
  readonly genesis: GenesisHash;
  readonly head: RecordHash;
  readonly length: number;
  inspectState(): LedgerState;
}
// Closure-backed objects have no reflective constructor or exposed live state.
const states = new WeakMap<object, InternalState>();
function viewOf(state: InternalState): LedgerView {
  const view: LedgerView = Object.freeze(
    Object.assign(Object.create(null), {
      genesis: state.genesis,
      head: state.hashes[state.hashes.length - 1]!,
      length: state.hashes.length,
      inspectState: () => inspectState(state),
    })
  );
  states.set(view, state);
  return view;
}
const positioned = (position: number) => (error: LedgerError) =>
  new LedgerError({ code: error.code, position });
function replay(
  initial: InternalState | undefined,
  anchor: GenesisHash,
  records: readonly Uint8Array[],
  checkpoint: LedgerCheckpoint
) {
  return Result.gen(function* () {
    if (
      !Number.isSafeInteger(checkpoint.length) ||
      checkpoint.length < 1 ||
      checkpoint.length !== (initial?.hashes.length ?? 0) + records.length
    )
      return yield* fail('checkpoint-mismatch');
    let state = initial;
    for (const bytes of records) {
      const position = state?.hashes.length ?? 0;
      const step = Result.gen(function* () {
        const record = yield* decodeRecord(bytes);
        const hash = hashRecordBytes(record.recordBytes);
        const body = record.body;
        if (!state) {
          if (body.type !== 'genesis') return yield* fail('genesis-mismatch');
          if (!bytesEqual(hash.toBytes(), anchor.toBytes())) return yield* fail('wrong-anchor');
        } else {
          if (body.type !== 'ordinary') return yield* fail('genesis-mismatch');
          if (!body.previousHash.equals(state.hashes[state.hashes.length - 1]!))
            return yield* fail('wrong-parent');
        }
        yield* Result.mapError(
          verifySignature(
            body.signer.toBytes(),
            recordSigningBytes(record.bodyBytes),
            record.signature.toBytes()
          ),
          (error) => new LedgerError({ code: error.code })
        );
        if (body.type === 'genesis') return genesisState(body, anchor, hash);
        if (!state) return yield* fail('genesis-mismatch');
        const op = body.operation;
        if (op.type === 'admitMember') {
          const message = yield* joinRequestSigningBytes(anchor, op.request);
          yield* Result.mapError(
            verifySignature(
              op.request.signingPublicKey.toBytes(),
              message,
              op.request.signature.toBytes()
            ),
            () => new LedgerError({ code: 'bad-proof' })
          );
        } else if (op.type === 'admitDevice') {
          const actor = state.devices.get(keyId(body.signer.toBytes()));
          if (!actor) return yield* fail('unauthorized');
          const message = yield* possessionSigningBytes({
            genesis: anchor,
            targetMembershipId: actor.membershipId,
            signingPublicKey: op.signingPublicKey,
            encryptionPublicKey: op.encryptionPublicKey,
            kind: op.kind,
          });
          yield* Result.mapError(
            verifySignature(
              op.signingPublicKey.toBytes(),
              message,
              op.possessionSignature.toBytes()
            ),
            () => new LedgerError({ code: 'bad-proof' })
          );
        }
        yield* applyOperation(state, body);
        state.hashes.push(hash);
        return state;
      });
      state = yield* Result.mapError(step, positioned(position));
    }
    if (!state) return yield* fail('genesis-mismatch');
    if (!state.hashes[state.hashes.length - 1]!.equals(checkpoint.head))
      return yield* fail('checkpoint-mismatch');
    return viewOf(state);
  });
}
/** Full audit from a caller-pinned genesis and expected endpoint; no URL-derived trust. */
export function verifyLedger(input: {
  readonly anchor: GenesisHash;
  readonly records: readonly Uint8Array[];
  readonly checkpoint: LedgerCheckpoint;
}): Result.Result<LedgerView, LedgerError> {
  return Result.gen(function* () {
    // Revalidate/copy trusted bytes at the boundary as well.
    const anchor = yield* Result.mapError(
      genesisHash(input.anchor.toBytes()),
      (error) => new LedgerError({ code: error.code })
    );
    return yield* replay(undefined, anchor, input.records, input.checkpoint);
  });
}
/** All-or-nothing: failed suffix leaves the preceding verified view unchanged. */
export function extendLedger(
  view: LedgerView,
  records: readonly Uint8Array[],
  checkpoint: LedgerCheckpoint
): Result.Result<LedgerView, LedgerError> {
  const state = states.get(view);
  return state
    ? replay(cloneState(state), state.genesis, records, checkpoint)
    : fail('unauthorized');
}
