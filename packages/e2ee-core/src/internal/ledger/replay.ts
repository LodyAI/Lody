import {
  verifiedSnapshotState,
  proposalOf,
  noteOf,
  stateDigestOf,
  encodeRetainedState,
  decodeRetainedState,
  type SnapshotTrust,
} from './snapshot-codec';
import { Chunk, Effect, HashMap, Result } from 'effect';
import {
  genesisHash,
  recordHash,
  signingPublicKey,
  epochNumber,
  signature as parseSignature,
  type SigningPublicKey,
  type GenesisHash,
  type RecordHash,
} from '../foundation/bytes';
import { bytesEqual, copyBytes } from '../foundation/cbor';
import { keyId } from '../foundation/identifiers';
import {
  verifySignature,
  verifySignatureEffect,
  NativeSignatureError,
} from '../foundation/signature';
import { LedgerError } from './errors';
import {
  applyOperation,
  cloneState,
  stateGet,
  hashAt,
  genesisState,
  inspectState,
  type InternalState,
  type LedgerState,
  type HistoricalContentAuthor,
  type EpochHistoryPacket,
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
/** A genuine, library-verified ledger view: genesis, head, length and the state it proves. Only this library constructs views. */
export interface LedgerView {
  readonly [verified]: true;
  readonly genesis: GenesisHash;
  readonly head: RecordHash;
  readonly length: number;
  readonly verification: 'full-history' | 'endorsed-snapshot';
  /** First record position for which this view carries a verified hash. */
  readonly historyStart: number;
  inspectState(): LedgerState;
}
// Closure-backed objects have no reflective constructor or exposed live state.
const states = new WeakMap<object, InternalState>();
function viewOf(state: InternalState): LedgerView {
  const view: LedgerView = Object.freeze(
    Object.assign(Object.create(null), {
      genesis: state.genesis,
      head: hashAt(state, state.hashes.length - 1)!,
      length: state.hashesOffset + state.hashes.length,
      verification: state.verification,
      historyStart: state.hashesOffset,
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
      checkpoint.length !==
        (initial ? initial.hashesOffset + initial.hashes.length : 0) + records.length
    )
      return yield* fail('checkpoint-mismatch');
    let state = initial;
    for (const bytes of records) {
      const position = state ? state.hashesOffset + state.hashes.length : 0;
      const step = Result.gen(function* () {
        const record = yield* decodeRecord(bytes);
        const hash = hashRecordBytes(record.recordBytes);
        const body = record.body;
        if (!state) {
          if (body.type !== 'genesis') return yield* fail('genesis-mismatch');
          if (!bytesEqual(hash.toBytes(), anchor.toBytes())) return yield* fail('wrong-anchor');
        } else {
          if (body.type !== 'ordinary') return yield* fail('genesis-mismatch');
          if (!body.previousHash.equals(hashAt(state, state.hashes.length - 1)!))
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
        yield* applyAuthorizedOrdinary(state, body);
        if (
          body.operation.type === 'publishEpoch' ||
          body.operation.type === 'removeMemberAndPublishEpoch'
        )
          state.epochPublications = HashMap.set(
            state.epochPublications ?? HashMap.empty(),
            body.operation.epoch,
            copyBytes(record.recordBytes)
          );
        state.hashes = Chunk.append(state.hashes, hash);
        return state;
      });
      state = yield* Result.mapError(step, positioned(position));
    }
    if (!state) return yield* fail('genesis-mismatch');
    if (!hashAt(state, state.hashes.length - 1)!.equals(checkpoint.head))
      return yield* fail('checkpoint-mismatch');
    return viewOf(state);
  });
}
/** Internal only: parsed body and private clone; not an authority constructor. */
export function applyAuthorizedOrdinary(
  state: InternalState,
  body: Extract<import('./records').RecordBody, { type: 'ordinary' }>
): Result.Result<void, LedgerError> {
  const anchor = state.genesis;
  return Result.gen(function* () {
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
      const actor = stateGet(state.devices, keyId(body.signer.toBytes()));
      if (!actor) return yield* fail('unauthorized');
      const message = yield* possessionSigningBytes({
        genesis: anchor,
        targetMembershipId: actor.membershipId,
        signingPublicKey: op.signingPublicKey,
        encryptionPublicKey: op.encryptionPublicKey,
        kind: op.kind,
        machineId: op.machineId,
      });
      yield* Result.mapError(
        verifySignature(op.signingPublicKey.toBytes(), message, op.possessionSignature.toBytes()),
        () => new LedgerError({ code: 'bad-proof' })
      );
    }
    yield* applyOperation(state, body);
    return undefined;
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
/** Full audit for I/O workflows. Same strict replay kernel, bounded owned input
 * and cooperative batches; no worker-selected state, trust shortcut or verifier. */
const auditLedgerEffect = Effect.fnUntraced(function* (
  input: {
    readonly anchor: GenesisHash;
    readonly records: readonly Uint8Array[];
    readonly checkpoint: LedgerCheckpoint;
  },
  initial?: LedgerView
) {
  if (initial) yield* Effect.fromResult(requireLedgerContinuation(initial, initial));
  const anchor = yield* Effect.fromResult(
    Result.mapError(
      genesisHash(input.anchor.toBytes()),
      (error) => new LedgerError({ code: error.code })
    )
  );
  const head = yield* Effect.fromResult(
    Result.mapError(
      recordHash(input.checkpoint.head.toBytes()),
      (error) => new LedgerError({ code: error.code })
    )
  );
  const length = input.checkpoint.length,
    source = input.records;
  if (!Array.isArray(source) || source.length > 1_000_000)
    return yield* new LedgerError({ code: 'oversize' });
  const count = source.length;
  if (!Number.isSafeInteger(length) || length < 1 || length !== (initial?.length ?? 0) + count)
    return yield* new LedgerError({ code: 'checkpoint-mismatch' });
  const records: Uint8Array[] = [];
  let size = 0;
  for (let index = 0; index < count; index++) {
    const row = source[index];
    if (!(row instanceof Uint8Array) || row.length > 8192)
      return yield* new LedgerError({ code: 'oversize' });
    size += row.length;
    if (size > 64 * 1024 * 1024) return yield* new LedgerError({ code: 'oversize' });
    records.push(new Uint8Array(row));
  }
  if (source.length !== count) return yield* new LedgerError({ code: 'canonical' });
  let view: LedgerView | undefined = initial;
  for (let start = 0; start < count; start += 32) {
    yield* Effect.yieldNow;
    const batch = records.slice(start, start + 32);
    // Warm only exact mathematical signature successes. The shared strict replay
    // kernel still decides chain order, proof/permission failures and positions.
    for (const bytes of batch) {
      const parsed = decodeRecord(bytes);
      if (Result.isSuccess(parsed)) {
        const record = parsed.success;
        yield* verifySignatureEffect(
          record.body.signer.toBytes(),
          recordSigningBytes(record.bodyBytes),
          record.signature.toBytes()
        ).pipe(
          Effect.catch((error) =>
            error instanceof NativeSignatureError
              ? Effect.fail(new LedgerError({ code: 'native-unavailable' }))
              : Effect.void
          )
        );
      }
    }
    const end = start + batch.length;
    const point = {
      head: end === count ? head : hashRecordBytes(batch[batch.length - 1]!),
      length: (initial?.length ?? 0) + end,
    };
    view = yield* Effect.fromResult(
      view
        ? extendLedger(view, batch, point)
        : verifyLedger({ anchor, records: batch, checkpoint: point })
    );
  }
  if (!view || !view.head.equals(head))
    return yield* new LedgerError({ code: 'checkpoint-mismatch' });
  return view;
});
/** Effect form of `verifyLedger` that verifies signatures cooperatively. */
export const verifyLedgerEffect = (input: {
  readonly anchor: GenesisHash;
  readonly records: readonly Uint8Array[];
  readonly checkpoint: LedgerCheckpoint;
}) => auditLedgerEffect(input);
/** Effect form of `extendLedger` that verifies signatures cooperatively. */
export const extendLedgerEffect = (
  view: LedgerView,
  records: readonly Uint8Array[],
  checkpoint: LedgerCheckpoint
) =>
  Effect.suspend(() =>
    states.has(view)
      ? auditLedgerEffect({ anchor: view.genesis, records, checkpoint }, view)
      : Effect.fail(new LedgerError({ code: 'unauthorized' }))
  );
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

/** A party's own verified state at one position, to restore later. Not a snapshot: it is evidence for nobody else. */
export interface RetainedLedgerState {
  readonly bytes: Uint8Array;
  readonly genesis: GenesisHash;
  readonly head: RecordHash;
  readonly length: number;
  /** The digest this position's comparison note carries; store it with the bytes and pass it to restore to detect corruption. */
  readonly stateDigest: RecordHash;
}
/** Canonical state of a genuine view, for its holder's own storage. */
export function exportVerifiedState(
  view: LedgerView
): Result.Result<RetainedLedgerState, LedgerError> {
  const state = states.get(view);
  if (!state) return fail('unauthorized');
  return Result.map(encodeRetainedState(state), ({ bytes, stateDigest }) =>
    Object.freeze({
      bytes,
      genesis: view.genesis,
      head: view.head,
      length: view.length,
      stateDigest,
    })
  );
}
/**
 * Resume from bytes the caller itself exported and stored. Decodes without any
 * signature or curve-point recheck. When `stateDigest` (the exported one) is
 * supplied, the digest is recomputed from the bytes (one SHA-256) after they decode
 * and a mismatch fails with `state-digest-mismatch`; this detects corrupted or
 * swapped storage, not a forger who can rewrite both. Bytes of another format
 * version fail with `unknown-version`: rebuild them by full replay. Never accept
 * another party's bytes here: use endorsed snapshots.
 */
export function restoreVerifiedState(input: {
  readonly bytes: Uint8Array;
  readonly genesis: GenesisHash;
  readonly head: RecordHash;
  readonly length: number;
  readonly stateDigest?: RecordHash | undefined;
}): Result.Result<LedgerView, LedgerError> {
  return Result.map(decodeRetainedState(input.bytes, input), viewOf);
}

/** What a device may do with document content at a verified view. */
export interface ContentPermissions {
  /** Host admission: active personal/machine device of a non-Guest member. */
  readonly mayWriteDocument: boolean;
  /** Current seal permission; a pending manual rotation is advisory. */
  readonly maySealNewContent: boolean;
}
/** Current permissions at this caller-selected verified endpoint, not freshness proof. */
export function contentPermissions(
  view: LedgerView,
  device: SigningPublicKey
): Result.Result<ContentPermissions, LedgerError> {
  return Result.gen(function* () {
    const state = states.get(view);
    if (!state) return yield* fail('unauthorized');
    const key = yield* Result.mapError(
      signingPublicKey(device.toBytes()),
      (error) => new LedgerError({ code: error.code })
    );
    const active = stateGet(state.devices, keyId(key.toBytes()));
    const member = active && stateGet(state.members, keyId(active.membershipId.toBytes()));
    const mayWriteDocument = !!(
      active &&
      active.kind !== 'recovery' &&
      member &&
      member.role !== 'guest'
    );
    return Object.freeze({
      mayWriteDocument,
      maySealNewContent: mayWriteDocument,
    });
  });
}
/** Exact signed publication actually verified in this view's retained history. */
export function epochPublicationRecord(
  view: LedgerView,
  epoch: number
): Result.Result<Uint8Array, LedgerError> {
  const state = states.get(view);
  if (!state) return fail('unauthorized');
  const row = state.epochPublications && stateGet(state.epochPublications, epoch);
  return row ? Result.succeed(copyBytes(row)) : fail('unauthorized');
}
/** Owns a detached packet copy. Signed publication is not authenticated decryption. */
export function epochHistoryPacket(
  view: LedgerView,
  epoch: number
): Result.Result<EpochHistoryPacket, LedgerError> {
  return Result.gen(function* () {
    const state = states.get(view);
    if (!state) return yield* fail('unauthorized');
    const number = yield* Result.mapError(
      epochNumber(epoch),
      (error) => new LedgerError({ code: error.code })
    );
    const row = stateGet(state.historyPackets, number);
    return row
      ? Object.freeze({ ...row, packet: copyBytes(row.packet) })
      : yield* fail('unauthorized');
  });
}

/** Verified-prefix relation only; no claim about the globally latest ledger. */
export function requireLedgerContinuation(
  previous: LedgerView,
  next: LedgerView
): Result.Result<void, LedgerError> {
  const before = states.get(previous),
    after = states.get(next);
  if (!before || !after) return fail('unauthorized');
  if (!bytesEqual(before.genesis.toBytes(), after.genesis.toBytes()))
    return fail('genesis-mismatch');
  const position = before.hashesOffset + before.hashes.length - 1;
  const index = position - after.hashesOffset;
  const head = index >= 0 ? hashAt(after, index) : undefined;
  return head && bytesEqual(head.toBytes(), hashAt(before, before.hashes.length - 1)!.toBytes())
    ? Result.succeed(undefined)
    : fail('checkpoint-mismatch');
}

/** Check unsigned-body policy/proofs against this exact verified parent; no state is published. */
export function authorizeUnsignedRecord(
  view: LedgerView,
  body: Extract<import('./records').RecordBody, { type: 'ordinary' }>
): Result.Result<void, LedgerError> {
  const state = states.get(view);
  if (!state) return fail('unauthorized');
  if (!bytesEqual(body.previousHash.toBytes(), view.head.toBytes())) return fail('wrong-parent');
  return applyAuthorizedOrdinary(cloneState(state), body);
}

declare const verifiedTrust: unique symbol;
/** Snapshot qualification derived from a genuine view at the same position. */
export interface VerifiedViewSnapshotTrust {
  readonly [verifiedTrust]: true;
  readonly source: 'verified-view';
}
const snapshotPins = new WeakMap<object, { view: LedgerView; facts: SnapshotTrust }>();
/** Same-position role facts from an actual view, never a caller-supplied role object. */
export function snapshotTrustFromView(
  view: LedgerView,
  endorser: SigningPublicKey,
  headSignature: import('../foundation/bytes').Signature
): Result.Result<VerifiedViewSnapshotTrust, LedgerError> {
  return Result.gen(function* () {
    const state = states.get(view);
    if (!state) return yield* fail('unauthorized');
    const key = yield* Result.mapError(
      signingPublicKey(endorser.toBytes()),
      (error) => new LedgerError({ code: error.code })
    );
    yield* proposalOf(state, key);
    const device = stateGet(state.devices, keyId(key.toBytes()))!,
      member = stateGet(state.members, keyId(device.membershipId.toBytes()))!;
    const role = member.role;
    if (role !== 'owner' && role !== 'admin') return yield* fail('unauthorized');
    const token = Object.freeze(
      Object.assign(Object.create(null), { source: 'verified-view' as const })
    ) as VerifiedViewSnapshotTrust;
    const ownedSignature = yield* Result.mapError(
      parseSignature(headSignature.toBytes()),
      (error) => new LedgerError({ code: error.code })
    );
    snapshotPins.set(token, {
      view,
      facts: {
        source: 'external-confirmation',
        genesis: view.genesis,
        head: view.head,
        length: view.length,
        endorser: key,
        membershipId: device.membershipId,
        role,
        kind: 'personal',
        headSignature: ownedSignature,
      },
    });
    return token;
  });
}
/** External full role/position confirmation or registered same-position view; never infer trust from disk. */
export function verifyLedgerSnapshot(input: {
  readonly snapshot: Uint8Array;
  readonly trust: SnapshotTrust | VerifiedViewSnapshotTrust;
}): Result.Result<LedgerView, LedgerError> {
  return Result.gen(function* () {
    if (!input?.trust) return yield* fail('unauthorized');
    if (input.trust.source === 'verified-view') {
      const pin = snapshotPins.get(input.trust);
      if (!pin) return yield* fail('unauthorized');
      const state = yield* verifiedSnapshotState(input.snapshot, pin.facts);
      const expected = yield* proposalOf(states.get(pin.view)!, pin.facts.endorser),
        actual = yield* proposalOf(state, pin.facts.endorser);
      if (!bytesEqual(expected.bodyBytes, actual.bodyBytes))
        return yield* fail('checkpoint-mismatch');
      return pin.view;
    }
    return viewOf(yield* verifiedSnapshotState(input.snapshot, input.trust));
  });
}
/** Canonical snapshot body and signing bytes of a genuine view, for `signer` to endorse. */
export function prepareLedgerSnapshot(view: LedgerView, signer: SigningPublicKey) {
  const state = states.get(view);
  return state ? proposalOf(state, signer) : fail('unauthorized');
}
/** The tuple two devices compare out of band to detect a forked ledger. */
export function comparisonNote(view: LedgerView, signer: SigningPublicKey) {
  const state = states.get(view);
  return state ? noteOf(state, signer) : fail('unauthorized');
}
/**
 * The comparison digest of a genuine view without naming a note signer, for a
 * reader that holds no device in this ledger. Equal to its comparison notes' digest.
 */
export function ledgerStateDigest(view: LedgerView) {
  const state = states.get(view);
  return state ? stateDigestOf(state) : fail('unauthorized');
}
/** Who authored historical content: the device's member instance and user at admission. */
export type HistoricalContentIdentity = HistoricalContentAuthor & { readonly kind: 'member' };
/**
 * Every source (full replay, a qualified endorsed snapshot, retained state) carries
 * the full device history, so any device this ledger ever admitted has an author.
 */
export function historicalContentIdentity(
  view: LedgerView,
  device: SigningPublicKey
): Result.Result<HistoricalContentIdentity, LedgerError> {
  return Result.gen(function* () {
    const state = states.get(view);
    if (!state) return yield* fail('unauthorized');
    const key = yield* Result.mapError(
      signingPublicKey(device.toBytes()),
      (error) => new LedgerError({ code: error.code })
    );
    const record = stateGet(state.deviceHistory, keyId(key.toBytes()));
    if (!record) return yield* fail('unauthorized');
    return Object.freeze({
      kind: 'member' as const,
      device: key,
      actor: stateGet(state.membershipUsers, keyId(record.membershipId.toBytes()))!,
      memberInstance: record.membershipId,
    });
  });
}

/** Internal admission-kind lookup over genuine retained history; this grants no current or historical permission. */
export function historicalDeviceKind(view: LedgerView, device: SigningPublicKey) {
  return Result.map(
    historicalContentIdentity(view, device),
    (author) => stateGet(states.get(view)!.deviceHistory, keyId(author.device.toBytes()))!.kind
  );
}

/** Only actually retained verified hashes, never an inspection object or invented pre-snapshot entry. */
export function hasVerifiedRecordHash(
  view: LedgerView,
  hash: RecordHash
): Result.Result<boolean, LedgerError> {
  const state = states.get(view);
  if (!state) return fail('unauthorized');
  return Result.gen(function* () {
    const owned = yield* Result.mapError(
      importHash(hash),
      (error) => new LedgerError({ code: error.code })
    );
    return Chunk.some(state.hashes, (known) => known.equals(owned));
  });
}
function importHash(hash: RecordHash) {
  return recordHash(hash.toBytes());
}

/** Whether a genuine view contains the checkpoint (head at that length) in its verified history. */
export function hasVerifiedCheckpoint(
  view: LedgerView,
  point: LedgerCheckpoint
): Result.Result<boolean, LedgerError> {
  const state = states.get(view);
  if (!state) return fail('unauthorized');
  return Result.gen(function* () {
    if (!Number.isSafeInteger(point.length) || point.length < 1)
      return yield* fail('checkpoint-mismatch');
    const owned = yield* Result.mapError(
      recordHash(point.head.toBytes()),
      (error) => new LedgerError({ code: error.code })
    );
    const index = point.length - 1 - state.hashesOffset;
    const known = index >= 0 ? hashAt(state, index) : undefined;
    return !!known && known.equals(owned);
  });
}
