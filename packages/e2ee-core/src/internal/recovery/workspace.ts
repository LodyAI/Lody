import { Clock, Effect, Result, Schema, Semaphore } from 'effect';
import * as Bytes from '../foundation/bytes';
import { bytesEqual } from '../foundation/cbor';
import { copyEpochKeyBytes, disposeEpochKey } from '../foundation/epoch-key';
import {
  epochHistoryPacket,
  hasVerifiedCheckpoint,
  hashRecordBytes,
  requireLedgerContinuation,
  verifyLedger,
  type LedgerView,
} from '../ledger';
import { prepareDeviceAdmission, prepareLedgerCommand } from '../ledger/admission';
import { decodeRecord } from '../ledger/records';
import { signLedgerRecord } from '../ledger/signing';
import type { DeviceSigner } from '../foundation/signing';
import { openEpochEnvelope, authenticateEpochEnvelopeSignature } from '../keys/envelope';
import { authenticateEpochStagedGroup, type EpochStagedGroup } from '../keys/staging';
import { openEpochKeyHpke } from '../crypto/hpke';
import { commitEpochKey, recoverLedgerHistory } from '../keys/history';
import {
  canonical,
  fromHex,
  parseCanonical,
  attempt,
  random,
  hex,
  RecoveryVaultError,
  vaultError,
} from './crypto';
import { deriveRecoveryAccessCredential } from './credential';
import { generateRecoveryPackage, importRecoveryIdentity, type RecoveryIdentity } from './identity';
import {
  wipeRecoveryPackage,
  type RecoveryEntryReference,
  type RecoveryPrivatePackage,
  type RecoveryVault,
  type RecoveryVaultLocalStore,
} from './vault';

/** Outcome of submitting a recovery ledger record. */
export type RecoverySubmitResult = {
  readonly outcome: 'Committed' | 'Conflict' | 'Pending';
  readonly record: Uint8Array;
};
/** SHA-256 of R's derived service access credential, registered with R's admission append. */
export type RecoveryCredentialRegistration = { readonly recoveryCredentialHash: Uint8Array };
/** The current epoch-key envelope addressed to a recovery device, as fetched during restore. */
export type RecoveryEnvelope =
  | { readonly sender: Bytes.SigningPublicKey; readonly frame: Uint8Array }
  | { readonly staged: EpochStagedGroup }
  /** Not delivered yet. Nothing failed: the caller reports Pending and retries. */
  | { readonly pending: true };
/** Everything the recovery workflow of one workspace needs: the vault session, local journal, identity, ledger, submission and envelope fetch. */
export interface WorkspaceRecoveryInput {
  readonly vault: RecoveryVault;
  readonly local: RecoveryVaultLocalStore;
  readonly genesis: Bytes.GenesisHash;
  readonly membershipId: Bytes.MembershipId;
  readonly personalSigner: DeviceSigner;
  readonly ledger: () => Effect.Effect<LedgerView, unknown>;
  /** Submit the exact original record. R's own admission carries the hash of R's
   * derived access credential so the service can register it with that append;
   * every other record (for example a revocation) passes null. */
  readonly submitOriginal: (
    record: Uint8Array,
    registration: RecoveryCredentialRegistration | null
  ) => Effect.Effect<RecoverySubmitResult, unknown>;
  readonly fetchCurrentEnvelope: (
    recipient: Bytes.SigningPublicKey,
    epoch: number,
    identity: RecoveryIdentity,
    /** R's derived service credential, for the mailbox read. Owned by the callee. */
    credential: Uint8Array
  ) => Effect.Effect<RecoveryEnvelope, unknown>;
  readonly installed: {
    readonly saveAndReload: (epoch: number, key: Bytes.EpochKey) => Effect.Effect<unknown, unknown>;
    readonly read: (epoch: number) => Effect.Effect<Bytes.EpochKey, unknown>;
  };
  readonly trust: {
    readonly source: string;
    readonly genesisRecord: Uint8Array;
    readonly head: string;
    readonly length: number;
  };
}
const RefSchema = Schema.Struct({
  genesis: Schema.String,
  membershipId: Schema.String,
  entryId: Schema.String,
  digest: Schema.String,
  generation: Schema.Number,
  retired: Schema.Boolean,
});
const ProgressSchema = Schema.Struct({
  entryId: Schema.String,
  reference: Schema.NullOr(RefSchema),
  recoveryDevice: Schema.optionalKey(Schema.String),
  record: Schema.NullOr(Schema.Uint8Array),
  recordPosition: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  stage: Schema.Literals([
    'candidate',
    'indexed',
    'registration',
    'registered',
    'enveloped',
    'recoverable',
  ]),
  lastTest: Schema.NullOr(Schema.Number),
  testedEpoch: Schema.NullOr(Schema.Number),
  envelopeEpoch: Schema.NullOr(Schema.Number),
  skipped: Schema.Boolean,
});
type Progress = typeof ProgressSchema.Type;
const RestoreSchema = Schema.Struct({
  personal: Schema.String,
  record: Schema.Uint8Array,
  position: Schema.Number,
});
const isPending = (error: unknown) =>
  error instanceof RecoveryVaultError && error.code === 'pending';
/** A resumable four-step owner. Only encrypted vault entries, original signed
 * records and non-secret progress reach local storage. Genuine ledger facts and
 * actual HPKE/commitment checks establish paired/enveloped/recoverable separately. */
export const makeWorkspaceRecovery = Effect.fnUntraced(function* (input: WorkspaceRecoveryInput) {
  const genesis = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes())),
    membership = yield* Effect.fromResult(Bytes.membershipId(input.membershipId.toBytes()));
  const vault = input.vault,
    local = input.local,
    ledger = input.ledger,
    personalSigner = input.personalSigner,
    submit = input.submitOriginal,
    fetch = input.fetchCurrentEnvelope,
    installed = input.installed;
  const trust = { ...input.trust, genesisRecord: new Uint8Array(input.trust.genesisRecord) };
  const anchor = yield* Effect.fromResult(
    verifyLedger({
      anchor: genesis,
      records: [trust.genesisRecord],
      checkpoint: { head: hashRecordBytes(trust.genesisRecord), length: 1 },
    })
  );
  if (!trust.source || trust.source.length > 2048 || anchor.length !== 1)
    return yield* vaultError('invalid-input');
  const key = `vault-v1/${vault.vaultId}/workspace/${hex(genesis.toBytes())}/${hex(membership.toBytes())}`;
  const serial = yield* Semaphore.make(1);
  let closed = false,
    observed: LedgerView | undefined;
  yield* Effect.addFinalizer(() =>
    serial.withPermit(
      Effect.sync(() => {
        closed = true;
      })
    )
  );
  const guard = () => (closed ? Effect.fail(vaultError('closed')) : Effect.void);
  const own = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    serial.withPermit(Effect.uninterruptible(work));
  const current = Effect.fnUntraced(function* () {
    yield* guard();
    const view = yield* ledger();
    yield* Effect.fromResult(requireLedgerContinuation(view, view));
    if (
      !view.genesis.equals(genesis) ||
      !view.inspectState().members.has(hex(membership.toBytes()))
    )
      return yield* vaultError('unauthorized');
    if (observed) yield* Effect.fromResult(requireLedgerContinuation(observed, view));
    observed = view;
    return view;
  });
  const load = Effect.fnUntraced(function* () {
    const raw = yield* local.read(key);
    return {
      raw,
      value: raw
        ? yield* attempt(() =>
            Result.getOrThrow(Schema.decodeUnknownResult(ProgressSchema)(parseCanonical(raw)))
          )
        : null,
    };
  });
  const save = Effect.fnUntraced(function* (before: Uint8Array | null, value: Progress) {
    const next = canonical(value);
    if ((yield* local.compareAndSwap(key, before, next)) !== 'Committed')
      return yield* vaultError('conflict');
    const read = yield* local.read(key);
    if (!read || !bytesEqual(next, read)) return yield* vaultError('storage');
    return { raw: next, value };
  });
  const active = (view: LedgerView, identity: RecoveryIdentity) => {
    const state = view.inspectState(),
      device = state.devices.get(hex(identity.publicKey.toBytes()));
    return (
      !!device &&
      device.kind === 'recovery' &&
      device.membershipId.equals(membership) &&
      device.encryptionPublicKey.equals(identity.encryptionPublicKey) &&
      state.members.has(hex(membership.toBytes()))
    );
  };
  // Older setup journals omitted the position. Locate the signed predecessor only
  // in retained verified history. Compaction may have removed that predecessor;
  // then only an already active R can finish reconciliation without its position.
  const setupPosition = Effect.fnUntraced(function* (view: LedgerView, record: Uint8Array) {
    const body = (yield* Effect.fromResult(decodeRecord(record))).body;
    if (body.type !== 'ordinary') return yield* vaultError('authentication');
    for (let length = Math.max(1, view.historyStart + 1); length <= view.length; length++) {
      if (
        yield* Effect.fromResult(hasVerifiedCheckpoint(view, { head: body.previousHash, length }))
      )
        return length + 1;
    }
    return null;
  });
  const credentials = new WeakMap<RecoveryIdentity, Uint8Array>();
  const useIdentity = <A, E, R>(
    ref: RecoveryEntryReference,
    work: (identity: RecoveryIdentity, bundle: RecoveryPrivatePackage) => Effect.Effect<A, E, R>
  ) =>
    Effect.acquireUseRelease(
      vault.readEntry(ref),
      (bundle) =>
        Effect.gen(function* () {
          if (
            bundle.genesis !== hex(genesis.toBytes()) ||
            bundle.membershipId !== hex(membership.toBytes()) ||
            !bytesEqual(bundle.trust.genesisRecord, trust.genesisRecord)
          )
            return yield* vaultError('authentication');
          const identity = yield* importRecoveryIdentity(bundle);
          const derived = yield* attempt(() => deriveRecoveryAccessCredential(bundle));
          credentials.set(identity, derived.credential);
          return yield* work(identity, bundle).pipe(
            Effect.ensuring(Effect.sync(() => derived.credential.fill(0)))
          );
        }),
      (bundle) => Effect.sync(() => wipeRecoveryPackage(bundle))
    );
  const openCurrent = Effect.fnUntraced(function* (
    identity: RecoveryIdentity,
    onEnvelope?: (epoch: number) => Effect.Effect<void, unknown>
  ) {
    const before = yield* current();
    if (!active(before, identity)) return yield* vaultError('unauthorized');
    const epoch = before.inspectState().epoch.number,
      remote = yield* fetch(
        identity.publicKey,
        epoch,
        identity,
        new Uint8Array(credentials.get(identity)!)
      );
    if ('pending' in remote) return yield* vaultError('pending');
    let keyValue: Bytes.EpochKey;
    if ('staged' in remote) {
      const qualified = yield* Effect.fromResult(
        authenticateEpochStagedGroup(before, remote.staged)
      );
      if (qualified.group.epoch !== epoch) return yield* vaultError('authentication');
      const row = qualified.group.envelopes.find(
        (item) => item.recipient === hex(identity.publicKey.toBytes())
      );
      if (!row) return yield* vaultError('missing');
      const context = {
        genesis,
        epoch: yield* Effect.fromResult(Bytes.epochNumber(epoch)),
        sender: qualified.sender,
        recipient: identity.publicKey,
      };
      const payload = yield* Effect.fromResult(
        authenticateEpochEnvelopeSignature(context, row.frame)
      );
      keyValue = yield* openEpochKeyHpke(
        identity.encryption,
        identity.encryptionPublicKey,
        context,
        payload
      );
    } else {
      keyValue = yield* openEpochEnvelope({
        context: {
          genesis,
          epoch: yield* Effect.fromResult(Bytes.epochNumber(epoch)),
          sender: remote.sender,
          recipient: identity.publicKey,
        },
        pair: identity.encryption,
        frame: remote.frame,
        ledger: current,
      });
    }
    return yield* Effect.acquireUseRelease(
      Effect.succeed(keyValue),
      (latest) =>
        Effect.gen(function* () {
          const after = yield* current();
          if (!active(after, identity) || after.inspectState().epoch.number !== epoch)
            return yield* vaultError('unauthorized');
          const fact = yield* Effect.fromResult(epochHistoryPacket(after, epoch)),
            commitment = yield* Effect.fromResult(commitEpochKey(genesis, epoch, latest));
          if (!fact.commitment.equals(commitment)) return yield* vaultError('authentication');
          if (onEnvelope) yield* onEnvelope(epoch);
          // Validate the complete signed history before the first durable save.
          return yield* Effect.acquireUseRelease(
            Effect.fromResult(recoverLedgerHistory(after, latest)),
            (keys) =>
              Effect.gen(function* () {
                yield* installed.saveAndReload(epoch, latest);
                for (const [number, epochKey] of keys)
                  yield* installed.saveAndReload(number, epochKey);
                yield* Effect.acquireUseRelease(
                  installed.read(epoch),
                  (read) =>
                    Effect.gen(function* () {
                      const actual = yield* Effect.fromResult(commitEpochKey(genesis, epoch, read));
                      if (!actual.equals(commitment)) return yield* vaultError('authentication');
                      return yield* Effect.void;
                    }),
                  (read) => Effect.sync(() => disposeEpochKey(read))
                );
                return epoch;
              }),
            (keys) =>
              Effect.sync(() => {
                for (const value of keys.values()) disposeEpochKey(value);
              })
          );
        }),
      (latest) => Effect.sync(() => disposeEpochKey(latest))
    );
  });
  const checkedStatus = Effect.fnUntraced(function* () {
    yield* guard();
    const progress = (yield* load()).value;
    if (!progress?.reference)
      return {
        paired: false,
        envelopeAvailable: false,
        recoverable: false,
        currentEpoch: null,
        testedEpoch: progress?.testedEpoch ?? null,
        lastTest: progress?.lastTest ?? null,
        skipped: progress?.skipped ?? false,
      };
    const view = yield* current();
    return yield* useIdentity(progress.reference, (identity) =>
      Effect.sync(() => {
        const paired = active(view, identity),
          currentEpoch = view.inspectState().epoch.number;
        // Stored lastTest is historical. A new epoch always needs a fresh envelope test.
        const envelopeAvailable =
          paired &&
          progress.envelopeEpoch === currentEpoch &&
          (progress.stage === 'enveloped' || progress.stage === 'recoverable');
        return {
          paired,
          envelopeAvailable,
          recoverable: envelopeAvailable && progress.stage === 'recoverable',
          currentEpoch,
          testedEpoch: progress.testedEpoch,
          lastTest: progress.lastTest,
          skipped: progress.skipped,
        };
      })
    );
  });
  const runTest = Effect.fnUntraced(function* () {
    let state = yield* load();
    if (!state.value?.reference) return yield* vaultError('missing');
    const reference = state.value.reference;
    state = yield* save(state.raw, { ...state.value, stage: 'registered', envelopeEpoch: null });
    const epoch = yield* useIdentity(reference, (identity) =>
      openCurrent(identity, (number) =>
        Effect.gen(function* () {
          state = yield* save(state.raw, {
            ...state.value!,
            stage: 'enveloped',
            envelopeEpoch: number,
          });
        })
      )
    );
    const lastTest = yield* Clock.currentTimeMillis;
    state = yield* save(state.raw, {
      ...state.value!,
      stage: 'recoverable',
      testedEpoch: epoch,
      lastTest,
    });
    return yield* checkedStatus();
  });
  const setup = Effect.fnUntraced(function* () {
    yield* current();
    let state = yield* load();
    if (!state.value)
      state = yield* save(state.raw, {
        entryId: hex(random(32)),
        reference: null,
        record: null,
        recordPosition: null,
        stage: 'candidate',
        lastTest: null,
        testedEpoch: null,
        envelopeEpoch: null,
        skipped: false,
      });
    let progress = state.value!;
    if (!progress.reference) {
      const index = yield* vault.readIndex();
      let reference = index.value.entries.find(
        (ref) =>
          !ref.retired &&
          ref.genesis === hex(genesis.toBytes()) &&
          ref.membershipId === hex(membership.toBytes())
      );
      if (!reference) {
        const candidate = yield* vault.readCandidate(progress.entryId);
        let selected: RecoveryEntryReference;
        if (candidate) {
          selected = candidate.reference;
          wipeRecoveryPackage(candidate.value);
        } else
          selected = yield* Effect.acquireUseRelease(
            generateRecoveryPackage({
              genesis: hex(genesis.toBytes()),
              membershipId: hex(membership.toBytes()),
              generation: 0,
              trust,
            }),
            (bundle) => vault.upload(bundle, progress.entryId),
            (bundle) => Effect.sync(() => wipeRecoveryPackage(bundle))
          );
        const reserved = yield* vault.reserve(selected);
        if (!reserved.reference) return yield* vaultError('conflict');
        reference = reserved.reference;
      }
      state = yield* save(state.raw, {
        ...progress,
        reference,
        entryId: reference.entryId,
        stage: 'indexed',
        skipped: false,
      });
      progress = state.value!;
    }
    const reference = progress.reference!;
    return yield* useIdentity(reference, (identity, bundle) =>
      Effect.gen(function* () {
        const registration = yield* attempt(() => {
          const derived = deriveRecoveryAccessCredential(bundle);
          derived.credential.fill(0);
          return { recoveryCredentialHash: derived.credentialHash };
        });
        let view = yield* current();
        // The record may have committed before this process died, while its P09
        // result still awaits acknowledgement. Reconcile that original before
        // advancing local stage even when the registered R is already visible.
        if (
          progress.record &&
          progress.stage === 'registration' &&
          progress.recordPosition == null
        ) {
          state = yield* save(state.raw, {
            ...progress,
            recordPosition: yield* setupPosition(view, progress.record),
          });
          progress = state.value!;
        }
        if (progress.record && progress.stage === 'registration' && active(view, identity)) {
          const resumed = yield* submit(new Uint8Array(progress.record), registration);
          if (!bytesEqual(resumed.record, progress.record))
            return yield* vaultError('authentication');
          if (resumed.outcome !== 'Committed')
            return { outcome: resumed.outcome, status: yield* checkedStatus() };
          view = yield* current();
          if (!active(view, identity)) return yield* vaultError('authentication');
          if (progress.recordPosition == null) {
            if (view.historyStart === 0) return yield* vaultError('authentication');
          } else if (
            view.historyStart < progress.recordPosition &&
            !(yield* Effect.fromResult(
              hasVerifiedCheckpoint(view, {
                head: hashRecordBytes(progress.record),
                length: progress.recordPosition,
              })
            ))
          )
            return yield* vaultError('authentication');
        }
        if (!active(view, identity)) {
          if (progress.record && progress.recordPosition == null)
            return yield* vaultError('pending');
          const previousDevice = view.inspectState().devices.get(hex(identity.publicKey.toBytes()));
          if (previousDevice) return yield* vaultError('unauthorized');
          const signAdmission = Effect.fnUntraced(function* (view: LedgerView) {
            const command = yield* prepareDeviceAdmission({
              genesis,
              membershipId: membership,
              encryptionPublicKey: identity.encryptionPublicKey,
              kind: 'recovery',
              signer: identity,
            });
            const proposal = yield* Effect.fromResult(
              prepareLedgerCommand(view, personalSigner.publicKey, command)
            );
            const record = yield* signLedgerRecord(proposal, personalSigner);
            state = yield* save(state.raw, {
              ...progress,
              record,
              recordPosition: view.length + 1,
              stage: 'registration',
            });
            progress = state.value!;
          });
          if (!progress.record) yield* signAdmission(view);
          const result = yield* submit(new Uint8Array(progress.record!), registration);
          if (!bytesEqual(result.record, progress.record!))
            return yield* vaultError('authentication');
          if (result.outcome !== 'Committed') {
            if (result.outcome === 'Conflict') {
              const after = yield* current();
              const landed = yield* Effect.fromResult(
                hasVerifiedCheckpoint(after, {
                  head: hashRecordBytes(progress.record!),
                  length: progress.recordPosition!,
                })
              );
              // Only verified facts make the original impossible. After retention,
              // complete device history still proves this R was never admitted.
              if (
                !landed &&
                after.length >= progress.recordPosition! &&
                (after.historyStart < progress.recordPosition! ||
                  after.classifyDevice?.(hex(identity.publicKey.toBytes())) === 'unknown') &&
                !active(after, identity)
              ) {
                if (after.inspectState().devices.has(hex(identity.publicKey.toBytes())))
                  return yield* vaultError('unauthorized');
                yield* signAdmission(after);
              }
            }
            return { outcome: result.outcome, status: yield* checkedStatus() };
          }
          view = yield* current();
          if (
            !active(view, identity) ||
            !(yield* Effect.fromResult(
              hasVerifiedCheckpoint(view, {
                head: hashRecordBytes(progress.record!),
                length: progress.recordPosition!,
              })
            ))
          )
            return yield* vaultError('authentication');
        }
        state = yield* save(state.raw, {
          ...progress,
          stage: 'registered',
          record: null,
          recordPosition: null,
          recoveryDevice: hex(identity.publicKey.toBytes()),
        });
        return yield* runTest().pipe(
          Effect.map((status) => ({ outcome: 'Committed' as const, status })),
          Effect.catchIf(isPending, () =>
            Effect.map(checkedStatus(), (status) => ({ outcome: 'Pending' as const, status }))
          )
        );
      })
    );
  });
  const restore = Effect.fnUntraced(function* (request: {
    readonly personal: DeviceSigner & { readonly encryptionPublicKey: Bytes.EncryptionPublicKey };
    readonly submitOriginalAsRecovery: (
      record: Uint8Array,
      identity: RecoveryIdentity,
      /** R's derived service credential, for the admission append. Owned by the callee. */
      credential: Uint8Array
    ) => Effect.Effect<RecoverySubmitResult, unknown>;
  }) {
    yield* current();
    const index = yield* vault.readIndex(),
      reference = index.value.entries.find(
        (ref) =>
          !ref.retired &&
          ref.genesis === hex(genesis.toBytes()) &&
          ref.membershipId === hex(membership.toBytes())
      );
    if (!reference) return yield* vaultError('missing');
    return yield* useIdentity(reference, (identity, bundle) =>
      Effect.gen(function* () {
        const view = yield* current();
        if (!active(view, identity)) return yield* vaultError('unauthorized');
        // The genesis anchors the replay; the package's checkpoint stops a fork from it.
        const checkpoint = yield* attempt(() => ({
          head: Result.getOrThrow(Bytes.recordHash(fromHex(bundle.trust.head))),
          length: bundle.trust.length,
        }));
        if (!(yield* Effect.fromResult(hasVerifiedCheckpoint(view, checkpoint))))
          return yield* vaultError('authentication');
        const personal = request.personal;
        const opened = yield* openCurrent(identity).pipe(
          Effect.catchIf(isPending, () => Effect.succeed(null))
        );
        if (opened === null)
          return { outcome: 'Pending' as const, epoch: view.inspectState().epoch.number };
        const epoch = opened;
        if (
          personal.publicKey.equals(identity.publicKey) ||
          personal.encryptionPublicKey.equals(identity.encryptionPublicKey)
        )
          return yield* vaultError('invalid-input');
        // A retained, currently admitted personal identity may have lost its local
        // installed key. R has authenticated the current epoch above; restore the
        // key without a duplicate admission. Retired/foreign/mismatched identities
        // still follow the normal rejection path and can never be revived here.
        const retained = view.inspectState().devices.get(hex(personal.publicKey.toBytes()));
        if (retained) {
          if (
            retained.kind !== 'personal' ||
            !retained.membershipId.equals(membership) ||
            !retained.encryptionPublicKey.equals(personal.encryptionPublicKey)
          )
            return yield* vaultError('unauthorized');
          return {
            outcome: 'Committed' as const,
            epoch,
            personal: personal.publicKey,
            role: view.inspectState().members.get(hex(membership.toBytes()))!.role,
          };
        }
        const restoreKey = `${key}/restore`,
          before = yield* local.read(restoreKey);
        let raw = before;
        let intent: typeof RestoreSchema.Type;
        const signAdmission = Effect.fnUntraced(function* (view: LedgerView) {
          const command = yield* prepareDeviceAdmission({
            genesis,
            membershipId: membership,
            encryptionPublicKey: personal.encryptionPublicKey,
            kind: 'personal',
            signer: personal,
          });
          const proposal = yield* Effect.fromResult(
            prepareLedgerCommand(view, identity.publicKey, command)
          );
          const record = yield* signLedgerRecord(proposal, identity);
          return { personal: hex(personal.publicKey.toBytes()), record, position: view.length + 1 };
        });
        if (before) {
          intent = yield* attempt(() =>
            Result.getOrThrow(Schema.decodeUnknownResult(RestoreSchema)(parseCanonical(before)))
          );
          if (intent.personal !== hex(personal.publicKey.toBytes()))
            return yield* vaultError('conflict');
        } else {
          intent = yield* signAdmission(view);
          raw = canonical(intent);
          if ((yield* local.compareAndSwap(restoreKey, null, raw)) !== 'Committed')
            return yield* vaultError('conflict');
          const read = yield* local.read(restoreKey);
          if (!read || !bytesEqual(read, raw)) return yield* vaultError('storage');
        }
        const result = yield* request.submitOriginalAsRecovery(
          new Uint8Array(intent.record),
          identity,
          new Uint8Array(credentials.get(identity)!)
        );
        if (!bytesEqual(result.record, intent.record)) return yield* vaultError('authentication');
        if (result.outcome !== 'Committed') {
          if (result.outcome === 'Conflict') {
            const after = yield* current();
            const landed = yield* Effect.fromResult(
              hasVerifiedCheckpoint(after, {
                head: hashRecordBytes(intent.record),
                length: intent.position,
              })
            );
            if (
              !landed &&
              after.length >= intent.position &&
              (after.historyStart < intent.position ||
                after.classifyDevice?.(hex(personal.publicKey.toBytes())) === 'unknown') &&
              !after.inspectState().devices.has(hex(personal.publicKey.toBytes()))
            ) {
              intent = yield* signAdmission(after);
              const next = canonical(intent);
              if ((yield* local.compareAndSwap(restoreKey, raw, next)) !== 'Committed')
                return yield* vaultError('conflict');
              const read = yield* local.read(restoreKey);
              if (!read || !bytesEqual(read, next)) return yield* vaultError('storage');
            }
          }
          return { outcome: result.outcome, epoch };
        }
        const after = yield* current(),
          device = after.inspectState().devices.get(hex(personal.publicKey.toBytes()));
        if (
          !device ||
          device.kind !== 'personal' ||
          !device.membershipId.equals(membership) ||
          !device.encryptionPublicKey.equals(personal.encryptionPublicKey) ||
          !(yield* Effect.fromResult(
            hasVerifiedCheckpoint(after, {
              head: hashRecordBytes(intent.record),
              length: intent.position,
            })
          ))
        )
          return yield* vaultError('authentication');
        return {
          outcome: 'Committed' as const,
          epoch,
          personal: personal.publicKey,
          role: after.inspectState().members.get(hex(membership.toBytes()))!.role,
        };
      })
    );
  });
  const RevokeIntentSchema = Schema.Struct({
    target: Schema.String,
    record: Schema.Uint8Array,
    position: Schema.Number,
  });
  /** Whole-vault replacement: with this vault's R proven, revoke every other active
   * recovery device of this membership. It needs no V from any older vault, because
   * the verified ledger names them. Each original is journaled and never re-signed. */
  const revokeOtherRecoveryDevices = Effect.fnUntraced(function* (
    request: {
      /** A suspected leak: revoke before this vault's R has passed, or even exists. */
      readonly compromised?: boolean;
    } = {}
  ) {
    const reference = (yield* load()).value?.reference;
    if (!request.compromised && !(yield* checkedStatus()).recoverable)
      return yield* vaultError('pending');
    if (!reference && !request.compromised) return yield* vaultError('missing');
    if (reference)
      return yield* useIdentity(reference, (identity) =>
        revokeRecoveryDevices((id) => id !== hex(identity.publicKey.toBytes()), 'revoke-other')
      );
    return yield* revokeRecoveryDevices(() => true, 'revoke-other');
  });
  /** Abandon a replacement: revoke this vault's own R, known only to the device that
   * admitted it. Its journaled admission names the R, so this needs no V. The older R
   * is untouched. */
  const revokeOwnRecoveryDevice = Effect.fnUntraced(function* () {
    const progress = (yield* load()).value;
    let target = progress?.recoveryDevice;
    if (!target) {
      const record = progress?.record;
      if (!record) return { outcome: 'Committed' as const };
      const body = (yield* Effect.fromResult(decodeRecord(record))).body;
      if (body.type !== 'ordinary' || body.operation.type !== 'admitDevice')
        return yield* vaultError('authentication');
      target = hex(body.operation.signingPublicKey.toBytes());
    }
    return yield* revokeRecoveryDevices((id) => id === target, 'revoke-own');
  });
  const revokeRecoveryDevices = (select: (id: string) => boolean, purpose: string) =>
    Effect.gen(function* () {
      const prefix = `${key}/${purpose}/`,
        view = yield* current(),
        others = [...view.inspectState().devices]
          .filter(
            ([id, device]) =>
              select(id) && device.kind === 'recovery' && device.membershipId.equals(membership)
          )
          .map(([id]) => id),
        journaled = (yield* local.list(prefix)).map((row) => row.key.slice(prefix.length));
      const signRevocation = Effect.fnUntraced(function* (target: string) {
        const latest = yield* current(),
          targetKey = yield* Effect.fromResult(Bytes.signingPublicKey(fromHex(target))),
          proposal = yield* Effect.fromResult(
            prepareLedgerCommand(latest, personalSigner.publicKey, {
              _tag: 'RevokeDevice',
              target: targetKey,
            })
          );
        return {
          target,
          record: yield* signLedgerRecord(proposal, personalSigner),
          position: latest.length + 1,
        };
      });
      for (const target of new Set([...journaled, ...others])) {
        const journalKey = `${prefix}${target}`;
        let raw = yield* local.read(journalKey);
        let intent: typeof RevokeIntentSchema.Type;
        if (raw) {
          const stored = raw;
          intent = yield* attempt(() =>
            Result.getOrThrow(
              Schema.decodeUnknownResult(RevokeIntentSchema)(parseCanonical(stored))
            )
          );
        } else {
          intent = yield* signRevocation(target);
          const next = canonical(intent);
          if ((yield* local.compareAndSwap(journalKey, null, next)) !== 'Committed')
            return yield* vaultError('conflict');
          raw = next;
        }
        for (let attempts = 0; ; attempts++) {
          const outcome = yield* submit(new Uint8Array(intent.record), null);
          if (!bytesEqual(outcome.record, intent.record))
            return yield* vaultError('authentication');
          if (outcome.outcome === 'Pending') return { outcome: outcome.outcome };
          const after = yield* current(),
            landed = yield* Effect.fromResult(
              hasVerifiedCheckpoint(after, {
                head: hashRecordBytes(intent.record),
                length: intent.position,
              })
            );
          if (outcome.outcome === 'Committed') {
            if (after.inspectState().devices.has(target) || !landed)
              return yield* vaultError('authentication');
            break;
          }
          // Only the ledger proves this original can never commit: a different record
          // holds its position. Until then it is resent unchanged, never re-signed.
          if (landed || !after.inspectState().devices.has(target)) break;
          if (after.length < intent.position || attempts >= 3) return { outcome: outcome.outcome };
          intent = yield* signRevocation(target);
          const next = canonical(intent);
          if ((yield* local.compareAndSwap(journalKey, raw, next)) !== 'Committed')
            return yield* vaultError('conflict');
          raw = next;
        }
      }
      return { outcome: 'Committed' as const };
    });
  const replacementSchema = Schema.Struct({
    old: RefSchema,
    candidateId: Schema.String,
    selected: Schema.NullOr(RefSchema),
    compromised: Schema.Boolean,
    revoke: Schema.NullOr(Schema.Uint8Array),
    revokePosition: Schema.NullOr(Schema.Number),
    done: Schema.Boolean,
  });
  const replace = Effect.fnUntraced(function* (request: {
    readonly requestId: string;
    readonly compromised: boolean;
  }) {
    if (!request.requestId || request.requestId.length > 256)
      return yield* vaultError('invalid-input');
    const journalKey = `${key}/replacement/${request.requestId}`;
    let raw = yield* local.read(journalKey);
    let intent: typeof replacementSchema.Type;
    if (raw) {
      intent = yield* attempt(() =>
        Result.getOrThrow(Schema.decodeUnknownResult(replacementSchema)(parseCanonical(raw!)))
      );
      if (intent.compromised !== request.compromised) return yield* vaultError('conflict');
      if (intent.done) return yield* checkedStatus();
    } else {
      const index = yield* vault.readIndex(),
        old = index.value.entries.find(
          (ref) =>
            !ref.retired &&
            ref.genesis === hex(genesis.toBytes()) &&
            ref.membershipId === hex(membership.toBytes())
        );
      if (!old) return yield* vaultError('missing');
      intent = {
        old,
        candidateId: hex(random(32)),
        selected: null,
        compromised: request.compromised,
        revoke: null,
        revokePosition: null,
        done: false,
      };
    }
    const persistIntent = Effect.fnUntraced(function* () {
      const next = canonical(intent);
      if ((yield* local.compareAndSwap(journalKey, raw, next)) !== 'Committed')
        return yield* vaultError('conflict');
      const actual = yield* local.read(journalKey);
      if (!actual || !bytesEqual(actual, next)) return yield* vaultError('storage');
      raw = next;
      return yield* Effect.void;
    });
    if (!raw) yield* persistIntent();
    const revokeOld = Effect.fnUntraced(function* () {
      return yield* useIdentity(intent.old, (oldIdentity) =>
        Effect.gen(function* () {
          const view = yield* current();
          if (!active(view, oldIdentity)) {
            if (intent.revoke) {
              const reconciled = yield* submit(new Uint8Array(intent.revoke), null);
              if (!bytesEqual(reconciled.record, intent.revoke))
                return yield* vaultError('authentication');
              return reconciled.outcome;
            }
            return 'Committed' as const;
          }
          const signRevocation = Effect.fnUntraced(function* (view: LedgerView) {
            const proposal = yield* Effect.fromResult(
              prepareLedgerCommand(view, personalSigner.publicKey, {
                _tag: 'RevokeDevice',
                target: oldIdentity.publicKey,
              })
            );
            intent = {
              ...intent,
              revoke: yield* signLedgerRecord(proposal, personalSigner),
              revokePosition: view.length + 1,
            };
            yield* persistIntent();
          });
          if (!intent.revoke) yield* signRevocation(view);
          const outcome = yield* submit(new Uint8Array(intent.revoke!), null);
          if (!bytesEqual(outcome.record, intent.revoke!))
            return yield* vaultError('authentication');
          if (outcome.outcome !== 'Committed') {
            if (outcome.outcome === 'Conflict') {
              const after = yield* current();
              const landed = yield* Effect.fromResult(
                hasVerifiedCheckpoint(after, {
                  head: hashRecordBytes(intent.revoke!),
                  length: intent.revokePosition!,
                })
              );
              if (!landed && after.length >= intent.revokePosition! && active(after, oldIdentity))
                yield* signRevocation(after);
            }
            return outcome.outcome;
          }
          const after = yield* current();
          if (
            active(after, oldIdentity) ||
            !(yield* Effect.fromResult(
              hasVerifiedCheckpoint(after, {
                head: hashRecordBytes(intent.revoke!),
                length: intent.revokePosition!,
              })
            ))
          )
            return yield* vaultError('authentication');
          return 'Committed' as const;
        })
      );
    });
    if (request.compromised && (yield* revokeOld()) !== 'Committed')
      return yield* vaultError('pending');
    if (!intent.selected) {
      const recovered = yield* vault.readCandidate(intent.candidateId);
      let reference: RecoveryEntryReference;
      if (recovered) {
        reference = recovered.reference;
        wipeRecoveryPackage(recovered.value);
      } else
        reference = yield* Effect.acquireUseRelease(
          generateRecoveryPackage({
            genesis: hex(genesis.toBytes()),
            membershipId: hex(membership.toBytes()),
            generation: intent.old.generation + 1,
            trust,
          }),
          (bundle) => vault.upload(bundle, intent.candidateId),
          (bundle) => Effect.sync(() => wipeRecoveryPackage(bundle))
        );
      intent = { ...intent, selected: reference };
      yield* persistIntent();
    }
    // The journal and progress are separate writes: a resumed request re-points
    // progress here, or setup would run on the old reference.
    const candidate = intent.selected!,
      progress = yield* load();
    if (progress.value?.reference?.entryId !== candidate.entryId)
      yield* save(progress.raw, {
        entryId: candidate.entryId,
        reference: candidate,
        record: null,
        recordPosition: null,
        stage: 'indexed',
        lastTest: null,
        testedEpoch: null,
        envelopeEpoch: null,
        skipped: false,
      });
    const tested = yield* setup();
    if (tested.outcome !== 'Committed' || !tested.status.recoverable)
      return yield* vaultError('pending');
    const index = yield* vault.readIndex(),
      selected = index.value.entries.find(
        (ref) =>
          !ref.retired &&
          ref.genesis === hex(genesis.toBytes()) &&
          ref.membershipId === hex(membership.toBytes())
      );
    if (selected?.entryId !== candidate.entryId) {
      if (selected?.entryId !== intent.old.entryId) return yield* vaultError('conflict');
      const changed = yield* vault.replace(candidate);
      if (changed.outcome !== 'Committed') return yield* vaultError('conflict');
    }
    if (!request.compromised && (yield* revokeOld()) !== 'Committed')
      return yield* vaultError('pending');
    intent = { ...intent, done: true };
    yield* persistIntent();
    return yield* checkedStatus();
  });
  return Object.freeze({
    replace: (request: Parameters<typeof replace>[0]) => own(replace(request)),
    revokeOtherRecoveryDevices: (request?: { readonly compromised?: boolean }) =>
      own(revokeOtherRecoveryDevices(request)),
    revokeOwnRecoveryDevice: () => own(revokeOwnRecoveryDevice()),
    setup: () => own(setup()),
    test: () => own(runTest()),
    status: () => own(checkedStatus()),
    restoreFromRecovery: (request: Parameters<typeof restore>[0]) => own(restore(request)),
    skip: (confirmation: { readonly confirmedRecoveryLoss: boolean }) =>
      own(
        Effect.gen(function* () {
          if (
            Result.isFailure(
              Schema.decodeUnknownResult(
                Schema.Struct({ confirmedRecoveryLoss: Schema.Literal(true) })
              )(confirmation)
            )
          )
            return yield* vaultError('invalid-input');
          const state = yield* load();
          yield* save(
            state.raw,
            state.value
              ? { ...state.value, skipped: true }
              : {
                  entryId: hex(random(32)),
                  reference: null,
                  record: null,
                  recordPosition: null,
                  stage: 'candidate',
                  lastTest: null,
                  testedEpoch: null,
                  envelopeEpoch: null,
                  skipped: true,
                }
          );
          return yield* checkedStatus();
        })
      ),
  });
});

/** Revoke the R a device admitted for a vault it can no longer open: the new file was
 * lost mid-replacement. Only the device's journal is read, so no V is needed. */
export const abandonWorkspaceRecovery = Effect.fnUntraced(function* (
  input: Pick<
    WorkspaceRecoveryInput,
    'local' | 'genesis' | 'membershipId' | 'personalSigner' | 'ledger' | 'submitOriginal'
  > & { readonly vaultId: string; readonly genesisRecord: Uint8Array }
) {
  const owner = yield* makeWorkspaceRecovery({
    ...input,
    // Unreachable here: this path reads the journal and the ledger only.
    vault: { vaultId: input.vaultId } as RecoveryVault,
    installed: {
      saveAndReload: () => Effect.fail(vaultError('closed')),
      read: () => Effect.fail(vaultError('closed')),
    },
    trust: {
      source: 'abandoned replacement',
      genesisRecord: input.genesisRecord,
      head: hex(input.genesis.toBytes()),
      length: 1,
    },
    fetchCurrentEnvelope: () => Effect.fail(vaultError('closed')),
  });
  return { revokeOwnRecoveryDevice: owner.revokeOwnRecoveryDevice };
});

/** Hold epoch keys read through R until a new device installs them. Core releases every
 * key it hands over, so this keeps independent bytes and returns a fresh key each read. */
export const memoryRecoveryEpochKeys = () => {
  const held = new Map<number, Uint8Array>();
  const issued = new Set<Bytes.EpochKey>();
  const fresh = (bytes: Uint8Array) => {
    const key = Result.getOrThrow(Bytes.epochKey(bytes));
    issued.add(key);
    return key;
  };
  return {
    saveAndReload: (epoch: number, key: Bytes.EpochKey) =>
      Effect.sync(() => {
        held.get(epoch)?.fill(0);
        held.set(epoch, copyEpochKeyBytes(key));
      }),
    read: (epoch: number) => {
      const bytes = held.get(epoch);
      return bytes ? Effect.succeed(fresh(bytes)) : Effect.fail(vaultError('missing'));
    },
    /** Fresh copies, releasable by the caller and wiped when this cache closes. */
    entries: () => [...held.entries()].map(([epoch, bytes]) => [epoch, fresh(bytes)] as const),
    dispose: () => {
      for (const bytes of held.values()) bytes.fill(0);
      for (const key of issued) disposeEpochKey(key);
      held.clear();
      issued.clear();
    },
  };
};

/**
 * Each workspace's recovery stage on this device, read from the local journal alone, so it
 * needs no V. `testedEpoch` is the key update the last real envelope test covered. A later
 * update needs a new test, which only the ledger can tell. A row this reader cannot decode
 * (empty, not canonical CBOR, or not a progress record) is reported with stage `unknown`
 * rather than failing the read: the journal persists, so one damaged row would otherwise
 * hide every workspace's state on this device for good. The row itself is left untouched.
 */
export const readWorkspaceRecoveryProgress = Effect.fnUntraced(function* (
  local: RecoveryVaultLocalStore,
  vaultId: string
) {
  const prefix = `vault-v1/${vaultId}/workspace/`;
  const progress: {
    readonly genesis: string;
    readonly membershipId: string;
    readonly stage: typeof ProgressSchema.Type.stage | 'unknown';
    readonly testedEpoch: number | null;
  }[] = [];
  for (const row of yield* local.list(prefix)) {
    const parts = row.key.slice(prefix.length).split('/');
    if (parts.length !== 2) continue;
    const genesis = parts[0]!,
      membershipId = parts[1]!;
    let value: unknown;
    try {
      value = parseCanonical(row.value);
    } catch {
      progress.push({ genesis, membershipId, stage: 'unknown', testedEpoch: null });
      continue;
    }
    const decoded = Schema.decodeUnknownResult(ProgressSchema)(value);
    if (Result.isFailure(decoded)) {
      progress.push({ genesis, membershipId, stage: 'unknown', testedEpoch: null });
      continue;
    }
    if (decoded.success.skipped) continue;
    progress.push({
      genesis,
      membershipId,
      stage: decoded.success.stage,
      testedEpoch: decoded.success.testedEpoch,
    });
  }
  return progress;
});
