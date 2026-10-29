import { Cause, Context, Effect, Exit, Layer, Schema, Scope, Semaphore, Result } from 'effect';
import * as Bytes from '../foundation/bytes';
import type { DeviceSigner } from '../foundation/signing';
import { contentPermissions, type LedgerView } from '../ledger';
import { keyId } from '../foundation/identifiers';
import { comparisonNote } from '../ledger/snapshot';
import { VerifiedLedger } from '../ledger/verified-ledger';
import { InstalledEpochHistory, InstalledEpochKeys } from '../keys/installed-keys';
import { KeyReceiver } from '../keys/receiver';
import { KeyRepair } from '../keys/repair';
import { KeyDistributor } from '../keys/distributor';
import { EpochPublisher, type EpochPublishResult } from '../keys/publisher';
import { getCommittedEpochStagingKey } from '../keys/staging';
import { makeStreamsUpdateBinding } from '../content/streams';
import { runWorkspaceKeyRound, type WorkspaceKeyRoundCursors } from './key-round';
import { makeWorkspaceOperations } from './operations';
import { WorkspaceControl } from './control';
import { makeWorkspaceRecovery, type WorkspaceRecoveryInput } from '../recovery';
import { disposeEpochKey } from '../foundation/epoch-key';
import { E2eeWorkflows } from '../../workflows';
import { EpochStagingStore } from '../../services/keys';
import { LedgerViewSourceError } from '../../services/errors';
import { LedgerSync, LedgerViewSource } from '../../services/ledger';
import { DeviceIdentity, WorkspaceScope } from '../../services/workspace';
export { WorkspaceControl, WorkspaceControlError } from './control';
export {
  runWorkspaceKeyRound,
  WorkspaceKeyRoundCursors,
  WorkspaceKeyRoundError,
  WorkspaceKeyRoundFailure,
} from './key-round';
export * from './invitation';
export { verifyRetainedWorkspaceGenesis } from './creation';
/**
 * A workspace call was refused: `closed`, `configuration` (bad document id or
 * model, or restored resources that do not match the recovered identity),
 * `unknown-document` or `recovery-unavailable` (no recovery configured).
 *
 * @category Errors
 */
export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()('WorkspaceError', {
  reason: Schema.Literals(['closed', 'configuration', 'unknown-document', 'recovery-unavailable']),
}) {}
const refuse = (reason: WorkspaceError['reason']) => new WorkspaceError({ reason });
/** Document model of a workspace resource. */
export type WorkspaceModel = 'loro' | 'flock';
/** Whether the current epoch needs rotation and whether this device may rotate. */
export interface WorkspaceRotationStatus {
  readonly rotationRequired: boolean;
  readonly epoch: number;
  readonly mayRotate: boolean;
}
/** Native model state belongs to its platform adapter. Crypto always comes from
 * this workspace's genuine ledger and installed-key owner. */
export interface WorkspaceDocumentState {
  create(): Effect.Effect<void, unknown>;
  append(text: string): Effect.Effect<void, unknown>;
  editOffline(text: string): Effect.Effect<void, unknown>;
  flushOffline(): Effect.Effect<void, unknown>;
  persist(): Effect.Effect<void, unknown>;
  uploadSnapshot(): Effect.Effect<void, unknown>;
  pull(): Effect.Effect<void, unknown>;
  recoverFromFullHistory(): Effect.Effect<void, unknown>;
  text(): Effect.Effect<string, unknown>;
  cursor(): Effect.Effect<unknown, unknown>;
  status(): Effect.Effect<'closed' | 'document-stopped' | 'active'>;
}
/**
 * Every port a workspace needs from its platform: all ports of
 * `E2eeWorkflows` except `LedgerViewSource`, which the workspace derives from
 * {@link LedgerSync} so every workflow sees a freshly refreshed genuine view.
 */
export type WorkspacePorts =
  | Exclude<Layer.Services<typeof E2eeWorkflows>, LedgerViewSource>
  | LedgerSync;

/** What a platform supplies to open one workspace. */
export interface WorkspaceResources {
  /** All ports, built in the workspace's Scope (stores, backends, identity, protectors). */
  readonly ports: Layer.Layer<WorkspacePorts, unknown>;
  /**
   * Recovery inputs, or a function that derives them once the workspace's
   * workflows exist (for example to deliver a recovery device's envelope).
   */
  readonly recoveryConfiguration?:
    | WorkspaceRecoveryConfiguration
    | ((
        services: Context.Context<WorkspaceServices>
      ) => Effect.Effect<WorkspaceRecoveryConfiguration, unknown, Scope.Scope>);
  /** Stop admitting platform work (abort transports) before owners close. */
  readonly stop: () => Effect.Effect<void, unknown>;
  /** Native document model state for a resource, given its content binding and the workspace's services. */
  readonly documentState: (
    resource: string,
    model: WorkspaceModel,
    crypto: Effect.Success<ReturnType<typeof makeStreamsUpdateBinding>>,
    services: Context.Context<WorkspaceServices>
  ) => Effect.Effect<WorkspaceDocumentState, unknown, Scope.Scope>;
}
/** Recovery inputs a platform supplies; the workspace adds identity, ledger, submission and keys. */
export type WorkspaceRecoveryConfiguration = Omit<
  WorkspaceRecoveryInput,
  'genesis' | 'personalSigner' | 'ledger' | 'submitOriginal' | 'installed'
>;
type RecoveryOwner = Effect.Success<ReturnType<typeof makeWorkspaceRecovery>>;
/** The new personal device a restore admits through the recovery device. */
export interface WorkspaceRestoreRequest {
  readonly personal: Parameters<RecoveryOwner['restoreFromRecovery']>[0]['personal'];
}
/** What a platform prepares to restore a workspace from recovery: the recovery workflow input, how to submit as the recovery device, and how to open the new personal device afterwards. */
export interface WorkspaceRestorePlan {
  readonly workflow: WorkspaceRecoveryInput;
  readonly submitOriginalAsRecovery: Parameters<
    RecoveryOwner['restoreFromRecovery']
  >[0]['submitOriginalAsRecovery'];
  /** Opens the personal device's own storage and identity only after verified admission. */
  readonly acquirePersonal: () => Effect.Effect<WorkspaceResources, unknown, Scope.Scope>;
}
/**
 * The platform behind {@link E2eeWorkspace}: opens a workspace's ports
 * (Streams, mailbox, staging, stores, protectors, identity, local paths) in
 * the caller's Scope, and prepares a restore from recovery. The workspace
 * never imports a concrete host or chooses hidden defaults.
 *
 * @category Application ports
 */
export class WorkspacePlatform extends Context.Service<
  WorkspacePlatform,
  {
    /** Acquire ports and native owners in the caller Scope; create initializes new resources, open reuses retained originals and pins. */
    acquire(mode: 'create' | 'open'): Effect.Effect<WorkspaceResources, unknown, Scope.Scope>;
    /** Prepare recovery and subsequent personal-device acquisition in the caller Scope; this alone does not admit or open that device. */
    prepareRecovery(
      input: WorkspaceRestoreRequest
    ): Effect.Effect<WorkspaceRestorePlan, unknown, Scope.Scope>;
  }
>()('@lody/e2ee-core/workspace/Platform') {
  static layer(implementation: WorkspacePlatform['Service']) {
    return Layer.succeed(WorkspacePlatform, implementation);
  }
}
/** Recovery operations of a workspace opened without a recovery configuration. */
export const unavailableWorkspaceRecovery = Object.freeze({
  setup: () => Effect.fail(refuse('recovery-unavailable')),
  skip: (_confirmation: Parameters<RecoveryOwner['skip']>[0]) =>
    Effect.fail(refuse('recovery-unavailable')),
  replace: (_request: Parameters<RecoveryOwner['replace']>[0]) =>
    Effect.fail(refuse('recovery-unavailable')),
  test: () => Effect.fail(refuse('recovery-unavailable')),
  status: (): Effect.Effect<Effect.Success<ReturnType<RecoveryOwner['status']>>> =>
    Effect.succeed(
      Object.freeze({
        paired: false,
        envelopeAvailable: false,
        recoverable: false,
        currentEpoch: null,
        testedEpoch: null,
        lastTest: null,
        skipped: false,
      })
    ),
});
/** The workflows a workspace runs, built from the platform's ports. */
const workspaceLayer = (ports: WorkspaceResources['ports']) =>
  WorkspaceControl.layer.pipe(
    Layer.provideMerge(E2eeWorkflows),
    Layer.provideMerge(
      Layer.effect(
        LedgerViewSource,
        Effect.gen(function* () {
          const sync = yield* LedgerSync;
          return LedgerViewSource.of({
            current: () =>
              sync.refresh().pipe(
                Effect.map((state) => state.view),
                Effect.mapError((cause) => new LedgerViewSourceError({ cause }))
              ),
          });
        })
      )
    ),
    Layer.provideMerge(ports)
  );
type WorkspaceServices = Layer.Success<ReturnType<typeof workspaceLayer>>;

/**
 * Open one workspace from `acquire`. `prepare` runs once the workflows are
 * built, before the handle is returned (restore uses it to install recovered
 * keys). Close stops platform work, waits active operations, then releases
 * the workflows and stores; it never publishes Streams EOF or deletes journals.
 * Every call after close fails with `closed`.
 *
 * @category Workflows
 */
export const makeE2eeWorkspace = Effect.fn('E2eeWorkspace.acquire')(function* (
  acquire: Effect.Effect<WorkspaceResources, unknown, Scope.Scope>,
  prepare: (services: Context.Context<WorkspaceServices>) => Effect.Effect<void, unknown> = () =>
    Effect.void
) {
  const child = yield* Scope.make(),
    operationScope = yield* Scope.make();
  let closed = false,
    stop: () => Effect.Effect<void, unknown> = () => Effect.void;
  const close = yield* Effect.cached(
    Effect.uninterruptible(
      Effect.gen(function* () {
        closed = true;
        // Admission/abort, active workflow settlement, then native key/DB owners.
        // These are separate scopes so lazily opened documents cannot reverse order.
        const exits = [
          yield* Effect.exit(stop()),
          yield* Effect.exit(Scope.close(operationScope, Exit.void)),
          yield* Effect.exit(Scope.close(child, Exit.void)),
        ];
        const reasons = exits.flatMap((exit) => (Exit.isFailure(exit) ? exit.cause.reasons : []));
        if (reasons.length) yield* Effect.failCause(Cause.fromReasons(reasons));
      })
    )
  );
  yield* Effect.addFinalizer(() => close.pipe(Effect.orDie));
  return yield* Scope.provide(
    Effect.gen(function* () {
      const resources = yield* acquire;
      stop = resources.stop.bind(resources);
      const services = yield* Layer.build(workspaceLayer(resources.ports));
      const get = <I extends WorkspaceServices, S>(tag: Context.Key<I, S>) =>
        Context.get(services, tag);
      const genesis = get(WorkspaceScope).genesis;
      const signer: DeviceSigner = get(DeviceIdentity).signer;
      const control = get(WorkspaceControl),
        verified = get(VerifiedLedger),
        installed = get(InstalledEpochKeys),
        history = get(InstalledEpochHistory),
        receiver = get(KeyReceiver),
        repair = get(KeyRepair),
        distributor = get(KeyDistributor),
        publisher = get(EpochPublisher),
        staging = get(EpochStagingStore);
      yield* prepare(services);
      const ledger = () => verified.current();
      const operations = yield* Scope.provide(makeWorkspaceOperations(), operationScope);
      const serial = yield* Semaphore.make(1);
      const run = <A, E, R>(effect: Effect.Effect<A, E, R | Scope.Scope>) =>
        operations.run(
          Effect.suspend<A, E | WorkspaceError, R | Scope.Scope>(() =>
            closed ? Effect.fail(refuse('closed')) : effect
          )
        );
      const ordered = <A, E, R>(effect: Effect.Effect<A, E, R | Scope.Scope>) =>
        run(serial.withPermit(effect));
      const rotationStatus = Effect.fnUntraced(function* () {
        const { view } = yield* control.current();
        // Authenticate runtime provenance before inspecting the detached facts.
        yield* Effect.fromResult(contentPermissions(view, signer.publicKey));
        const state = view.inspectState(),
          device = state.devices.get(keyId(signer.publicKey.toBytes())),
          member = device && state.members.get(keyId(device.membershipId.toBytes()));
        return Object.freeze({
          rotationRequired: state.epoch.rotationRequired,
          epoch: state.epoch.number,
          mayRotate:
            device?.kind === 'personal' && (member?.role === 'owner' || member?.role === 'admin'),
        } satisfies WorkspaceRotationStatus);
      });
      const receiveCommittedEpoch = Effect.fnUntraced(function* () {
        const view = yield* ledger(),
          epoch = view.inspectState().epoch.number;
        if (epoch === 0) return { staged: false, installed: false } as const;
        const located = getCommittedEpochStagingKey(view, epoch);
        if (Result.isFailure(located) && view.verification === 'endorsed-snapshot')
          return {
            staged: false,
            installed: false,
            reason: 'publication-original-unavailable',
          } as const;
        const key = yield* Effect.fromResult(located),
          group = yield* staging.readGroup(key);
        if (!group) return { staged: false, installed: false } as const;
        const self = keyId(signer.publicKey.toBytes());
        if (!group.envelopes.some((row) => row.recipient === self))
          return { staged: true, installed: false } as const;
        yield* receiver.receiveStagedGroup(group);
        return { staged: true, installed: true } as const;
      });
      const documents = new Map<
        string,
        {
          state: WorkspaceDocumentState;
          crypto: Effect.Success<ReturnType<typeof makeStreamsUpdateBinding>>;
        }
      >();
      const document = Effect.fnUntraced(function* (resource: string, model: WorkspaceModel) {
        if (!resource || (model !== 'loro' && model !== 'flock'))
          return yield* refuse('configuration');
        const key = JSON.stringify([resource, model]);
        let found = documents.get(key);
        if (!found) {
          const crypto = yield* Scope.provide(
            makeStreamsUpdateBinding({
              genesis,
              resource,
              model,
              writeEpoch: 'current',
              signer,
              ledger,
              readEpochKey: (epoch) => history.read(epoch),
            }),
            child
          );
          const state = yield* Scope.provide(
            resources.documentState(resource, model, crypto, services),
            child
          );
          found = { crypto, state };
          documents.set(key, found);
        }
        const owner = found;
        return Object.freeze({
          seal: (request: Parameters<typeof owner.crypto.seal>[0]) =>
            run(owner.crypto.seal(request)),
          open: (request: Parameters<typeof owner.crypto.open>[0]) =>
            run(owner.crypto.open(request)),
          snapshot: (request: Parameters<typeof owner.crypto.seal>[0]) =>
            request.context.kind === 'snapshot'
              ? run(owner.crypto.seal(request))
              : Effect.fail(refuse('configuration')),
          state: owner.state,
        });
      });
      const recoveryConfiguration =
        typeof resources.recoveryConfiguration === 'function'
          ? yield* Scope.provide(resources.recoveryConfiguration(services), child)
          : resources.recoveryConfiguration;
      const recovery = recoveryConfiguration
        ? yield* makeWorkspaceRecovery({
            ...recoveryConfiguration,
            genesis,
            personalSigner: signer,
            ledger,
            installed,
            submitOriginal: Effect.fnUntraced(function* (record: Uint8Array) {
              const resumed = yield* control.resume();
              const result = resumed ?? (yield* control.executeOriginal(record));
              if (
                result.record.length !== record.length ||
                result.record.some((byte, index) => byte !== record[index])
              )
                return yield* refuse('configuration');
              yield* control.acknowledge(result);
              return result;
            }),
          })
        : unavailableWorkspaceRecovery;
      return Object.freeze({
        close: () => close,
        genesis,
        signer,
        /** The workspace's workflow services, for operations this handle does not wrap. */
        services,
        current: () => run(control.current()),
        refresh: () => ordered(control.refresh()),
        rotationStatus: () => ordered(rotationStatus()),
        execute: (command: Parameters<typeof control.execute>[0]) =>
          ordered(control.execute(command)),
        executeOriginal: (record: Uint8Array) => ordered(control.executeOriginal(record)),
        resume: () => ordered(control.resume()),
        acknowledge: (result: Parameters<typeof control.acknowledge>[0]) =>
          ordered(control.acknowledge(result)),
        rotate: () => ordered(publisher.publish()),
        removeMember: (membershipId: Bytes.MembershipId) =>
          ordered(publisher.publishRemoving(membershipId)),
        resumeRotation: () => ordered(publisher.resume()),
        acknowledgeRotation: (result: EpochPublishResult) => ordered(publisher.acknowledge(result)),
        cleanupStaged: () => run(publisher.cleanupStaged()),
        staging,
        receiveCommittedEpoch: () => run(receiveCommittedEpoch()),
        keyRound: (limit = 100, cursors: WorkspaceKeyRoundCursors = {}) =>
          ordered(
            runWorkspaceKeyRound(limit, cursors, receiveCommittedEpoch()).pipe(
              Effect.provide(services)
            )
          ),
        recoverHistory: () => run(history.recover()),
        enqueueRepair: (id: string, digest?: string) => ordered(repair.enqueue(id, digest)),
        receiveResults: (limit = 100) => ordered(receiver.results(limit)),
        repairResults: (limit = 100, cursor: string | null = null) =>
          ordered(repair.results(limit, cursor)),
        deliveryResults: (limit = 100, cursor: string | null = null) =>
          ordered(distributor.results(limit, cursor)),
        acknowledgeReceive: (id: string) => ordered(receiver.acknowledge(id)),
        acknowledgeRepair: (id: string) => ordered(repair.acknowledge(id)),
        acknowledgeDelivery: (id: string) => ordered(distributor.acknowledge(id)),
        comparisonNote: () =>
          ordered(
            ledger().pipe(
              Effect.flatMap((view: LedgerView) =>
                Effect.fromResult(comparisonNote(view, signer.publicKey))
              )
            )
          ),
        document: (resource: string, model: WorkspaceModel) => ordered(document(resource, model)),
        recovery: Object.freeze({
          setup: () => ordered(recovery.setup()),
          skip: (confirmation: Parameters<RecoveryOwner['skip']>[0]) =>
            ordered(recovery.skip(confirmation)),
          replace: (request: Parameters<RecoveryOwner['replace']>[0]) =>
            ordered(recovery.replace(request)),
          test: () => ordered(recovery.test()),
          status: () => run(recovery.status()),
        }),
      });
    }),
    child
  ).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? close : Effect.void)));
});

/**
 * Entry points of a workspace backed by {@link WorkspacePlatform}: `create`
 * and `open` an existing one, or `restoreFromRecovery` after losing every
 * personal device (recovery device admits a new personal device, then the
 * workspace opens with the recovered keys installed).
 *
 * @category Workflows
 */
export class E2eeWorkspace {
  static create = Effect.fn('E2eeWorkspace.create')(function* () {
    const platform = yield* WorkspacePlatform;
    return yield* makeE2eeWorkspace(platform.acquire('create'));
  });
  static open = Effect.fn('E2eeWorkspace.open')(function* () {
    const platform = yield* WorkspacePlatform;
    return yield* makeE2eeWorkspace(platform.acquire('open'));
  });
  static restoreFromRecovery = Effect.fn('E2eeWorkspace.restoreFromRecovery')(function* (
    input: WorkspaceRestoreRequest
  ) {
    const platform = yield* WorkspacePlatform;
    return yield* Effect.acquireUseRelease(
      Effect.scoped(
        Effect.gen(function* () {
          const plan = yield* platform.prepareRecovery(input);
          const recovery = yield* makeWorkspaceRecovery(plan.workflow);
          const result = yield* recovery.restoreFromRecovery({
            personal: input.personal,
            submitOriginalAsRecovery: plan.submitOriginalAsRecovery,
          });
          const keys: Array<readonly [number, Bytes.EpochKey]> = [];
          yield* Effect.gen(function* () {
            if (result.outcome === 'Committed')
              for (let epoch = 0; epoch <= result.epoch; epoch++)
                keys.push([epoch, yield* plan.workflow.installed.read(epoch)]);
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? Effect.sync(() => {
                    for (const [, key] of keys) disposeEpochKey(key);
                  })
                : Effect.void
            )
          );
          return { result, keys, genesis: plan.workflow.genesis, acquire: plan.acquirePersonal };
        })
      ),
      (restored) =>
        Effect.gen(function* () {
          if (restored.result.outcome !== 'Committed')
            return {
              outcome: restored.result.outcome,
              epoch: restored.result.epoch,
              workspace: null,
            };
          const workspace = yield* makeE2eeWorkspace(restored.acquire(), (services) =>
            Effect.gen(function* () {
              const identity = Context.get(services, DeviceIdentity);
              if (
                !Context.get(services, WorkspaceScope).genesis.equals(restored.genesis) ||
                !identity.signer.publicKey.equals(input.personal.publicKey)
              )
                return yield* refuse('configuration');
              const current = yield* Context.get(services, WorkspaceControl).refresh();
              const device = current.view
                .inspectState()
                .devices.get(keyId(input.personal.publicKey.toBytes()));
              if (
                !device ||
                device.kind !== 'personal' ||
                !device.encryptionPublicKey.equals(input.personal.encryptionPublicKey)
              )
                return yield* refuse('configuration');
              const installed = Context.get(services, InstalledEpochKeys);
              for (const [epoch, key] of restored.keys) yield* installed.saveAndReload(epoch, key);
              return undefined;
            })
          );
          return { outcome: 'Committed' as const, epoch: restored.result.epoch, workspace };
        }),
      (restored) =>
        Effect.sync(() => {
          for (const [, key] of restored.keys) disposeEpochKey(key);
        })
    );
  });
}
/** The handle `E2eeWorkspace.open` returns. */
export type E2eeWorkspaceHandle = Effect.Success<ReturnType<typeof E2eeWorkspace.open>>;
