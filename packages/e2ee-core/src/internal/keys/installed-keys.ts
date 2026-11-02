import { Context, Effect, Exit, Layer, Result, Schema } from 'effect';
import * as Bytes from '../foundation/bytes';
import { bytesEqual } from '../foundation/cbor';
import { copyEpochKeyBytes, disposeEpochKey } from '../foundation/epoch-key';
import { keyId } from '../foundation/identifiers';
import { epochHistoryPacket, type LedgerView } from '../ledger';
import { VerifiedLedger, type VerifiedLedgerError } from '../ledger/verified-ledger';
import { makeAdmissionGate, own, ownIdentity } from '../lifecycle';
import { KeyProtector } from '../../services/keys';
import { InstalledKeyStore } from '../../services/stores';
import { DeviceIdentity, WorkspaceScope } from '../../services/workspace';
import type { LocalStoreError } from '../../services/errors';
import { commitEpochKey, recoverLedgerHistory } from './history';
import type { EpochKeyError } from './history';

/**
 * An installed epoch key could not be stored or opened.
 *
 * - `missing-key`: nothing is installed for the epoch (recoverable through
 *   {@link InstalledEpochHistory} when a later key is installed).
 * - `unauthorized`: this device is not an active member device at the current
 *   ledger view, or the epoch is unknown to it.
 * - `commitment-mismatch` / `binding-mismatch`: the key or the protected blob
 *   does not match the ledger commitment or this workspace/device/epoch.
 * - `native-failed`: the {@link KeyProtector} failed.
 * - `rollback`: the ledger view regressed (see `VerifiedLedger`).
 * - `storage` / `corrupt` / `closed` / `invalid-input`: as named.
 *
 * @category Errors
 */
export class InstalledKeyError extends Schema.TaggedError<InstalledKeyError>()(
  'InstalledKeyError',
  {
    reason: Schema.Literals([
      'closed',
      'invalid-input',
      'unauthorized',
      'commitment-mismatch',
      'native-failed',
      'binding-mismatch',
      'storage',
      'corrupt',
      'rollback',
      'missing-key',
    ]),
  }
) {}
const fail = (reason: InstalledKeyError['reason']) => new InstalledKeyError({ reason });
const fromLedger = (error: VerifiedLedgerError) =>
  fail(error.reason === 'source' ? 'unauthorized' : error.reason);
const fromStore = (error: LocalStoreError) =>
  fail(error.reason === 'corrupt' ? 'corrupt' : error.reason === 'closed' ? 'closed' : 'storage');

const purpose = new TextEncoder().encode('lody-e2ee/local-epoch-key/v1\0');
const HEADER = purpose.length + 32 + 32 + 4 + 32;
const SIZE = HEADER + 32;
/** Upper bound on one protected installed-key blob. */
export const MAX_PROTECTED_EPOCH_BYTES = 8192;
const validBlob = (blob: unknown): blob is Uint8Array =>
  blob instanceof Uint8Array && blob.length > 0 && blob.length <= MAX_PROTECTED_EPOCH_BYTES;

/**
 * Seal and open installed-key blobs for this workspace and device. The body is
 * `purpose ‖ genesis ‖ device ‖ epoch ‖ commitment ‖ key`, protected as a whole
 * by {@link KeyProtector}; both directions check the commitment against the
 * newest verified ledger view before and after the native call, and wipe every
 * plaintext buffer once the native call settled. `guard` fails when the owner
 * started closing.
 *
 * Internal building block of {@link InstalledEpochKeys}.
 */
export const makeInstalledKeySealer = Effect.fnUntraced(function* (
  guard: Effect.Effect<void, InstalledKeyError> = Effect.void
) {
  const anchor = (yield* WorkspaceScope).genesis;
  const recipient = ownIdentity(yield* DeviceIdentity).signer.publicKey;
  const ledger = yield* VerifiedLedger;
  const protector = own(yield* KeyProtector);
  const expected = Effect.fnUntraced(function* (epoch: number) {
    yield* guard;
    yield* Effect.fromResult(
      Result.mapError(Bytes.epochNumber(epoch), () => fail('invalid-input'))
    );
    const view = yield* ledger.current().pipe(Effect.mapError(fromLedger));
    yield* guard;
    return yield* Effect.fromResult(eligibleCommitment(view, recipient, epoch));
  });
  const header = (epoch: number, commitment: Bytes.EpochCommitment) => {
    const body = new Uint8Array(SIZE);
    body.set(purpose);
    body.set(anchor.toBytes(), purpose.length);
    body.set(recipient.toBytes(), purpose.length + 32);
    new DataView(body.buffer).setUint32(purpose.length + 64, epoch);
    body.set(commitment.toBytes(), purpose.length + 68);
    return body;
  };
  const commitment = (epoch: number, key: Bytes.EpochKey) =>
    Effect.fromResult(
      Result.mapError(commitEpochKey(anchor, epoch, key), () => fail('invalid-input'))
    );

  const seal = Effect.fnUntraced(function* (epoch: number, key: Bytes.EpochKey) {
    const committed = yield* expected(epoch);
    if (!committed.equals(yield* commitment(epoch, key))) return yield* fail('commitment-mismatch');
    const blob = yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          const body = header(epoch, committed);
          const raw = copyEpochKeyBytes(key);
          try {
            body.set(raw, HEADER);
          } finally {
            raw.fill(0);
          }
          return body;
        },
        catch: () => fail('invalid-input'),
      }),
      (body) =>
        Effect.uninterruptible(protector.protect(body)).pipe(
          Effect.mapError(() => fail('native-failed')),
          Effect.flatMap((sealed) =>
            validBlob(sealed)
              ? Effect.succeed(new Uint8Array(sealed))
              : Effect.fail(fail('invalid-input'))
          )
        ),
      (body) => Effect.sync(() => body.fill(0))
    );
    if (!committed.equals(yield* expected(epoch))) return yield* fail('commitment-mismatch');
    return blob;
  });

  const open = Effect.fnUntraced(function* (epoch: number, input: Uint8Array) {
    if (!validBlob(input)) return yield* fail('invalid-input');
    const blob = new Uint8Array(input);
    const committed = yield* expected(epoch);
    return yield* Effect.acquireUseRelease(
      // Acquisition is uninterruptible: cleanup is registered before a native result can be abandoned.
      protector.unprotect(blob).pipe(Effect.mapError(() => fail('native-failed'))),
      (body) =>
        Effect.gen(function* () {
          if (
            !(body instanceof Uint8Array) ||
            body.length !== SIZE ||
            !bytesEqual(body.subarray(0, HEADER), header(epoch, committed).subarray(0, HEADER))
          )
            return yield* fail('binding-mismatch');
          return yield* Effect.acquireUseRelease(
            Effect.fromResult(
              Result.mapError(Bytes.epochKey(body.subarray(HEADER)), () => fail('invalid-input'))
            ),
            (key) =>
              Effect.gen(function* () {
                if (!committed.equals(yield* commitment(epoch, key)))
                  return yield* fail('commitment-mismatch');
                if (!committed.equals(yield* expected(epoch)))
                  return yield* fail('commitment-mismatch');
                return key;
              }),
            (key, exit) =>
              Effect.sync(() => {
                if (!Exit.isSuccess(exit)) disposeEpochKey(key);
              })
          );
        }),
      (body) =>
        Effect.sync(() => {
          if (body instanceof Uint8Array) body.fill(0);
        })
    );
  });

  return { seal, open };
});

/**
 * This device's installed epoch keys: the only owner of local key material.
 *
 * `saveAndReload` protects a key with the {@link KeyProtector}, stores it, and
 * succeeds only after the stored blob reopens to a key matching the ledger
 * commitment. `read` returns a fresh opaque key owned by the caller (dispose it).
 * Both re-check, after every asynchronous step, that this device is still an
 * active member at the newest verified ledger view.
 *
 * The receiver, distributor, publisher and history recovery all borrow this one
 * service rather than opening the store themselves.
 *
 * @category Workflows
 */
export class InstalledEpochKeys extends Context.Service<
  InstalledEpochKeys,
  {
    /** Protect and durably reload a key matching the ledger commitment; borrows `key`, which remains caller-owned. */
    saveAndReload(epoch: number, key: Bytes.EpochKey): Effect.Effect<void, InstalledKeyError>;
    /** Verify an installed key and dispose its temporary material without exporting it. */
    check(epoch: number): Effect.Effect<void, InstalledKeyError>;
    /** Open an installed key after current membership checks; the caller owns and must dispose the returned key. */
    read(epoch: number): Effect.Effect<Bytes.EpochKey, InstalledKeyError>;
  }
>()('@lody/e2ee-core/InstalledEpochKeys') {
  /**
   * Requires {@link WorkspaceScope}, {@link DeviceIdentity}, `VerifiedLedger`,
   * {@link KeyProtector} and {@link InstalledKeyStore}.
   */
  static readonly layer = Layer.effect(
    InstalledEpochKeys,
    Effect.gen(function* () {
      const store = own(yield* InstalledKeyStore);
      const gate = yield* makeAdmissionGate(() => fail('closed'));

      const { seal, open } = yield* makeInstalledKeySealer(gate.guard);
      const load = Effect.fnUntraced(function* (epoch: number) {
        yield* gate.guard;
        const blob = yield* store.load(epoch).pipe(Effect.mapError(fromStore));
        if (blob === null) return yield* fail('missing-key');
        return blob;
      });
      const openOwned = (epoch: number, blob: Uint8Array) =>
        Effect.acquireUseRelease(
          open(epoch, blob),
          () => Effect.void,
          (key) => Effect.sync(() => disposeEpochKey(key))
        );

      const saveAndReload = Effect.fnUntraced(function* (epoch: number, key: Bytes.EpochKey) {
        const existing = yield* Effect.result(load(epoch));
        let damaged: Uint8Array | undefined;
        if (Result.isSuccess(existing)) {
          const opened = yield* Effect.result(open(epoch, existing.success));
          if (Result.isSuccess(opened)) {
            disposeEpochKey(opened.success);
            return undefined;
          }
          if (opened.failure.reason === 'closed') return yield* opened.failure;
          damaged = existing.success;
        } else if (existing.failure.reason !== 'missing-key') return yield* existing.failure;
        const blob = yield* seal(epoch, key);
        // A replacement must independently open and match the verified epoch commitment.
        yield* openOwned(epoch, blob);
        yield* gate.guard;
        yield* (
          damaged ? store.replace(epoch, damaged, blob) : store.insertIfAbsent(epoch, blob)
        ).pipe(Effect.mapError(fromStore));
        // Concurrent originals still win; success requires the actual stored key.
        yield* openOwned(epoch, yield* load(epoch));
        return undefined;
      });

      return InstalledEpochKeys.of({
        check: Effect.fn('@lody/e2ee-core/InstalledEpochKeys.check')(function* (epoch: number) {
          return yield* gate.run(Effect.flatMap(load(epoch), (blob) => openOwned(epoch, blob)));
        }),
        saveAndReload: Effect.fn('@lody/e2ee-core/InstalledEpochKeys.saveAndReload')(function* (
          epoch: number,
          key: Bytes.EpochKey
        ) {
          return yield* gate.run(saveAndReload(epoch, key));
        }),
        read: Effect.fn('@lody/e2ee-core/InstalledEpochKeys.read')(function* (epoch: number) {
          return yield* gate.run(Effect.flatMap(load(epoch), (blob) => open(epoch, blob)));
        }),
      });
    })
  );
}

/** Commitment for `epoch` if `recipient` is an active member device at `view`. */
function eligibleCommitment(view: LedgerView, recipient: Bytes.SigningPublicKey, epoch: number) {
  return Result.gen(function* () {
    const packet = yield* Result.mapError(epochHistoryPacket(view, epoch), () =>
      fail('unauthorized')
    );
    const state = view.inspectState();
    const device = state.devices.get(keyId(recipient.toBytes()));
    if (!device || !state.members.has(keyId(device.membershipId.toBytes())))
      return yield* Result.fail(fail('unauthorized'));
    return packet.commitment;
  });
}

/**
 * Backward recovery of older epoch keys from the newest installed key and the
 * signed history packets in the ledger.
 *
 * `read(epoch)` returns an installed key, or — only when it is genuinely
 * missing — validates the whole chain from the newest installed key, saves the
 * recovered keys, and returns the requested one. Corrupt, permission or storage
 * failures are never "recovered". This restores installed history only; it is
 * not a vault and does not reconstruct historical sender envelopes.
 *
 * @category Workflows
 */
export class InstalledEpochHistory extends Context.Service<
  InstalledEpochHistory,
  {
    /** Validate the full chain and install every recoverable older key. */
    recover(): Effect.Effect<readonly number[], InstalledKeyError | EpochKeyError>;
    /** Read an owned key, recovering only genuinely missing history; permission, corruption and protection failures propagate. */
    read(epoch: number): Effect.Effect<Bytes.EpochKey, InstalledKeyError | EpochKeyError>;
  }
>()('@lody/e2ee-core/InstalledEpochHistory') {
  /** Requires `VerifiedLedger` and {@link InstalledEpochKeys}. */
  static readonly layer = Layer.effect(
    InstalledEpochHistory,
    Effect.gen(function* () {
      const ledger = yield* VerifiedLedger;
      const installed = yield* InstalledEpochKeys;
      const gate = yield* makeAdmissionGate(() => fail('closed'));
      const current = Effect.fnUntraced(function* () {
        yield* gate.guard;
        const view = yield* ledger.current().pipe(Effect.mapError(fromLedger));
        yield* gate.guard;
        return view;
      });
      const recover = (view: LedgerView) =>
        Effect.acquireUseRelease(
          installed.read(view.inspectState().epoch.number),
          (latest) =>
            Effect.acquireUseRelease(
              Effect.fromResult(recoverLedgerHistory(view, latest)),
              (keys) =>
                Effect.gen(function* () {
                  for (const [epoch, key] of keys) {
                    yield* current();
                    yield* installed.saveAndReload(epoch, key);
                  }
                  return [...keys.keys()];
                }),
              (keys) =>
                Effect.sync(() => {
                  for (const key of keys.values()) disposeEpochKey(key);
                })
            ),
          (latest) => Effect.sync(() => disposeEpochKey(latest))
        );
      return InstalledEpochHistory.of({
        recover: Effect.fn('@lody/e2ee-core/InstalledEpochHistory.recover')(function* () {
          return yield* gate.run(Effect.flatMap(current(), recover));
        }),
        read: Effect.fn('@lody/e2ee-core/InstalledEpochHistory.read')(function* (epoch: number) {
          return yield* gate.run(
            Effect.gen(function* () {
              const view = yield* current();
              const existing = yield* Effect.result(installed.read(epoch));
              if (Result.isSuccess(existing)) {
                if (gate.isClosed()) {
                  disposeEpochKey(existing.success);
                  return yield* fail('closed');
                }
                return existing.success;
              }
              // Retry only genuinely missing installed data, never corrupt/permission/storage failures.
              if (existing.failure.reason !== 'missing-key') return yield* existing.failure;
              yield* Effect.fromResult(
                Result.mapError(Bytes.epochNumber(epoch), () => fail('invalid-input'))
              );
              if (epoch > view.inspectState().epoch.number) return yield* existing.failure;
              yield* recover(view);
              const recovered = yield* installed.read(epoch);
              if (gate.isClosed()) {
                disposeEpochKey(recovered);
                return yield* fail('closed');
              }
              return recovered;
            })
          );
        }),
      });
    })
  );
}
