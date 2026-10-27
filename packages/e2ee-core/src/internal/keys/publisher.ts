import { Context, Effect, Layer, Result, Schema, Semaphore } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import * as Bytes from '../foundation/bytes';
import { bytesEqual, decodeSnapshotCbor, encodeCbor, encodeSnapshotCbor } from '../foundation/cbor';
import { copyEpochKeyBytes, disposeEpochKey } from '../foundation/epoch-key';
import { keyId } from '../foundation/identifiers';
import {
  decodeRecord,
  epochHistoryPacket,
  extendLedger,
  hashRecordBytes,
  hasVerifiedCheckpoint,
  hasVerifiedRecordHash,
  type LedgerView,
  type Operation,
} from '../ledger';
import { prepareLedgerRecord, signLedgerRecord } from '../ledger/signing';
import { VerifiedLedger, type VerifiedLedgerError } from '../ledger/verified-ledger';
import { makeAdmissionGate, own, ownIdentity } from '../lifecycle';
import { LedgerSubmission, SubmissionError, type SubmissionFailure } from '../submission';
import type { ContentError, ValidationError } from '../foundation/errors';
import type { LedgerError } from '../ledger/errors';
import type { HpkePrimitiveError } from '../crypto/hpke';
import type { EpochKeyError } from './history';
import type { EpochStagingError } from './staging';
import type { BackendError, LocalStoreError } from '../../services/errors';
import { CandidateProtector, EpochStagingStore } from '../../services/keys';
import type { SubmissionResult } from '../../services/ledger';
import { EpochCandidateStore, type EpochCandidateRow } from '../../services/stores';
import { DeviceIdentity, WorkspaceScope } from '../../services/workspace';
import { prepareEpochEnvelope } from './envelope';
import { commitEpochKey, openHistoryPacket, sealHistoryPacket } from './history';
import { InstalledEpochKeys, type InstalledKeyError } from './installed-keys';
import {
  getCommittedEpochStagingKey,
  authenticateEpochStagedGroup,
  obsoleteEpochStagedGroup,
  ownEpochStagedGroup,
  sameEpochStagedGroup,
  type EpochStagedGroup,
} from './staging';

/**
 * An epoch publication step failed.
 *
 * - `busy`: another rotation or ledger submission is in flight; resume it first.
 * - `unauthorized`: this device may not rotate (or remove that member).
 * - `rotation-not-required`: the current epoch does not need a rotation.
 * - `context-changed`: the ledger moved while the rotation was being prepared.
 * - `candidate-missing`: a rotation record is in flight but its local
 *   candidate is gone and no independently verified installed key is available yet;
 *   receive the committed key, then resume the same submission.
 * - `stage-readback`: the staging store did not return the exact group.
 * - `native-failed`: the {@link CandidateProtector} failed.
 *
 * @category Errors
 */
export class EpochPublishError extends Schema.TaggedError<EpochPublishError>()(
  'EpochPublishError',
  {
    reason: Schema.Literals([
      'closed',
      'storage',
      'corrupt',
      'rollback',
      'busy',
      'unauthorized',
      'context-changed',
      'candidate-missing',
      'native-failed',
      'rotation-not-required',
      'stage-readback',
    ]),
  }
) {}
const fail = (reason: EpochPublishError['reason']) => new EpochPublishError({ reason });
const fromStore = (error: LocalStoreError) =>
  fail(
    error.reason === 'closed'
      ? 'closed'
      : error.reason === 'storage'
        ? 'storage'
        : error.reason === 'conflict'
          ? 'busy'
          : 'corrupt'
  );
const fromLedger = (error: VerifiedLedgerError) =>
  fail(
    error.reason === 'rollback' ? 'rollback' : error.reason === 'corrupt' ? 'corrupt' : 'storage'
  );
const fromSubmission = <E>(error: E): E | EpochPublishError =>
  error instanceof SubmissionError && error.reason === 'busy' ? fail('busy') : error;

/**
 * Every failure an {@link EpochPublisher} step can report: its own
 * {@link EpochPublishError}, a submission or staging backend failure, an
 * installed-key failure, or a protocol rejection while building the rotation.
 */
export type EpochPublishFailure =
  | EpochPublishError
  | SubmissionFailure
  | InstalledKeyError
  | BackendError
  | ContentError
  | ValidationError
  | LedgerError
  | EpochKeyError
  | EpochStagingError
  | HpkePrimitiveError;

/** A finished publication: the submission result plus the published epoch. */
export interface EpochPublishResult extends SubmissionResult {
  readonly epoch: number;
  /** Binding at this attempt's first successful local installation, not current authority. */
  readonly binding: 'current' | 'historical' | null;
}

const MAX_BLOB = 24576;
const MAX_ENVELOPES = 2 * 1024 * 1024;
const purpose = new TextEncoder().encode('lody-e2ee/local-epoch-candidate/v1\0');
const HEADER = purpose.length + 32 * 6 + 4 * 3;
const publication = (
  operation: Operation
): operation is Extract<Operation, { type: 'publishEpoch' | 'removeMemberAndPublishEpoch' }> =>
  operation.type === 'publishEpoch' || operation.type === 'removeMemberAndPublishEpoch';
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));
const same = (a: EpochCandidateRow, b: EpochCandidateRow) =>
  a.id === b.id &&
  a.parentCount === b.parentCount &&
  a.epoch === b.epoch &&
  bytesEqual(a.parent, b.parent) &&
  bytesEqual(a.commitment, b.commitment) &&
  bytesEqual(a.record, b.record) &&
  bytesEqual(a.envelopes, b.envelopes) &&
  bytesEqual(a.blob, b.blob) &&
  a.outcome === b.outcome &&
  a.binding === b.binding &&
  a.consumed === b.consumed;

/**
 * Rotate the workspace epoch key: generate a key, sign the rotation record,
 * stage an envelope for every current device and submit the record.
 *
 * Stage-before-commit: the complete envelope group is stored in
 * {@link EpochStagingStore} and read back before the record is appended, so
 * once the ledger contains the record every device can obtain the key even if
 * this device disappears. The candidate (record, envelopes, protected key) is
 * kept in {@link EpochCandidateStore} first, so `resume` finishes the same
 * rotation after a crash instead of generating another key.
 *
 * Only an owner or admin personal device may rotate; only an owner may remove a
 * member (`publishRemoving`). Results stay until `acknowledge`.
 *
 * @category Workflows
 */
export class EpochPublisher extends Context.Service<
  EpochPublisher,
  {
    /** Publish the next epoch when the current one requires rotation. */
    publish(): Effect.Effect<EpochPublishResult, EpochPublishFailure>;
    /** Remove `membership`'s devices and publish the next epoch in one signed record. */
    publishRemoving(
      membership: Bytes.MembershipId
    ): Effect.Effect<EpochPublishResult, EpochPublishFailure>;
    /** Finish the original rotation, if any. A journaled publication resumes CAS
     * without repeating staging; candidate/key and verified installation checks remain. */
    resume(): Effect.Effect<EpochPublishResult | null, EpochPublishFailure>;
    /** The local result of the unconsumed rotation, without contacting the backend. */
    result(): Effect.Effect<EpochPublishResult | null, EpochPublishError>;
    /** Delete this device's staged group once a different commitment occupies its epoch. */
    cleanupStaged(): Effect.Effect<boolean, EpochPublishFailure>;
    /** Release a finished rotation (and its submission) so the next one can start. */
    acknowledge(expected: EpochPublishResult): Effect.Effect<void, EpochPublishFailure>;
  }
>()('@lody/e2ee-core/EpochPublisher') {
  /**
   * Requires {@link WorkspaceScope}, {@link DeviceIdentity}, `VerifiedLedger`,
   * `InstalledEpochKeys`, {@link CandidateProtector}, {@link EpochStagingStore},
   * `LedgerSubmission` and {@link EpochCandidateStore}.
   */
  static readonly layer = Layer.effect(
    EpochPublisher,
    Effect.gen(function* () {
      const anchor = (yield* WorkspaceScope).genesis;
      const signer = ownIdentity(yield* DeviceIdentity).signer;
      const publicKey = signer.publicKey;
      const ledger = yield* VerifiedLedger;
      const installed = yield* InstalledEpochKeys;
      const protector = own(yield* CandidateProtector);
      const staging = own(yield* EpochStagingStore);
      const submission = yield* LedgerSubmission;
      const candidates = own(yield* EpochCandidateStore);
      const gate = yield* makeAdmissionGate(() => fail('closed'));
      const serial = yield* Semaphore.make(1);
      const org = keyId(anchor.toBytes()),
        publisher = keyId(publicKey.toBytes());
      const store = <A>(effect: Effect.Effect<A, LocalStoreError>) =>
        gate.guard.pipe(Effect.flatMap(() => effect.pipe(Effect.mapError(fromStore))));
      const submit = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.mapError(fromSubmission));

      const current = Effect.fnUntraced(function* () {
        yield* gate.guard;
        const view = yield* ledger.current().pipe(Effect.mapError(fromLedger));
        yield* gate.guard;
        return view;
      });
      const manager = (view: LedgerView, removing?: Bytes.MembershipId) => {
        const state = view.inspectState(),
          device = state.devices.get(publisher),
          member = device && state.members.get(keyId(device.membershipId.toBytes()));
        if (
          device?.kind !== 'personal' ||
          !member ||
          (member.role !== 'owner' && member.role !== 'admin')
        )
          return Effect.fail(fail('unauthorized'));
        if (
          removing &&
          (member.role !== 'owner' ||
            removing.equals(state.owner) ||
            !state.members.has(keyId(removing.toBytes())))
        )
          return Effect.fail(fail('unauthorized'));
        return Effect.void;
      };
      const validate = (row: EpochCandidateRow): EpochCandidateRow => {
        if (
          row.parent.length !== 32 ||
          row.commitment.length !== 32 ||
          !Number.isSafeInteger(row.parentCount) ||
          row.parentCount < 1 ||
          row.parentCount > 0xffffffff ||
          row.epoch < 1 ||
          row.epoch > 0xffffffff ||
          row.record.length < 1 ||
          row.record.length > 8192 ||
          (row.blob.length < 1 && row.outcome !== 'Conflict') ||
          (row.outcome === 'Conflict' && row.blob.length !== 0) ||
          row.envelopes.length < 1 ||
          row.envelopes.length > MAX_ENVELOPES ||
          row.blob.length > MAX_BLOB ||
          row.id !== keyId(hashRecordBytes(row.record).toBytes()) ||
          (row.outcome === null && (row.binding !== null || row.consumed)) ||
          (row.outcome === 'Committed' && row.binding === null) ||
          (row.outcome === 'Conflict' && row.binding !== null)
        )
          throw fail('corrupt');
        const decoded = Result.getOrThrow(decodeRecord(row.record));
        if (
          decoded.body.type !== 'ordinary' ||
          !decoded.body.signer.equals(publicKey) ||
          !bytesEqual(decoded.body.previousHash.toBytes(), row.parent) ||
          !publication(decoded.body.operation) ||
          decoded.body.operation.epoch !== row.epoch ||
          !bytesEqual(decoded.body.operation.commitment.toBytes(), row.commitment)
        )
          throw fail('corrupt');
        return row;
      };
      const checked = (row: EpochCandidateRow | null) =>
        Effect.try({ try: () => row && validate(row), catch: () => fail('corrupt') });
      const loadActive = () => store(candidates.active()).pipe(Effect.flatMap(checked));
      const load = (id: string) => store(candidates.load(id)).pipe(Effect.flatMap(checked));
      const replace = Effect.fnUntraced(function* (
        expected: EpochCandidateRow,
        next: EpochCandidateRow
      ) {
        yield* store(candidates.replace(expected, next));
        const after = yield* load(expected.id);
        if (!after || !same(after, next)) return yield* fail('corrupt');
        return undefined;
      });
      const group = (row: EpochCandidateRow): EpochStagedGroup => {
        const decoded = Result.getOrThrow(decodeSnapshotCbor(row.envelopes));
        if (!Array.isArray(decoded)) throw fail('corrupt');
        const envelopes = decoded.map((item) => {
          if (
            !Array.isArray(item) ||
            item.length !== 2 ||
            !(item[0] instanceof Uint8Array) ||
            !(item[1] instanceof Uint8Array)
          )
            throw fail('corrupt');
          return { recipient: keyId(item[0]), frame: item[1] };
        });
        return Result.getOrThrow(
          ownEpochStagedGroup({
            genesis: org,
            epoch: row.epoch,
            commitment: keyId(row.commitment),
            recordHash: row.id,
            record: row.record,
            envelopes,
          })
        );
      };
      const groupOf = (row: EpochCandidateRow) =>
        Effect.try({
          try: () => group(row),
          catch: (error) => (error instanceof EpochPublishError ? error : fail('corrupt')),
        });
      const payload = (row: EpochCandidateRow, key: Bytes.EpochKey) => {
        const body = new Uint8Array(HEADER + row.record.length + 32),
          cursor = new DataView(body.buffer);
        let at = 0;
        body.set(purpose, at);
        at += purpose.length;
        for (const bytes of [
          anchor.toBytes(),
          publicKey.toBytes(),
          row.parent,
          row.commitment,
          hashRecordBytes(row.record).toBytes(),
          sha256(row.envelopes),
        ]) {
          body.set(bytes, at);
          at += 32;
        }
        cursor.setUint32(at, row.parentCount);
        at += 4;
        cursor.setUint32(at, row.epoch);
        at += 4;
        cursor.setUint32(at, row.record.length);
        at += 4;
        body.set(row.record, at);
        at += row.record.length;
        const raw = copyEpochKeyBytes(key);
        try {
          body.set(raw, at);
        } finally {
          raw.fill(0);
        }
        return body;
      };
      const withKey = <A, E, R>(
        row: EpochCandidateRow,
        work: (key: Bytes.EpochKey) => Effect.Effect<A, E, R>
      ) =>
        Effect.acquireUseRelease(
          Effect.uninterruptible(protector.unprotect(new Uint8Array(row.blob))).pipe(
            Effect.mapError(() => fail('native-failed'))
          ),
          (body) =>
            Effect.gen(function* () {
              if (!(body instanceof Uint8Array) || body.length !== HEADER + row.record.length + 32)
                return yield* fail('corrupt');
              return yield* Effect.acquireUseRelease(
                Effect.fromResult(Bytes.epochKey(body.subarray(body.length - 32))),
                (key) =>
                  Effect.gen(function* () {
                    const expected = payload(row, key);
                    try {
                      if (!bytesEqual(body, expected)) return yield* fail('corrupt');
                    } finally {
                      expected.fill(0);
                    }
                    const committed = yield* Effect.fromResult(
                      commitEpochKey(anchor, row.epoch, key)
                    );
                    if (!bytesEqual(committed.toBytes(), row.commitment))
                      return yield* fail('corrupt');
                    return yield* work(key);
                  }),
                (key) => Effect.sync(() => disposeEpochKey(key))
              );
            }),
          (body) =>
            Effect.sync(() => {
              if (body instanceof Uint8Array) body.fill(0);
            })
        );
      const binding = (
        view: LedgerView,
        row: EpochCandidateRow
      ): 'current' | 'historical' | null => {
        const parent = Result.getOrThrow(Bytes.recordHash(row.parent));
        if (
          !Result.getOrThrow(hasVerifiedCheckpoint(view, { head: parent, length: row.parentCount }))
        )
          throw fail('context-changed');
        if (
          !Result.getOrThrow(
            hasVerifiedCheckpoint(view, {
              head: hashRecordBytes(row.record),
              length: row.parentCount + 1,
            })
          )
        )
          return null;
        const packet = Result.getOrThrow(epochHistoryPacket(view, row.epoch));
        const record = Result.getOrThrow(decodeRecord(row.record));
        if (
          record.body.type !== 'ordinary' ||
          !publication(record.body.operation) ||
          !bytesEqual(packet.commitment.toBytes(), row.commitment) ||
          !bytesEqual(packet.packet, record.body.operation.previousEpochKey)
        )
          throw fail('corrupt');
        return view.inspectState().epoch.number === row.epoch ? 'current' : 'historical';
      };
      const bindingOf = (view: LedgerView, row: EpochCandidateRow) =>
        Effect.try({
          try: () => binding(view, row),
          catch: (error) => (error instanceof EpochPublishError ? error : fail('corrupt')),
        });
      const result = (row: EpochCandidateRow): EpochPublishResult | null =>
        row.outcome
          ? {
              outcome: row.outcome,
              record: new Uint8Array(row.record),
              epoch: row.epoch,
              binding: row.binding,
            }
          : null;

      const confirm = Effect.fnUntraced(function* (
        row: EpochCandidateRow,
        outcome: 'Committed' | 'Conflict',
        key?: Bytes.EpochKey
      ) {
        const view = yield* current();
        const bound = yield* bindingOf(view, row);
        if (outcome === 'Committed') {
          if (!bound || !key) return yield* fail('context-changed');
          yield* installed.saveAndReload(row.epoch, key);
          yield* Effect.acquireUseRelease(
            installed.read(row.epoch),
            Effect.fnUntraced(function* (copy) {
              const commitment = yield* Effect.fromResult(commitEpochKey(anchor, row.epoch, copy));
              if (!bytesEqual(commitment.toBytes(), row.commitment)) return yield* fail('corrupt');
              return undefined;
            }),
            (copy) => Effect.sync(() => disposeEpochKey(copy))
          );
        } else if (bound || view.length <= row.parentCount) return yield* fail('context-changed');
        if (row.outcome && row.outcome !== outcome) return yield* fail('corrupt');
        // Binding reports the first confirmed local installation. A later epoch must
        // not invalidate acknowledgement of the same durable original/result.
        const next: EpochCandidateRow = {
          ...row,
          blob: outcome === 'Conflict' ? new Uint8Array() : row.blob,
          outcome,
          binding: row.outcome ? row.binding : bound,
        };
        if (!same(next, row)) yield* replace(row, next);
        return result(next)!;
      });
      const settle = (row: EpochCandidateRow) => {
        const work = (key?: Bytes.EpochKey) =>
          Effect.gen(function* () {
            const view = yield* current();
            const bound = yield* bindingOf(view, row);
            const entry = yield* submit(submission.pending());
            if (entry.record && !bytesEqual(entry.record, row.record)) return yield* fail('busy');
            if (row.outcome && !entry.record) return yield* confirm(row, row.outcome, key);
            // First submission requires exact staging/readback. A matching journal
            // original has already passed that boundary and resumes CAS independently
            // of staging availability. An advanced verified prefix reconciles only.
            if (!entry.record && !bound && view.length === row.parentCount) {
              const proposed = yield* Effect.fromResult(
                extendLedger(view, [row.record], {
                  head: hashRecordBytes(row.record),
                  length: view.length + 1,
                })
              );
              const original = yield* groupOf(row);
              yield* Effect.fromResult(authenticateEpochStagedGroup(proposed, original, true));
              yield* staging.stageGroup(yield* Effect.fromResult(ownEpochStagedGroup(original)));
              const stored = yield* staging.readGroup(original);
              if (!stored) return yield* fail('stage-readback');
              const owned = yield* Effect.fromResult(ownEpochStagedGroup(stored));
              if (!sameEpochStagedGroup(original, owned)) return yield* fail('stage-readback');
              yield* Effect.fromResult(authenticateEpochStagedGroup(proposed, owned, true));
            }
            const submitted = entry.record
              ? yield* submit(submission.resume())
              : yield* submit(submission.submit(row.record));
            if (!submitted || !bytesEqual(submitted.record, row.record))
              return yield* fail('corrupt');
            return yield* confirm(row, submitted.outcome, key);
          });
        return Effect.gen(function* () {
          const view = yield* current();
          const bound = yield* bindingOf(view, row);
          if (row.outcome === 'Conflict' || (!bound && view.length > row.parentCount))
            return yield* work();
          // An independently installed committed key outlives the unpublished candidate.
          if (bound) {
            const installedResult = yield* Effect.result(installed.check(row.epoch));
            if (Result.isSuccess(installedResult))
              return yield* Effect.acquireUseRelease(installed.read(row.epoch), work, (key) =>
                Effect.sync(() => disposeEpochKey(key))
              );
            if (installedResult.failure.reason !== 'missing-key')
              return yield* installedResult.failure;
          }
          return yield* withKey(row, work);
        });
      };

      // A missing candidate never authorizes a replacement signature. Reconcile the
      // submission's exact bytes, then require genuine feed and installed-key proof.
      const recoverMissing = Effect.fnUntraced(function* () {
        const entry = yield* submit(submission.pending());
        if (!entry.record) return null;
        const parsed = yield* Effect.fromResult(decodeRecord(entry.record));
        if (parsed.body.type !== 'ordinary' || !publication(parsed.body.operation)) return null;
        if (!parsed.body.signer.equals(publicKey)) return yield* fail('corrupt');
        const known = yield* current();
        const locator = getCommittedEpochStagingKey(known, parsed.body.operation.epoch);
        const published =
          Result.isSuccess(locator) &&
          locator.success.recordHash === keyId(hashRecordBytes(entry.record).toBytes());
        const occupied = Result.isSuccess(locator) && !published;
        const parentKnown = yield* Effect.fromResult(
          hasVerifiedRecordHash(known, parsed.body.previousHash)
        );
        if (
          !published &&
          !occupied &&
          (!parentKnown || known.head.equals(parsed.body.previousHash))
        )
          return yield* fail('candidate-missing');
        const done = yield* submit(submission.resume());
        if (!done) return yield* fail('candidate-missing');
        const after = yield* submit(submission.pending());
        const view = yield* current();
        if (!after.checkpoint || !Result.getOrThrow(hasVerifiedCheckpoint(view, after.checkpoint)))
          return yield* fail('context-changed');
        const epoch = parsed.body.operation.epoch;
        if (done.outcome === 'Committed') {
          const located = yield* Effect.fromResult(getCommittedEpochStagingKey(view, epoch));
          if (located.recordHash !== keyId(hashRecordBytes(done.record).toBytes()))
            return yield* fail('corrupt');
          yield* installed
            .check(epoch)
            .pipe(
              Effect.mapError((error) =>
                error.reason === 'missing-key' ? fail('candidate-missing') : error
              )
            );
        }
        return {
          ...done,
          epoch,
          binding:
            done.outcome === 'Conflict'
              ? null
              : view.inspectState().epoch.number === epoch
                ? ('current' as const)
                : ('historical' as const),
        };
      });

      const resume = Effect.fnUntraced(function* () {
        yield* current();
        const row = yield* loadActive();
        if (row) return yield* settle(row);
        return yield* recoverMissing();
      });

      const generate = Effect.fnUntraced(function* (
        view: LedgerView,
        target: Bytes.MembershipId | undefined,
        previous: Bytes.EpochKey,
        key: Bytes.EpochKey
      ) {
        const state = view.inspectState(),
          epoch = yield* Effect.fromResult(Bytes.epochNumber(state.epoch.number + 1));
        const old = yield* Effect.fromResult(commitEpochKey(anchor, state.epoch.number, previous));
        if (!old.equals(state.epoch.keyCommitment)) return yield* fail('corrupt');
        const commitment = yield* Effect.fromResult(commitEpochKey(anchor, epoch, key)),
          packet = yield* Effect.fromResult(
            sealHistoryPacket({ genesis: anchor, epoch, currentKey: key, previousKey: previous })
          );
        yield* Effect.acquireUseRelease(
          Effect.fromResult(openHistoryPacket({ genesis: anchor, epoch, currentKey: key, packet })),
          Effect.fnUntraced(function* (restored) {
            const restoredCommitment = yield* Effect.fromResult(
              commitEpochKey(anchor, state.epoch.number, restored)
            );
            if (!restoredCommitment.equals(state.epoch.keyCommitment))
              return yield* fail('corrupt');
            return undefined;
          }),
          (restored) => Effect.sync(() => disposeEpochKey(restored))
        );
        const body = yield* Effect.fromResult(
          encodeCbor([
            view.head.toBytes(),
            publicKey.toBytes(),
            target
              ? [8, target.toBytes(), epoch, commitment.toBytes(), packet]
              : [7, epoch, commitment.toBytes(), packet],
          ])
        );
        const proposal = yield* Effect.fromResult(prepareLedgerRecord(view, body));
        const record = yield* signLedgerRecord(proposal, signer);
        const proposed = yield* Effect.fromResult(
          extendLedger(view, [record], { head: hashRecordBytes(record), length: view.length + 1 })
        );
        const envelopes: { recipient: string; frame: Uint8Array }[] = [];
        for (const [recipient] of [...proposed.inspectState().devices].sort(([a], [b]) =>
          a.localeCompare(b)
        )) {
          envelopes.push({
            recipient,
            frame: yield* prepareEpochEnvelope({
              context: {
                genesis: anchor,
                epoch,
                sender: publicKey,
                recipient: yield* Effect.fromResult(Bytes.signingPublicKey(fromHex(recipient))),
              },
              key,
              signer,
              ledger: current,
              candidate: { before: view, record },
            }),
          });
        }
        const originals = yield* Effect.fromResult(
          ownEpochStagedGroup({
            genesis: org,
            epoch,
            commitment: keyId(commitment.toBytes()),
            recordHash: keyId(hashRecordBytes(record).toBytes()),
            record,
            envelopes,
          })
        );
        yield* Effect.fromResult(authenticateEpochStagedGroup(proposed, originals, true));
        const envelopeBytes = yield* Effect.fromResult(
          encodeSnapshotCbor(
            originals.envelopes.map((item) => [fromHex(item.recipient), item.frame])
          )
        );
        if (envelopeBytes.length > MAX_ENVELOPES) return yield* fail('corrupt');
        const row: EpochCandidateRow = {
          id: keyId(hashRecordBytes(record).toBytes()),
          parent: view.head.toBytes(),
          parentCount: view.length,
          epoch,
          commitment: commitment.toBytes(),
          record,
          envelopes: envelopeBytes,
          blob: new Uint8Array(),
          outcome: null,
          binding: null,
          consumed: false,
        };
        const blob = yield* Effect.acquireUseRelease(
          Effect.sync(() => payload(row, key)),
          (raw) =>
            Effect.uninterruptible(protector.protect(raw)).pipe(
              Effect.mapError(() => fail('native-failed')),
              Effect.flatMap((output) =>
                output instanceof Uint8Array && output.length > 0 && output.length <= MAX_BLOB
                  ? Effect.succeed(new Uint8Array(output))
                  : Effect.fail(fail('corrupt'))
              )
            ),
          (raw) => Effect.sync(() => raw.fill(0))
        );
        return { ...row, blob };
      });

      const publish = Effect.fnUntraced(function* (removing?: Bytes.MembershipId) {
        const target = removing
          ? yield* Effect.fromResult(Bytes.membershipId(removing.toBytes()))
          : undefined;
        const view = yield* current();
        const existing = yield* loadActive();
        if (existing) {
          const decoded = yield* Effect.fromResult(decodeRecord(existing.record));
          if (
            decoded.body.type !== 'ordinary' ||
            (target
              ? decoded.body.operation.type !== 'removeMemberAndPublishEpoch' ||
                !decoded.body.operation.membershipId.equals(target)
              : decoded.body.operation.type !== 'publishEpoch')
          )
            return yield* fail('busy');
          return yield* settle(existing);
        }
        const pending = yield* submit(submission.pending());
        if (pending.record) {
          const decoded = yield* Effect.fromResult(decodeRecord(pending.record));
          if (decoded.body.type !== 'ordinary' || !publication(decoded.body.operation))
            return yield* fail('busy');
          const operation = decoded.body.operation;
          if (
            target
              ? operation.type !== 'removeMemberAndPublishEpoch' ||
                !operation.membershipId.equals(target)
              : operation.type !== 'publishEpoch'
          )
            return yield* fail('busy');
          const recovered = yield* recoverMissing();
          return recovered ?? (yield* fail('candidate-missing'));
        }
        yield* manager(view, target);
        if (!target && !view.inspectState().epoch.rotationRequired)
          return yield* fail('rotation-not-required');
        const row = yield* Effect.acquireUseRelease(
          installed.read(view.inspectState().epoch.number),
          (previous) =>
            Effect.acquireUseRelease(
              Effect.try({
                try: () => {
                  const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
                  try {
                    return Result.getOrThrow(Bytes.epochKey(raw));
                  } finally {
                    raw.fill(0);
                  }
                },
                catch: () => fail('storage'),
              }),
              (key) => generate(view, target, previous, key),
              (key) => Effect.sync(() => disposeEpochKey(key))
            ),
          (previous) => Effect.sync(() => disposeEpochKey(previous))
        );
        const now = yield* current();
        yield* manager(now, target);
        if (!now.head.equals(view.head) || now.length !== view.length)
          return yield* fail('context-changed');
        yield* store(candidates.insert(row));
        // The actual stored blob must open before the first submission can begin.
        const stored = yield* load(row.id);
        if (!stored || !same(stored, row)) return yield* fail('corrupt');
        return yield* settle(stored);
      });

      const acknowledge = Effect.fnUntraced(function* (expected: EpochPublishResult) {
        const original = (yield* Effect.fromResult(decodeRecord(expected.record))).recordBytes;
        const id = keyId(hashRecordBytes(original).toBytes()),
          row = yield* load(id);
        if (!row) {
          const pendingEntry = yield* submit(submission.pending());
          if (!pendingEntry.record || !bytesEqual(pendingEntry.record, original))
            return yield* fail('busy');
          const recovered = yield* recoverMissing();
          if (
            !recovered ||
            recovered.outcome !== expected.outcome ||
            recovered.epoch !== expected.epoch ||
            !bytesEqual(recovered.record, original)
          )
            return yield* fail('candidate-missing');
          yield* submit(submission.acknowledge(recovered));
          return undefined;
        }
        if (
          !row ||
          !row.outcome ||
          row.outcome !== expected.outcome ||
          row.epoch !== expected.epoch ||
          row.binding !== expected.binding
        )
          return yield* fail('corrupt');
        if (row.consumed) return undefined;
        const settled = yield* settle(row);
        if (settled.outcome !== expected.outcome || settled.binding !== expected.binding)
          return yield* fail('corrupt');
        const entry = yield* submit(submission.pending());
        if (entry.record) {
          if (!bytesEqual(entry.record, original) || entry.outcome !== expected.outcome)
            return yield* fail('busy');
          yield* submit(submission.acknowledge({ outcome: expected.outcome, record: original }));
        }
        yield* current();
        yield* replace(row, { ...row, consumed: true });
        return undefined;
      });

      const cleanupStaged = Effect.fnUntraced(function* () {
        const view = yield* current();
        const row = yield* loadActive();
        if (!row) return false;
        const original = yield* groupOf(row);
        const occupied = yield* Effect.fromResult(obsoleteEpochStagedGroup(view, original));
        yield* staging.deleteGroup(original, occupied);
        if ((yield* staging.readGroup(original)) !== null) return yield* fail('stage-readback');
        return true;
      });

      const lease = <A, E, R>(work: Effect.Effect<A, E, R>) => gate.run(serial.withPermit(work));
      return EpochPublisher.of({
        publish: Effect.fn('@lody/e2ee-core/EpochPublisher.publish')(function* () {
          return yield* lease(publish());
        }),
        publishRemoving: Effect.fn('@lody/e2ee-core/EpochPublisher.publishRemoving')(
          function* (membership) {
            return yield* lease(publish(membership));
          }
        ),
        resume: Effect.fn('@lody/e2ee-core/EpochPublisher.resume')(function* () {
          return yield* lease(resume());
        }),
        result: Effect.fn('@lody/e2ee-core/EpochPublisher.result')(function* () {
          return yield* lease(loadActive().pipe(Effect.map((row) => (row ? result(row) : null))));
        }),
        cleanupStaged: Effect.fn('@lody/e2ee-core/EpochPublisher.cleanupStaged')(function* () {
          return yield* lease(cleanupStaged());
        }),
        acknowledge: Effect.fn('@lody/e2ee-core/EpochPublisher.acknowledge')(function* (expected) {
          return yield* lease(
            acknowledge({ ...expected, record: new Uint8Array(expected.record) })
          );
        }),
      });
    })
  );
}
