import { Context, Effect, HashMap, Layer, Result, Semaphore } from 'effect';
import { copyEpochKeyBytes, disposeEpochKey } from '../foundation/epoch-key';
import { contentPermissions, epochHistoryPacket, type LedgerView } from '../ledger';
import { internalViewState } from '../ledger/replay';
import { VerifiedLedger, type VerifiedLedgerError } from '../ledger/verified-ledger';
import { own } from '../lifecycle';
import { EngineKeyringSink } from '../../services/engine-keyring';
import type { EngineKeyringSinkError } from '../../services/errors';
import { DeviceIdentity, WorkspaceScope } from '../../services/workspace';
import { InstalledEpochHistory, InstalledKeyError } from './installed-keys';
import type { EpochKeyError } from './history';

/** What one {@link EngineKeyringSync.sync} installed in the engine. */
export interface EngineKeyringReport {
  /** Epochs whose verified key the engine now holds, ascending. */
  readonly installedEpochs: readonly number[];
  /** Epochs skipped because this device has no key for them yet. */
  readonly missingEpochs: readonly number[];
  /** Epoch the engine seals new content at, or `undefined` when sealing is held. */
  readonly sealEpoch: number | undefined;
  /** Whether this device may write now; when not, its writer's sealing is held. */
  readonly mayWrite: boolean;
  /** Historically admitted device public keys the engine admits. */
  readonly admittedDevices: number;
}

/**
 * Keeps the local native engine's keyring equal to this device's verified state
 * (the single `installIntoEngineKeyring` exception, INVARIANTS.md).
 *
 * One `sync` installs the pinned genesis, every historically admitted device
 * public key (so frames of later-revoked authors keep opening), every verified
 * epoch key this device holds except abandoned epochs, and the seal epoch: the
 * verified current epoch when its key is installed, otherwise a retained earlier
 * epoch inside VerifiedLedger's fifteen-minute budget. When this device may not
 * write (Guest, recovery, removed, or no sealable epoch) its writer's sealing is
 * held right after the namespace is configured, before any key is installed, so no
 * stale seal can race (a fresh engine refuses a hold for an unconfigured namespace);
 * otherwise the platform installs its own
 * writer seed and sealing is released.
 *
 * Every step is idempotent, so callers run `sync` for every trigger of the
 * Spec's notification table (admission, a new epoch, a ledger advance, a lost
 * write permission, an engine reconnect) instead of tracking deltas. Calls are
 * serialized. Epoch key bytes are copied only to {@link EngineKeyringSink} and
 * wiped when the call settles, including on failure and interruption.
 *
 * Requires {@link WorkspaceScope}, {@link DeviceIdentity}, `VerifiedLedger`,
 * {@link InstalledEpochHistory} and {@link EngineKeyringSink}.
 *
 * @category Workflows
 */
export class EngineKeyringSync extends Context.Service<
  EngineKeyringSync,
  {
    /** Install this device's current verified state into the engine keyring; idempotent and serialized. */
    sync(): Effect.Effect<
      EngineKeyringReport,
      VerifiedLedgerError | InstalledKeyError | EpochKeyError | EngineKeyringSinkError
    >;
  }
>()('@lody/e2ee-core/EngineKeyringSync') {
  static readonly layer = Layer.effect(
    EngineKeyringSync,
    Effect.gen(function* () {
      const { genesis } = yield* WorkspaceScope;
      const { signer } = yield* DeviceIdentity;
      const ledger = yield* VerifiedLedger;
      const history = yield* InstalledEpochHistory;
      const sink = own(yield* EngineKeyringSink);
      const serial = yield* Semaphore.make(1);

      /** Install one key, wiping the copy whatever the outcome. */
      const installEpoch = (epoch: number) =>
        Effect.acquireUseRelease(
          history.read(epoch),
          (key) =>
            Effect.acquireUseRelease(
              Effect.sync(() => copyEpochKeyBytes(key)),
              (bytes) => sink.installEpoch(epoch, bytes),
              (bytes) => Effect.sync(() => bytes.fill(0))
            ),
          (key) => Effect.sync(() => disposeEpochKey(key))
        );

      const sync = Effect.fnUntraced(function* () {
        const view: LedgerView = yield* ledger.current();
        const state = internalViewState(view);
        if (!state) return yield* new InstalledKeyError({ reason: 'unauthorized' });
        const permissions = contentPermissions(view, signer.publicKey);
        const mayWriteDocument =
          Result.isSuccess(permissions) && permissions.success.mayWriteDocument;
        yield* sink.configure(genesis.toBytes());
        if (!mayWriteDocument) yield* sink.holdSealing();

        const devices = [...HashMap.values(state.deviceHistory)].map((record) =>
          record.signingPublicKey.toBytes()
        );
        yield* sink.admit(devices);

        const current = state.epoch.number;
        const installed: number[] = [];
        const missing: number[] = [];
        for (let epoch = 0; epoch <= current; epoch++) {
          const packet = epochHistoryPacket(view, epoch);
          if (Result.isFailure(packet) || packet.success.abandoned) continue;
          const result = yield* Effect.result(installEpoch(epoch));
          if (Result.isSuccess(result)) installed.push(epoch);
          else if (
            result.failure instanceof InstalledKeyError &&
            result.failure.reason === 'missing-key'
          )
            missing.push(epoch);
          else return yield* result.failure;
        }

        let sealEpoch: number | undefined;
        if (installed.includes(current)) sealEpoch = current;
        else {
          for (const epoch of [...installed].reverse()) {
            const allowed = ledger.canWriteRetainedEpoch
              ? yield* ledger.canWriteRetainedEpoch(epoch)
              : false;
            if (allowed) {
              sealEpoch = epoch;
              break;
            }
          }
        }
        const mayWrite = mayWriteDocument && sealEpoch !== undefined;
        if (sealEpoch !== undefined) yield* sink.setSealEpoch(sealEpoch);
        if (mayWrite) {
          yield* sink.installSigner();
          yield* sink.releaseSealing();
        } else if (mayWriteDocument) {
          yield* sink.holdSealing();
        }
        return Object.freeze({
          installedEpochs: Object.freeze(installed),
          missingEpochs: Object.freeze(missing),
          sealEpoch: mayWrite ? sealEpoch : undefined,
          mayWrite,
          admittedDevices: devices.length,
        });
      });

      return EngineKeyringSync.of({
        sync: Effect.fn('@lody/e2ee-core/EngineKeyringSync.sync')(function* () {
          return yield* serial.withPermit(sync());
        }),
      });
    })
  );
}
