/**
 * UNSTABLE test and Lab helpers: single workflow components (receiver, repair,
 * distributor, publisher, installed keys…) opened from the real workflow Layers
 * over real SQLite stores, each with its own per-store configuration, so fault
 * harnesses can drive one component at a time. Every handle owns its own Layer
 * graph in the caller's Scope; stores in one directory share that directory's
 * `ledger-pin.sqlite`, exactly as an application would. Applications compose
 * `E2eeWorkflows` instead.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Context, Data, Effect, Layer } from 'effect';
import {
  EpochPublisher,
  InstalledEpochHistory,
  InstalledEpochKeys,
  KeyDistributor,
  KeyReceiver,
  KeyRepair,
  LedgerSubmission,
  VerifiedLedger,
  type EpochStagedGroup,
} from '../../index';
import {
  BackendError,
  CandidateProtector,
  DeviceIdentity,
  EpochPublicationSource,
  EpochStagingStore,
  KeyMailbox,
  KeyProtector,
  LedgerLog,
  LedgerViewSource,
  LedgerViewSourceError,
  SubmissionJournal,
  WorkspaceScope,
  type DeviceSigner,
  type EpochStagedGroupKey,
  type GenesisHash,
  type KeyMailboxStatus,
  type LedgerView,
  type MailboxSlot,
  type SigningPublicKey,
} from '../../services';
import {
  sqliteDeliveryOutbox,
  sqliteDistributionJournal,
  sqliteEpochCandidateStore,
  sqliteInstalledKeyStore,
  sqliteLedgerPinStore,
  sqliteReceiveJournal,
  sqliteRepairJournal,
} from '../../adapters/node-sqlite';
import { InstalledKeyError, makeInstalledKeySealer } from '../keys/installed-keys';
import { makeAdmissionGate } from '../lifecycle';
import { ContentError } from '../foundation/errors';

export interface NativeEpochProtector {
  readonly protect: (body: Uint8Array) => Promise<Uint8Array>;
  readonly unprotect: (blob: Uint8Array) => Promise<Uint8Array>;
}
type Mode = 'create' | 'open';
type Ledger = () => Effect.Effect<LedgerView, unknown>;
type Remote<A> = Effect.Effect<A, unknown>;
export interface ReceiveMailboxRemote {
  readonly status: (
    slot: MailboxSlot
  ) => Remote<MailboxSlot & { readonly revision: number; readonly status: KeyMailboxStatus }>;
  readonly report: (report: Uint8Array, publication?: Uint8Array) => Remote<void>;
}
export interface RecipientMailboxRemote extends ReceiveMailboxRemote {
  readonly fetch: (
    epoch: number,
    cursor: string | null,
    limit: number
  ) => Remote<{
    readonly items: readonly { readonly sender: string; readonly frame: Uint8Array }[];
    readonly next: string | null;
  }>;
  readonly repair: (slot: MailboxSlot, id: string, rejectedDigest?: string) => Remote<void>;
}
export interface DistributionMailboxRemote extends RecipientMailboxRemote {
  readonly put: (id: string, frame: Uint8Array) => Remote<void>;
  readonly read: (id: string) => Remote<Uint8Array | null>;
}

const NO_PAIR = {} as CryptoKeyPair;
const verifierOnly = (publicKey: SigningPublicKey): DeviceSigner => ({
  publicKey,
  sign: () => Effect.fail(new ContentError({ code: 'sign-failed' })),
});
const pinFile = (file?: string) =>
  path.join(
    file ? path.dirname(file) : mkdtempSync(path.join(tmpdir(), 'e2ee-pin-')),
    'ledger-pin.sqlite'
  );
const backend = (cause: unknown) =>
  cause instanceof BackendError
    ? cause
    : new BackendError({ service: 'KeyMailbox', reason: 'unavailable', cause });
const missing = () =>
  Effect.fail(new BackendError({ service: 'KeyMailbox', reason: 'unavailable' }));

/** Workspace, device and the verified ledger, pinned next to `anchorFile`. */
const identity = (input: {
  readonly genesis: GenesisHash;
  readonly signer: DeviceSigner;
  readonly pair?: CryptoKeyPair;
  readonly ledger: Ledger;
  readonly anchorFile?: string;
}) =>
  VerifiedLedger.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(
          LedgerViewSource,
          LedgerViewSource.of({
            current: () =>
              input.ledger().pipe(Effect.mapError((cause) => new LedgerViewSourceError({ cause }))),
          })
        ),
        sqliteLedgerPinStore({ path: pinFile(input.anchorFile), mode: 'create-or-open' })
      )
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(WorkspaceScope, { genesis: input.genesis }),
        Layer.succeed(DeviceIdentity, {
          signer: input.signer,
          encryptionKeyPair: input.pair ?? NO_PAIR,
        })
      )
    )
  );
/** A `KeyMailbox` Layer over callback-style mailbox calls; any failure becomes `unavailable`. */
export const keyMailboxFromRemote = (borrowed: Partial<DistributionMailboxRemote>) => {
  // Bind once, as an application's adapter would when it is constructed.
  const remote: Partial<DistributionMailboxRemote> = Object.fromEntries(
    Object.entries(borrowed).map(([name, value]) => [
      name,
      typeof value === 'function' ? value.bind(borrowed) : value,
    ])
  );
  return Layer.succeed(
    KeyMailbox,
    KeyMailbox.of({
      status: (slot) =>
        remote.status ? remote.status(slot).pipe(Effect.mapError(backend)) : missing(),
      report: (report, publication) =>
        remote.report
          ? remote.report(report, publication).pipe(Effect.mapError(backend))
          : missing(),
      fetch: (epoch, cursor, limit) =>
        remote.fetch
          ? remote.fetch(epoch, cursor, limit).pipe(Effect.mapError(backend))
          : missing(),
      repair: (slot, id, rejected) =>
        remote.repair
          ? remote.repair(slot, id, rejected).pipe(Effect.mapError(backend))
          : missing(),
      put: (id, frame) =>
        remote.put ? remote.put(id, frame).pipe(Effect.mapError(backend)) : missing(),
      read: (id) => (remote.read ? remote.read(id).pipe(Effect.mapError(backend)) : missing()),
    })
  );
};
const keysLayer = (store: {
  readonly path: string;
  readonly mode: Mode;
  readonly protector: NativeEpochProtector;
}) =>
  InstalledEpochKeys.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        sqliteInstalledKeyStore({ path: store.path, mode: store.mode }),
        KeyProtector.layerFromPromises(store.protector)
      )
    )
  );
const open = <I, E>(layer: Layer.Layer<I, E>) => Layer.build(layer);

/** `InstalledEpochKeys` over one protected-key file. */
export const makeSqliteProtectedEpochKeys = (input: {
  readonly path: string;
  readonly mode: Mode;
  readonly genesis: GenesisHash;
  readonly recipient: SigningPublicKey;
  readonly ledger: Ledger;
  readonly protector: NativeEpochProtector;
}) =>
  Effect.map(
    open(
      keysLayer(input).pipe(
        Layer.provide(
          identity({ ...input, signer: verifierOnly(input.recipient), anchorFile: input.path })
        )
      )
    ),
    (context) => Context.get(context, InstalledEpochKeys)
  );

/** The installed-key sealer alone, without storage. */
export const makeHostEpochProtection = (input: {
  readonly genesis: GenesisHash;
  readonly recipient: SigningPublicKey;
  readonly ledger: Ledger;
  readonly protector: NativeEpochProtector;
  readonly anchorFile?: string;
}) =>
  Effect.flatMap(
    open(
      identity({ ...input, signer: verifierOnly(input.recipient) }).pipe(
        Layer.provideMerge(KeyProtector.layerFromPromises(input.protector))
      )
    ),
    (context) =>
      Effect.gen(function* () {
        // The sealer's own owner: refuses new calls on close and awaits native ones.
        const gate = yield* makeAdmissionGate(() => new InstalledKeyError({ reason: 'closed' }));
        const sealer = yield* makeInstalledKeySealer(gate.guard).pipe(Effect.provide(context));
        return {
          seal: (epoch: number, key: Parameters<typeof sealer.seal>[1]) =>
            gate.run(sealer.seal(epoch, key)),
          open: (epoch: number, blob: Uint8Array) => gate.run(sealer.open(epoch, blob)),
        };
      })
  );

/** `InstalledEpochHistory` borrowing an open `InstalledEpochKeys`. */
export const makeInstalledEpochHistory = (input: {
  readonly genesis: GenesisHash;
  readonly ledger: Ledger;
  readonly installed: InstalledEpochKeys['Service'];
  readonly anchorFile?: string;
}) =>
  Effect.map(
    open(
      InstalledEpochHistory.layer.pipe(
        Layer.provide(Layer.succeed(InstalledEpochKeys, input.installed)),
        // History recovery never uses the device identity.
        Layer.provide(identity({ ...input, signer: verifierOnly(undefined as never) }))
      )
    ),
    (context) => Context.get(context, InstalledEpochHistory)
  );

interface ReceiverInput {
  readonly path: string;
  readonly mode: Mode;
  readonly genesis: GenesisHash;
  readonly signer: DeviceSigner;
  readonly pair: CryptoKeyPair;
  readonly keyStore: {
    readonly path: string;
    readonly mode: Mode;
    readonly protector: NativeEpochProtector;
  };
  readonly ledger: Ledger;
}
const receiverLayer = (input: ReceiverInput, remote: Partial<DistributionMailboxRemote>) =>
  KeyReceiver.layer.pipe(
    Layer.provideMerge(keysLayer(input.keyStore)),
    Layer.provideMerge(
      Layer.mergeAll(
        keyMailboxFromRemote(remote),
        sqliteReceiveJournal({ path: input.path, mode: input.mode })
      )
    ),
    Layer.provideMerge(identity({ ...input, anchorFile: input.path }))
  );
const receiverSurface = (
  context: Context.Context<KeyReceiver | InstalledEpochKeys | VerifiedLedger>
) => {
  const receiver = Context.get(context, KeyReceiver);
  const ledger = Context.get(context, VerifiedLedger);
  return {
    ...receiver,
    installedEpochKeys: Context.get(context, InstalledEpochKeys),
    observeLedger: () => ledger.current(),
  };
};

/** `KeyReceiver` (and its installed keys) over a receive journal and key store. */
export const makeSqliteEpochReceiver = (
  input: ReceiverInput & { readonly remote: ReceiveMailboxRemote }
) => Effect.map(open(receiverLayer(input, input.remote)), receiverSurface);

/** `KeyRepair` over one repair journal. */
export const makeSqliteMailboxRepair = (input: {
  readonly path: string;
  readonly mode: Mode;
  readonly genesis: GenesisHash;
  readonly recipient: SigningPublicKey;
  readonly ledger: Ledger;
  readonly remote: { readonly repair: RecipientMailboxRemote['repair'] };
}) =>
  Effect.map(
    open(
      KeyRepair.layer.pipe(
        Layer.provide(
          Layer.mergeAll(keyMailboxFromRemote(input.remote), sqliteRepairJournal(input))
        ),
        Layer.provideMerge(
          identity({ ...input, signer: verifierOnly(input.recipient), anchorFile: input.path })
        )
      )
    ),
    (context) => Context.get(context, KeyRepair)
  );

const recipientSurface = (
  context: Context.Context<KeyReceiver | KeyRepair | InstalledEpochKeys | VerifiedLedger>
) => {
  const repair = Context.get(context, KeyRepair);
  return {
    ...receiverSurface(context),
    enqueueRepair: repair.enqueue,
    flushRepairs: repair.flush,
    repairResults: repair.results,
    acknowledgeRepair: repair.acknowledge,
  };
};
type RecipientInput = ReceiverInput & {
  readonly repairStore: { readonly path: string; readonly mode: Mode };
};
const recipientLayer = (input: RecipientInput, remote: Partial<DistributionMailboxRemote>) =>
  KeyRepair.layer.pipe(
    Layer.provide(sqliteRepairJournal(input.repairStore)),
    Layer.provideMerge(receiverLayer(input, remote))
  );

/** Receiver plus repair, sharing one mailbox. */
export const makeSqliteRecipientMailbox = (
  input: RecipientInput & { readonly remote: RecipientMailboxRemote }
) => Effect.map(open(recipientLayer(input, input.remote)), recipientSurface);

/** Distributor plus receiver and repair, sharing one mailbox. */
export const makeSqliteKeyDistribution = (
  input: RecipientInput & {
    readonly remote: DistributionMailboxRemote;
    readonly sendStore: { readonly path: string; readonly mode: Mode; readonly maxTasks?: number };
    readonly outboxStore: { readonly path: string; readonly mode: Mode };
    readonly currentPublication: (view: LedgerView) => Effect.Effect<Uint8Array | null, unknown>;
  }
) =>
  Effect.map(
    open(
      KeyDistributor.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            sqliteDistributionJournal(input.sendStore),
            sqliteDeliveryOutbox(input.outboxStore),
            Layer.succeed(
              EpochPublicationSource,
              EpochPublicationSource.of({
                current: (view) =>
                  input.currentPublication(view).pipe(
                    Effect.mapError(
                      (cause) =>
                        new BackendError({
                          service: 'EpochPublicationSource',
                          reason: 'unavailable',
                          cause,
                        })
                    )
                  ),
              })
            )
          )
        ),
        Layer.provideMerge(recipientLayer(input, input.remote))
      )
    ),
    (context) => {
      const distributor = Context.get(context, KeyDistributor);
      return {
        ...recipientSurface(context),
        reconcileCurrentEpoch: distributor.reconcileCurrentEpoch,
        resumePendingDeliveries: distributor.resumePendingDeliveries,
        deliveryResults: distributor.results,
        acknowledgeDelivery: distributor.acknowledge,
      };
    }
  );

export interface EpochStagingPort {
  readonly stageGroup: (group: EpochStagedGroup) => Effect.Effect<void, unknown>;
  readonly readGroup: (key: EpochStagedGroupKey) => Effect.Effect<EpochStagedGroup | null, unknown>;
  readonly deleteGroup: (
    key: EpochStagedGroupKey,
    occupied: { readonly epoch: number; readonly commitment: string }
  ) => Effect.Effect<void, unknown>;
}
/** An `EpochStagingStore` Layer over a callback-style staging port; any failure becomes `unavailable`. */
export const epochStagingStoreFromPort = (port: EpochStagingPort) =>
  Layer.succeed(
    EpochStagingStore,
    EpochStagingStore.of({
      stageGroup: (group) => port.stageGroup(group).pipe(Effect.mapError(staged)),
      readGroup: (key) => port.readGroup(key).pipe(Effect.mapError(staged)),
      deleteGroup: (key, occupied) => port.deleteGroup(key, occupied).pipe(Effect.mapError(staged)),
    })
  );
/** A staging backend refusal keeps its reason; anything else is `unavailable`. */
const refusal = (cause: unknown) => {
  const code = (cause as { readonly code?: unknown } | null)?.code;
  return code === 'unauthorized' || code === 'invalid-response' ? code : 'unavailable';
};
const staged = (cause: unknown) =>
  cause instanceof BackendError
    ? cause
    : new BackendError({ service: 'EpochStagingStore', reason: refusal(cause), cause });

/**
 * `EpochPublisher` over one candidate file, borrowing an open
 * `InstalledEpochKeys`, plus the caller's `SubmissionJournal` and `LedgerLog`.
 */
export const makeSqliteEpochRotation = (input: {
  readonly path: string;
  readonly mode: Mode;
  readonly genesis: GenesisHash;
  readonly signer: DeviceSigner;
  readonly ledger: Ledger;
  readonly installed: InstalledEpochKeys['Service'];
  readonly protector: NativeEpochProtector;
  readonly staging: EpochStagingPort;
}) =>
  Effect.gen(function* () {
    const journal = yield* SubmissionJournal;
    const log = yield* LedgerLog;
    const context = yield* open(
      EpochPublisher.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(InstalledEpochKeys, input.installed),
            CandidateProtector.layerFromPromises(input.protector),
            Layer.succeed(
              EpochStagingStore,
              EpochStagingStore.of({
                stageGroup: (group) =>
                  input.staging.stageGroup(group).pipe(Effect.mapError(staged)),
                readGroup: (key) => input.staging.readGroup(key).pipe(Effect.mapError(staged)),
                deleteGroup: (key, occupied) =>
                  input.staging.deleteGroup(key, occupied).pipe(Effect.mapError(staged)),
              })
            ),
            sqliteEpochCandidateStore({ path: input.path, mode: input.mode }),
            LedgerSubmission.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(SubmissionJournal, journal),
                  Layer.succeed(LedgerLog, log)
                )
              )
            )
          )
        ),
        Layer.provideMerge(identity({ ...input, anchorFile: input.path }))
      )
    );
    return Context.get(context, EpochPublisher);
  });

/** A delivery transport failure: the backend is unavailable, retry later. */
export class DeliveryRemoteError extends Data.TaggedError('DeliveryRemoteError')<{}> {}
/** The two mailbox calls a sender's delivery uses, as a `KeyMailbox`. Transport
 * failures become `unavailable`; any other failure is a backend refusal. */
export interface DeliveryRemoteShape {
  readonly put: (slot: string, frame: Uint8Array) => Effect.Effect<void, unknown>;
  readonly read: (slot: string) => Effect.Effect<Uint8Array | null, unknown>;
}
export const DeliveryRemote = { of: (remote: DeliveryRemoteShape) => remote };
export const deliveryMailbox = (remote: DeliveryRemoteShape) => {
  const refused = (cause: unknown) =>
    new BackendError({
      service: 'KeyMailbox',
      reason: cause instanceof DeliveryRemoteError ? 'unavailable' : 'conflict',
      cause,
    });
  return KeyMailbox.of({
    status: missing,
    report: missing,
    fetch: missing,
    repair: missing,
    put: (slot, frame) => remote.put(slot, frame).pipe(Effect.mapError(refused)),
    read: (slot) => remote.read(slot).pipe(Effect.mapError(refused)),
  });
};
