import { makePersonalKeyMaintenance } from './maintenance';
import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Scope,
  Semaphore,
  Result,
} from 'effect';
import {
  makeWorkspaceRecovery,
  InstalledEpochHistory,
  InstalledEpochKeys,
  KeyReceiver,
  KeyRepair,
  KeyDistributor,
  EpochPublisher,
  LedgerSubmission,
  VerifiedLedger,
  WorkspaceControl,
} from '@lody/e2ee-core';
import {
  epochHistoryPacket,
  getCommittedEpochStagingKey,
  requireLedgerContinuation,
  decodeRecord,
  prepareLedgerCommand,
  signLedgerRecord,
  signLedgerSnapshot,
  signExecutionIntent,
  verifyDeviceCredentialBinding,
  type LedgerCommand,
  Bytes,
} from '@lody/e2ee-core/protocol';
import { verifyWorkspaceInvitationSnapshot } from '@lody/e2ee-core';
import {
  makeStreamsUpdateBinding,
  makeRealtimeContentBinding,
} from '@lody/e2ee-core/adapters/loro-streams';
import { clientKeyProtectors } from '@lody/e2ee-core/adapters/browser-custody';
import { makeE2eeRpcClient } from '@lody/loro-streams-rpc/e2ee-client';
import {
  ClientInstallationStore,
  ClientKeyCustody,
  ClientRpcOriginalStore,
  DeviceIdentity,
  WorkspaceScope,
  LedgerSync,
  LedgerLog,
  LedgerPinStore,
  SubmissionJournal,
  LedgerViewSource,
  LedgerViewSourceError,
  LedgerLogError,
  InstalledKeyStore,
  ReceiveJournal,
  RepairJournal,
  DistributionJournal,
  DeliveryOutbox,
  EpochCandidateStore,
  KeyMailbox,
  EpochStagingStore,
  EpochPublicationSource,
} from '@lody/e2ee-core/services';
import {
  acquirePersonalCustody,
  openPreparedIdentity,
  sameBinding,
  type PreparedPersonalIdentity,
} from './installation';
import { PersonalHostPlatform, PersonalMachineSharing, type PersonalApproval } from './platform';
import { assertPersonalAdmission } from './admission';
import { fail } from './errors';
import type { PersonalRecoverySetupInput } from './recovery-restore';
import { fromHex, toHex } from './bytes';
// The subpath, never the package index: this host runs in browsers.
import {
  encodeE2eeIntentRecord,
  scheduleDeclarationSubject,
} from '@lody/shared/e2ee-execution-intent';
import type { ScheduleDocument } from '@lody/shared';
import { encodePersonalInvitation } from './pairing';
import { decodeMemberKeyPackage, signMemberOffer, verifyAutomaticMemberAdmission } from './member';
import { irohTargetDevice, makePersonalIrohRoute } from './iroh-route';
import type { PersonalIrohEndpoint } from './platform';

/** Private composition. Product callers receive narrow operations, never signer/credential/core services. */
export const openPersonalSession = Effect.fnUntraced(function* (
  prepared: PreparedPersonalIdentity,
  approval: PersonalApproval,
  recovered: readonly (readonly [number, Bytes.EpochKey])[] = []
) {
  const platform = yield* PersonalHostPlatform,
    installation = yield* ClientInstallationStore;
  const parent = yield* Scope.Scope;
  const owner = yield* Scope.fork(parent),
    operationsScope = yield* Scope.fork(parent);
  let closed = false;
  const close = yield* Effect.cached(
    Effect.uninterruptible(
      Effect.gen(function* () {
        closed = true;
        const exits = [
          yield* Effect.exit(Scope.close(operationsScope, Exit.void)),
          yield* Effect.exit(Scope.close(owner, Exit.void)),
        ];
        const reasons = exits.flatMap((e) => (Exit.isFailure(e) ? e.cause.reasons : []));
        if (reasons.length) yield* Effect.failCause(Cause.fromReasons(reasons));
      })
    )
  );
  yield* Effect.addFinalizer(() => close.pipe(Effect.orDie));
  const guard = Effect.gen(function* () {
    if (closed) return yield* fail('closed');
    const current = yield* installation.read();
    if (!current || current.phase !== 'ready' || !sameBinding(current.binding, prepared.binding))
      return yield* fail('identity-lost');
    return undefined;
  });
  const work = Effect.gen(function* () {
    yield* guard;
    const { custody } = yield* acquirePersonalCustody(prepared);
    const { device, credential, request } = yield* openPreparedIdentity(prepared, custody);
    yield* Effect.fromResult(assertPersonalAdmission(prepared.binding, request, approval.view));
    const identity = Layer.merge(
      Layer.succeed(DeviceIdentity, { signer: device, encryptionKeyPair: device.encryption }),
      Layer.succeed(WorkspaceScope, { genesis: prepared.binding.genesis })
    );
    const rawControl = yield* Layer.build(platform.control(prepared.binding, credential, approval));
    // Keep only owned ports: an adapter cannot replace the host's signer or verifier through an extra Layer output.
    const rawSync = Context.get(rawControl, LedgerSync),
      rawLog = Context.get(rawControl, LedgerLog);
    const sync = Object.freeze({
      current: rawSync.current.bind(rawSync),
      refresh: rawSync.refresh.bind(rawSync),
    });
    const log = Object.freeze({
      read: rawLog.read.bind(rawLog),
      appendCas: rawLog.appendCas.bind(rawLog),
    });
    const controlPorts = Layer.succeedContext(
      Context.pick(
        LedgerSync,
        LedgerLog,
        LedgerPinStore,
        SubmissionJournal
      )(rawControl).pipe(
        Context.add(LedgerSync, sync),
        Context.add(LedgerLog, {
          appendCas: log.appendCas.bind(log),
          read: (anchor) =>
            log.read(anchor).pipe(
              Effect.tap(() => sync.refresh()),
              Effect.mapError((cause) =>
                cause instanceof LedgerLogError ? cause : new LedgerLogError({ cause })
              )
            ),
        })
      )
    );
    const source = Layer.succeed(LedgerViewSource, {
      current: () =>
        sync.current().pipe(
          Effect.map((s) => s.view),
          Effect.mapError((cause) => new LedgerViewSourceError({ cause }))
        ),
    });
    const controlLayer = WorkspaceControl.layer.pipe(
      Layer.provideMerge(Layer.merge(VerifiedLedger.layer, LedgerSubmission.layer)),
      Layer.provideMerge(Layer.mergeAll(identity, controlPorts, source))
    );
    const controlServices = yield* Layer.build(controlLayer);
    const verified = Context.get(controlServices, VerifiedLedger),
      control = Context.get(controlServices, WorkspaceControl);
    const ledger = Effect.fnUntraced(function* () {
      yield* guard;
      const view = yield* verified.current();
      yield* Effect.fromResult(requireLedgerContinuation(approval.view, view));
      yield* guard;
      return view;
    });
    const admitted = Effect.fnUntraced(function* () {
      const view = yield* ledger();
      yield* Effect.fromResult(assertPersonalAdmission(prepared.binding, request, view));
      return view;
    });
    const submission = Context.get(controlServices, LedgerSubmission);
    const ownRecord = (record: Uint8Array) =>
      Effect.gen(function* () {
        const parsed = yield* Effect.fromResult(decodeRecord(new Uint8Array(record)));
        if (parsed.body.type !== 'ordinary' || !parsed.body.signer.equals(device.publicKey))
          return yield* fail('conflict');
        return undefined;
      });
    const ownSubmission = Effect.gen(function* () {
      const pending = yield* submission.pending();
      if (pending.record) yield* ownRecord(pending.record);
    });
    // Readable ledger precedes lazy acquisition of every key store/backend.
    yield* ledger();
    const fibers = yield* Scope.provide(FiberSet.make(), operationsScope),
      serial = yield* Semaphore.make(1);
    const run = <A, E>(effect: Effect.Effect<A, E>, dispose?: (value: A) => void) =>
      Effect.gen(function* () {
        yield* guard;
        const fiber = yield* FiberSet.run(
          fibers,
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              yield* restore(guard);
              const value = yield* restore(effect);
              const checked = yield* Effect.exit(guard);
              if (Exit.isFailure(checked)) {
                dispose?.(value);
                return yield* Effect.failCause(checked.cause);
              }
              return value;
            })
          )
        );
        return yield* Fiber.join(fiber);
      });
    const keyLayer = Layer.mergeAll(
      KeyRepair.layer,
      KeyDistributor.layer,
      EpochPublisher.layer,
      InstalledEpochHistory.layer
    ).pipe(Layer.provideMerge(KeyReceiver.layer), Layer.provideMerge(InstalledEpochKeys.layer));
    type Keys =
      | Layer.Success<typeof keyLayer>
      | EpochStagingStore
      | EpochCandidateStore
      | KeyMailbox;
    let keyServices: Context.Context<Keys> | undefined;
    let maintenance: Effect.Success<ReturnType<typeof makePersonalKeyMaintenance>> | undefined;
    const keySerial = yield* Semaphore.make(1);
    const keys = () =>
      keySerial
        .withPermit(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              yield* restore(admitted());
              if (keyServices) return keyServices;
              const child = yield* Scope.fork(owner);
              const rawResult = yield* Effect.exit(
                restore(
                  Scope.provide(
                    Layer.build(
                      platform
                        .keys(prepared.binding, credential)
                        .pipe(Layer.provide(Layer.succeedContext(controlServices)))
                    ),
                    child
                  )
                )
              );
              if (Exit.isFailure(rawResult)) {
                yield* Scope.close(child, rawResult);
                return yield* Effect.failCause(rawResult.cause);
              }
              const rawPorts = rawResult.value;
              const ports = Layer.succeedContext(
                Context.pick(
                  InstalledKeyStore,
                  ReceiveJournal,
                  RepairJournal,
                  DistributionJournal,
                  DeliveryOutbox,
                  EpochCandidateStore,
                  KeyMailbox,
                  EpochStagingStore,
                  EpochPublicationSource
                )(rawPorts)
              );
              const all = keyLayer.pipe(
                Layer.provideMerge(ports),
                Layer.provideMerge(
                  clientKeyProtectors.pipe(Layer.provide(Layer.succeed(ClientKeyCustody, custody)))
                ),
                Layer.provide(Layer.succeedContext(controlServices))
              );
              const result = yield* Effect.exit(restore(Scope.provide(Layer.build(all), child)));
              if (Exit.isFailure(result)) {
                yield* Scope.close(child, result);
                return yield* Effect.failCause(result.cause);
              }
              maintenance = yield* makePersonalKeyMaintenance().pipe(Effect.provide(result.value));
              keyServices = result.value;
              return keyServices;
            })
          )
        )
        .pipe(Scope.provide(owner));
    const withKeys = <A, E>(use: (context: Context.Context<Keys>) => Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const ctx = yield* keys();
        yield* admitted();
        const value = yield* use(ctx);
        yield* admitted();
        return value;
      });
    const keyRound = () =>
      serial.withPermit(
        withKeys((ctx) =>
          Effect.gen(function* () {
            const view = yield* admitted(),
              epoch = view.inspectState().epoch.number;
            const beforeReceive = Effect.gen(function* () {
              if (epoch === 0) return undefined;
              const checked = yield* Effect.result(
                Context.get(ctx, InstalledEpochKeys).check(epoch)
              );
              if (Result.isSuccess(checked)) return undefined;
              const located = getCommittedEpochStagingKey(view, epoch);
              if (Result.isFailure(located)) {
                if (view.verification === 'endorsed-snapshot') return undefined;
                return yield* located.failure;
              }
              // Staging availability must not gate the independent verified mailbox path.
              const group = yield* Context.get(ctx, EpochStagingStore)
                .readGroup(located.success)
                .pipe(Effect.catch(() => Effect.succeed(null)));
              if (
                group !== null &&
                group.envelopes.some((row) => row.recipient === toHex(device.publicKey.toBytes()))
              )
                yield* Context.get(ctx, KeyReceiver).receiveStagedGroup(group);
              return undefined;
            });
            return { refreshRequired: yield* maintenance!(epoch, beforeReceive) };
          })
        )
      );
    /** Positive evidence only, as on the desktop: 'delivered' when the mailbox holds an
     * envelope for `recipient` at the current epoch, else a public retryable code. A
     * finished key round is not evidence: a refused store or a blocked target also ends. */
    const keyDeliveryEvidence = (recipient: string) =>
      withKeys((ctx) =>
        Effect.gen(function* () {
          const view = yield* admitted(),
            state = view.inspectState();
          const target = state.devices.get(recipient);
          if (!target || !state.members.has(toHex(target.membershipId.toBytes())))
            return 'e2ee_admission_not_ingested';
          // KeyDistributor's sender eligibility: a non-recovery device of an active member.
          const own = state.devices.get(toHex(device.publicKey.toBytes()));
          if (
            !own ||
            own.kind === 'recovery' ||
            !state.members.has(toHex(own.membershipId.toBytes()))
          )
            return 'e2ee_key_sender_ineligible';
          const epoch = state.epoch.number;
          const installed = yield* Effect.result(Context.get(ctx, InstalledEpochKeys).check(epoch));
          if (Result.isFailure(installed)) return 'e2ee_key_unavailable';
          const genesis = toHex(prepared.binding.genesis.toBytes());
          const remote = yield* Effect.result(
            Context.get(ctx, KeyMailbox).status({ genesis, epoch, recipient })
          );
          if (Result.isFailure(remote)) return 'e2ee_key_status_unavailable';
          const slot = remote.success;
          if (slot.genesis !== genesis || slot.epoch !== epoch || slot.recipient !== recipient)
            return 'e2ee_key_recipient_ineligible';
          if (slot.status === 'EnvelopeStored' || slot.status === 'InstallationReported')
            return 'delivered';
          if (slot.status === 'NeedsEnvelope') return 'e2ee_key_not_sent';
          if (slot.status === 'Obsolete') return 'e2ee_key_epoch_changed';
          return 'e2ee_key_recipient_ineligible';
        })
      );
    const readKey = (epoch: number) =>
      Effect.gen(function* () {
        const ctx = yield* keys();
        yield* admitted();
        // The binding's acquireUseRelease takes ownership immediately; no fallible host check may strand this opaque key.
        return yield* Context.get(ctx, InstalledEpochHistory).read(epoch);
      });
    const status = () =>
      withKeys((ctx) =>
        Effect.gen(function* () {
          const view = yield* admitted(),
            state = view.inspectState();
          const installed = Context.get(ctx, InstalledEpochKeys);
          let usableEpoch: number | null = null;
          for (let epoch = state.epoch.number; epoch >= 0; epoch--) {
            const packet = epochHistoryPacket(view, epoch);
            if (Result.isFailure(packet) || packet.success.abandoned) continue;
            const checked = yield* Effect.result(installed.check(epoch));
            if (Result.isSuccess(checked)) {
              usableEpoch = epoch;
              break;
            }
            if (checked.failure.reason === 'closed' || checked.failure.reason === 'rollback')
              return yield* checked.failure;
          }
          yield* admitted();
          return Object.freeze({
            currentEpoch: state.epoch.number,
            usableEpoch,
            rotationRequired: state.epoch.rotationRequired,
          });
        })
      );
    type Document = Effect.Success<ReturnType<typeof makeStreamsUpdateBinding>>;
    const documents = new Map<string, Document>(),
      documentSerial = yield* Semaphore.make(1);
    const documentBinding = (
      resource: string,
      model: 'loro' | 'flock',
      epoch: number | 'current'
    ) =>
      documentSerial.withPermit(
        Effect.gen(function* () {
          yield* admitted();
          const id = JSON.stringify([resource, model, epoch]);
          const retained = documents.get(id);
          if (retained) return retained;
          const binding = yield* Scope.provide(
            makeStreamsUpdateBinding({
              genesis: prepared.binding.genesis,
              resource,
              model,
              writeEpoch: 'current',
              signer: device,
              ledger: () =>
                admitted().pipe(
                  Effect.flatMap((view) =>
                    epoch !== 'current' && epoch > view.inspectState().epoch.number
                      ? Effect.fail(fail('keys-unavailable'))
                      : Effect.succeed(view)
                  )
                ),
              readEpochKey: readKey,
            }).pipe(Effect.provideService(VerifiedLedger, verified)),
            owner
          );
          documents.set(id, binding);
          return binding;
        })
      );
    const document = Effect.fnUntraced(function* (
      resource: string,
      model: 'loro' | 'flock',
      epoch: number | 'current' = 'current'
    ) {
      const original = yield* documentBinding(resource, model, epoch);
      return Object.freeze({
        seal: (input: Parameters<typeof original.seal>[0]) => run(original.seal(input)),
        open: (input: Parameters<typeof original.open>[0]) =>
          run(original.open(input), (plaintext) => plaintext.fill(0)),
        openAuthenticated: (input: Parameters<typeof original.openAuthenticated>[0]) =>
          run(original.openAuthenticated(input), (opened) => opened.plaintext.fill(0)),
      });
    });
    let irohEndpoint: PersonalIrohEndpoint | undefined;
    const irohSerial = yield* Semaphore.make(1);
    const irohWarming = new Set<string>();
    // Opens once per session: the seed copy goes to the native opener only and is
    // wiped when it settles. The endpoint closes with the session owner.
    const irohOwner = () =>
      irohSerial.withPermit(
        Effect.gen(function* () {
          yield* admitted();
          if (irohEndpoint) return irohEndpoint;
          const port = platform.iroh;
          if (!port || !platform.rpc) return yield* fail('unsupported');
          // Acquisition and its close registration are one uninterruptible step:
          // an endpoint that settles after the session starts closing still closes.
          const opened = yield* Scope.provide(
            Effect.acquireRelease(
              device.withTransportSeed((seed) => port.open(seed)),
              (endpoint) => Effect.promise(() => endpoint.close().catch(() => undefined))
            ),
            owner
          );
          irohEndpoint = opened;
          return opened;
        })
      );
    let rpc: ReturnType<typeof makeE2eeRpcClient> | undefined;
    const rpcSerial = yield* Semaphore.make(1);
    const rpcOwner = () =>
      rpcSerial.withPermit(
        Effect.gen(function* () {
          yield* admitted();
          if (rpc) return rpc;
          if (!platform.rpc) return yield* fail('unsupported');
          const ctx = yield* Scope.provide(
              Layer.build(platform.rpc(prepared.binding).pipe(Layer.provide(identity))),
              owner
            ),
            store = Context.get(ctx, ClientRpcOriginalStore);
          rpc = makeE2eeRpcClient({
            workspaceId: prepared.binding.workspaceId,
            requesterDevice: toHex(device.publicKey.toBytes()),
            originals: store,
            ledger: admitted,
            signIntent: (request) =>
              signExecutionIntent({
                ...request,
                genesis: prepared.binding.genesis,
                signer: device,
              }).pipe(Effect.map((signature) => signature.toBytes())),
            binding: (resource) =>
              makeRealtimeContentBinding({
                genesis: prepared.binding.genesis,
                resource,
                signer: device,
                ledger: admitted,
                readEpochKey: readKey,
              }),
          });
          yield* Scope.provide(
            Effect.addFinalizer(() => rpc!.close().pipe(Effect.orDie)),
            owner
          );
          return rpc;
        })
      );
    const management = (command: LedgerCommand) =>
      serial.withPermit(
        Effect.gen(function* () {
          yield* admitted();
          // An occupied journal must be explicitly resumed/ACKed, never converted to another user intent.
          return yield* control.execute(command);
        })
      );
    let sharing: PersonalMachineSharing['Service'] | undefined;
    const sharingSerial = yield* Semaphore.make(1);
    const sharingOwner = () =>
      sharingSerial.withPermit(
        Effect.gen(function* () {
          yield* admitted();
          if (sharing) return sharing;
          if (!platform.machineSharing) return yield* fail('unsupported');
          const ctx = yield* keys();
          const built = yield* Scope.provide(
            Layer.build(
              platform.machineSharing(prepared.binding, credential).pipe(
                Layer.provide(
                  Layer.mergeAll(
                    identity,
                    Layer.succeed(LedgerViewSource, {
                      current: () =>
                        admitted().pipe(
                          Effect.mapError((cause) => new LedgerViewSourceError({ cause }))
                        ),
                    }),
                    Layer.succeed(InstalledEpochHistory, Context.get(ctx, InstalledEpochHistory))
                  )
                )
              )
            ),
            owner
          );
          sharing = Context.get(built, PersonalMachineSharing);
          return sharing;
        })
      );
    const managementState = () =>
      Effect.gen(function* () {
        const view = yield* ledger(),
          state = view.inspectState(),
          self = state.devices.get(toHex(device.publicKey.toBytes()));
        const member = self && state.members.get(toHex(self.membershipId.toBytes()));
        const pending = yield* Effect.result(
          Effect.gen(function* () {
            const ctx = yield* keys();
            return (
              !!(yield* Context.get(ctx, EpochCandidateStore).active()) ||
              !!(yield* submission.pending()).record
            );
          })
        );
        return {
          epoch: state.epoch.number,
          rotationRequired: state.epoch.rotationRequired,
          mayRotate:
            self?.kind === 'personal' && (member?.role === 'owner' || member?.role === 'admin'),
          updatePending: Result.isFailure(pending) || pending.success,
          ...(Result.isFailure(pending) ? { recoveryIssue: 'candidate-unavailable' as const } : {}),
          devices: [...state.devices].map(([key, entry]) => ({
            key,
            kind: entry.kind,
            cryptoUserId: toHex(
              state.members.get(toHex(entry.membershipId.toBytes()))!.userId.toBytes()
            ),
            recoveryDeviceAvailable: [...state.devices.values()].some(
              (other) => other.kind === 'recovery' && other.membershipId.equals(entry.membershipId)
            ),
            requiresRecoveryConfirmation:
              entry.kind === 'personal' &&
              ![...state.devices.entries()].some(
                ([otherKey, other]) =>
                  otherKey !== key &&
                  other.kind === 'personal' &&
                  other.membershipId.equals(entry.membershipId)
              ),
            machineId: entry.machineId ?? null,
            self: key === toHex(device.publicKey.toBytes()),
            mayRevoke: Result.isSuccess(
              prepareLedgerCommand(view, device.publicKey, {
                _tag: 'RevokeDevice',
                target: Result.getOrThrow(
                  Bytes.signingPublicKey(Uint8Array.from(key.match(/../g)!, (b) => parseInt(b, 16)))
                ),
              })
            ),
          })),
        };
      });
    /** The admitted personal device a record from this signer admits, if the current
     * verified ledger already contains it. Signing keys are never admitted twice. */
    const ownAdmission = (record: Uint8Array) =>
      Effect.gen(function* () {
        const signed = yield* Effect.fromResult(decodeRecord(new Uint8Array(record)));
        if (
          signed.body.type !== 'ordinary' ||
          signed.body.operation.type !== 'admitDevice' ||
          signed.body.operation.kind !== 'personal' ||
          !signed.body.signer.equals(device.publicKey)
        )
          return yield* fail('invalid-input');
        const view = yield* admitted();
        const admittedDevice = view
          .inspectState()
          .devices.get(toHex(signed.body.operation.signingPublicKey.toBytes()));
        return { view, signed: signed.body, admittedDevice };
      });
    // Account pairing, approver side. The shared workflow journals each original and
    // never asks for a second signature over one request.
    const accountApproval = {
      /** Signs one personal `AdmitDevice` against the current verified ledger. No network. */
      sign: (row: {
        signingPublicKey: Uint8Array;
        encryptionPublicKey: Uint8Array;
        possessionProof: Uint8Array;
      }) =>
        run(
          serial.withPermit(
            Effect.gen(function* () {
              const view = yield* admitted();
              const proposal = yield* Effect.fromResult(
                prepareLedgerCommand(view, device.publicKey, {
                  _tag: 'AdmitDevice',
                  kind: 'personal',
                  signingPublicKey: yield* Effect.fromResult(
                    Bytes.signingPublicKey(row.signingPublicKey)
                  ),
                  encryptionPublicKey: yield* Effect.fromResult(
                    Bytes.encryptionPublicKey(row.encryptionPublicKey)
                  ),
                  possessionSignature: yield* Effect.fromResult(
                    Bytes.signature(row.possessionProof)
                  ),
                })
              );
              return {
                requestId: `account-device-${globalThis.crypto.randomUUID()}`,
                record: yield* signLedgerRecord(proposal, device),
              };
            })
          )
        ),
      /** Where a signed original stands after a refresh: in the verified ledger,
       * displaced (its parent is no longer the head and its device is absent), or
       * not yet decided. */
      settle: (record: Uint8Array) =>
        run(
          serial.withPermit(
            Effect.gen(function* () {
              yield* control.refresh();
              const { view, signed, admittedDevice } = yield* ownAdmission(record);
              if (admittedDevice) return 'committed' as const;
              return signed.previousHash.equals(view.head)
                ? ('unknown' as const)
                : ('lost' as const);
            })
          )
        ),
      /** A signed snapshot invitation for an admission this device signed, once the
       * verified ledger contains it; `null` for a Member, which cannot endorse one. */
      invitation: (record: Uint8Array) =>
        run(
          Effect.gen(function* () {
            const { view, admittedDevice } = yield* ownAdmission(record);
            if (!admittedDevice) return yield* fail('conflict');
            const state = view.inspectState(),
              own = state.devices.get(toHex(device.publicKey.toBytes()));
            const role = own && state.members.get(toHex(own.membershipId.toBytes()))?.role;
            if (role !== 'owner' && role !== 'admin') return null;
            // One feed position for both the snapshot and the offset it continues from.
            const feed = yield* sync.current();
            const snapshot = yield* signLedgerSnapshot({
              signer: device,
              ledger: () => Effect.succeed(feed.view),
            });
            const receipt = {
              workspaceId: prepared.binding.workspaceId,
              snapshot: snapshot.snapshot,
              head: snapshot.head,
              length: snapshot.length,
              headSignature: snapshot.headSignature,
              offset: feed.offset,
            };
            yield* Effect.fromResult(
              verifyWorkspaceInvitationSnapshot(
                {
                  workspaceId: prepared.binding.workspaceId,
                  genesis: prepared.binding.genesis,
                  endorser: device.publicKey,
                },
                receipt
              )
            );
            return fromHex(encodePersonalInvitation(receipt));
          })
        ),
      /** Device access for the account pairing relay and its admission append. It
       * stays inside the host's account-pairing composition. */
      access: () =>
        run(
          admitted().pipe(
            Effect.as({ workspaceId: prepared.binding.workspaceId, credential: toHex(credential) })
          )
        ),
    };
    // Member invitations, admin side. This session's credential authenticates the relay and
    // never leaves it. Each listed key package is pinned on first sight, so approval signs
    // exactly the applicant that was shown and a later reply cannot swap it.
    const memberPreviews = new Map<string, string>();
    const memberAccess = () => ({
      workspaceId: prepared.binding.workspaceId,
      credential: toHex(credential),
    });
    const membersPort = () =>
      platform.members ? Effect.succeed(platform.members) : Effect.fail(fail('unsupported'));
    const memberProof = (keyPackageHex: string) =>
      Effect.gen(function* () {
        const proof = yield* Effect.try({
          try: () => decodeMemberKeyPackage(keyPackageHex),
          catch: (cause) => fail('invalid-input', cause),
        });
        yield* Effect.fromResult(
          verifyDeviceCredentialBinding(
            {
              genesis: prepared.binding.genesis,
              pairingSessionId: proof.request.requestId.toBytes(),
              signingPublicKey: proof.request.signingPublicKey,
              credentialHash: fromHex(proof.credentialHash),
            },
            fromHex(proof.bindingSignature)
          )
        ).pipe(Effect.mapError((cause) => fail('invalid-input', cause)));
        return proof;
      });
    const admitMember = (request: import('@lody/e2ee-core/protocol').JoinRequest) =>
      ({
        _tag: 'AdmitMember',
        membershipId: Result.getOrThrow(Bytes.membershipId(request.requestId.toBytes())),
        request,
      }) as const;
    const members = {
      /** A new invitation endorsed by this device; owner or admin personal devices only. */
      invite: (mode: 'email' | 'link', email?: string) =>
        run(
          Effect.gen(function* () {
            const port = yield* membersPort();
            const view = yield* admitted(),
              state = view.inspectState(),
              own = state.devices.get(toHex(device.publicKey.toBytes()));
            const role = own && state.members.get(toHex(own.membershipId.toBytes()))?.role;
            if (own?.kind !== 'personal' || (role !== 'owner' && role !== 'admin'))
              return yield* fail('unauthorized');
            const token = globalThis.crypto.getRandomValues(new Uint8Array(32));
            // The endorsement signature is what lets another approver recognise this
            // invitation; a relay-written label never can.
            const offer = yield* signMemberOffer(
              {
                version: 1 as const,
                workspaceId: prepared.binding.workspaceId,
                genesisHash: toHex(prepared.binding.genesis.toBytes()),
                genesisRecordHex: prepared.offer.genesisRecordHex,
                endorser: toHex(device.publicKey.toBytes()),
                token: toHex(token),
                mode,
                expiresAt: (yield* Clock.currentTimeMillis) + 48 * 60 * 60 * 1000,
              },
              device
            );
            const result = yield* port.createInvitation(memberAccess(), {
              offer,
              ...(email === undefined ? {} : { email }),
            });
            // Inviting an email that already has a pending invitation re-sends that one, so
            // the relay answers with it instead of this new offer. Accept it only with this
            // workspace's own genesis pins; it never grants anything by itself.
            const resent =
              mode === 'email' &&
              result.offer.mode === 'email' &&
              result.offer.genesisRecordHex === offer.genesisRecordHex;
            if (
              result.offer.workspaceId !== offer.workspaceId ||
              result.offer.genesisHash !== offer.genesisHash ||
              (result.offer.token !== offer.token && !resent)
            )
              return yield* fail('conflict');
            return result.offer;
          })
        ),
      /** Waiting applicants this device can admit. A malformed, stale or swapped package is
       * left out without hiding the others. */
      pending: () =>
        run(
          Effect.gen(function* () {
            const port = yield* membersPort();
            yield* admitted();
            const result = yield* port.pending(memberAccess());
            const items: typeof result.items = [];
            for (const item of result.items) {
              if (item.workspaceId !== prepared.binding.workspaceId) return yield* fail('conflict');
              const checked = yield* Effect.result(
                Effect.gen(function* () {
                  const proof = yield* memberProof(item.keyPackageHex);
                  const view = yield* admitted();
                  if (
                    !view
                      .inspectState()
                      .devices.has(toHex(proof.request.signingPublicKey.toBytes()))
                  )
                    yield* Effect.fromResult(
                      prepareLedgerCommand(view, device.publicKey, admitMember(proof.request))
                    );
                  // The listed id must be the signed request's own id: the pin is keyed by
                  // the id an approval names, so no listed entry can stand for another.
                  const id = toHex(proof.request.requestId.toBytes());
                  if (item.requestId !== id) return yield* fail('conflict');
                  const pinned = memberPreviews.get(id);
                  if (pinned !== undefined && pinned !== item.keyPackageHex)
                    return yield* fail('conflict');
                  memberPreviews.set(id, item.keyPackageHex);
                })
              );
              if (Result.isSuccess(checked)) items.push(item);
            }
            return { ...result, items };
          })
        ),
      /** The ledger command admitting this listed request, or null when the verified ledger
       * already admits exactly this device. Automatic mode admits only an applicant whose
       * signed email invitation this client verifies (`verifyAutomaticMemberAdmission`). */
      admission: (requestId: string, mode: 'automatic' | 'explicit') =>
        run(
          Effect.gen(function* () {
            const port = yield* membersPort();
            const material = yield* port.read(memberAccess(), requestId);
            if (
              material.workspaceId !== prepared.binding.workspaceId ||
              material.requestId !== requestId
            )
              return yield* fail('conflict');
            const proof = yield* memberProof(material.keyPackageHex);
            // The signed request's own id must be the approved id.
            if (toHex(proof.request.requestId.toBytes()) !== requestId)
              return yield* fail('conflict');
            const state = (yield* admitted()).inspectState();
            const existing = state.devices.get(toHex(proof.request.signingPublicKey.toBytes()));
            if (existing) {
              const member = state.members.get(toHex(existing.membershipId.toBytes()));
              if (
                !member?.userId.equals(proof.request.userId) ||
                !existing.encryptionPublicKey.equals(proof.request.encryptionPublicKey)
              )
                return yield* fail('conflict');
              return null;
            }
            // Unattended admission only for an invitation this client can verify: signed by a
            // currently eligible endorser, email-mode, unexpired and not used before. Anything
            // else stays pending for an explicit approval.
            if (mode === 'automatic') {
              const checked = verifyAutomaticMemberAdmission({
                view: yield* admitted(),
                workspaceId: prepared.binding.workspaceId,
                approver: device.publicKey,
                offer: material.offer,
                request: proof.request,
                now: yield* Clock.currentTimeMillis,
              });
              // The precise refusal is the product code, so the request shows why it needs
              // an explicit approval; nothing is signed and nothing is retried here.
              if (Result.isFailure(checked)) return yield* fail(checked.failure);
            }
            // Only the package this session listed and showed for this very request may be signed.
            if (memberPreviews.get(requestId) !== material.keyPackageHex)
              return yield* fail('conflict');
            return admitMember(proof.request);
          })
        ),
      read: (requestId: string) =>
        run(Effect.flatMap(membersPort(), (port) => port.read(memberAccess(), requestId))),
      reject: (requestId: string) =>
        run(Effect.flatMap(membersPort(), (port) => port.reject(memberAccess(), requestId))),
      revoke: (token: string) =>
        run(Effect.flatMap(membersPort(), (port) => port.revoke(memberAccess(), token))),
    };
    if (recovered.length) {
      yield* withKeys((ctx) =>
        Effect.forEach(
          recovered,
          ([epoch, key]) => Context.get(ctx, InstalledEpochKeys).saveAndReload(epoch, key),
          { discard: true }
        )
      );
    }
    return Object.freeze({
      binding: Object.freeze({ ...prepared.binding }),
      accountApproval: Object.freeze(accountApproval),
      members: Object.freeze(members),
      /** Set up this workspace's recovery without exposing its signer or epoch keys. */
      setupRecovery: (input: PersonalRecoverySetupInput) =>
        run(
          serial.withPermit(
            withKeys((ctx) =>
              Effect.gen(function* () {
                yield* control.refresh();
                const view = yield* admitted();
                const workflow = yield* makeWorkspaceRecovery({
                  vault: input.vault,
                  local: input.local,
                  genesis: prepared.binding.genesis,
                  membershipId: Result.getOrThrow(
                    Bytes.membershipId(fromHex(prepared.offer.membershipId))
                  ),
                  personalSigner: device,
                  ledger: admitted,
                  installed: Context.get(ctx, InstalledEpochKeys),
                  trust: {
                    source: 'personal-device',
                    genesisRecord: fromHex(prepared.offer.genesisRecordHex),
                    head: toHex(view.head.toBytes()),
                    length: view.length,
                  },
                  submitOriginal: (record, registration) =>
                    input
                      .submitOriginal(record, registration)
                      .pipe(Effect.tap(() => control.refresh())),
                  fetchCurrentEnvelope: (...args) =>
                    Effect.gen(function* () {
                      // A failed independent receive/repair must not hide an already delivered R envelope.
                      yield* Effect.exit(
                        Effect.gen(function* () {
                          const latest = yield* admitted();
                          return yield* maintenance!(latest.inspectState().epoch.number);
                        })
                      );
                      return yield* input.fetchCurrentEnvelope(...args);
                    }),
                });
                const result = yield* workflow.setup();
                return { outcome: result.outcome, recoverable: result.status.recoverable };
              }).pipe(Effect.scoped)
            )
          )
        ),
      close: () => close,
      ledgerState: () =>
        run(
          Effect.gen(function* () {
            yield* ledger();
            const current = yield* sync.current();
            yield* Effect.fromResult(requireLedgerContinuation(approval.view, current.view));
            return current;
          })
        ),
      contentToken: (
        grantRequest: Omit<
          import('@lody/cloud-api').E2eeContentTokenRequest,
          'workspaceId' | 'credential' | 'cliToken'
        >
      ) =>
        run(
          Effect.gen(function* () {
            yield* admitted();
            if (!platform.contentToken) return yield* fail('unsupported');
            const result = yield* platform.contentToken(prepared.binding, credential, grantRequest);
            yield* admitted();
            return result;
          })
        ),
      managementState: () => run(managementState()),
      readMachineSharing: (machineId: string) =>
        run(
          Effect.gen(function* () {
            yield* control.refresh();
            yield* admitted();
            const result = yield* (yield* sharingOwner()).read(machineId);
            yield* admitted();
            return result;
          })
        ),
      updateMachineSharing: (
        machineId: string,
        generation: string,
        requestId: string,
        change: import('@lody/platform').E2eeMachineSharingChange
      ) =>
        run(
          Effect.gen(function* () {
            yield* control.refresh();
            yield* admitted();
            const result = yield* (yield* sharingOwner()).update(
              machineId,
              generation,
              requestId,
              change
            );
            yield* admitted();
            return result;
          })
        ),
      ledger: () => run(ledger()),
      /** Public signed proof already verified and retained for this approval. */
      approvalOriginals: () =>
        run(
          Effect.sync(() =>
            approval.kind === 'history'
              ? approval.pages.flatMap((page) => page.recordsHex.map(fromHex))
              : []
          )
        ),
      refresh: (timeoutMs?: number) => {
        const refresh = serial.withPermit(control.refresh().pipe(Effect.andThen(ledger())));
        return run(timeoutMs === undefined ? refresh : refresh.pipe(Effect.timeout(timeoutMs)));
      },
      keyRound: () => run(keyRound()),
      keyDeliveryEvidence: (recipient: string) => run(keyDeliveryEvidence(recipient)),
      status: () => run(status()),
      document: (
        resource: string,
        model: 'loro' | 'flock',
        writeEpoch: number | 'current' = 'current'
      ) => run(document(resource, model, writeEpoch)),
      execute: (command: LedgerCommand) => run(management(command)),
      resume: () =>
        run(
          serial.withPermit(
            admitted().pipe(Effect.andThen(ownSubmission), Effect.andThen(control.resume()))
          )
        ),
      acknowledge: (result: Parameters<typeof control.acknowledge>[0]) =>
        run(
          serial.withPermit(
            ownRecord(result.record).pipe(Effect.andThen(control.acknowledge(result)))
          )
        ),
      removeMember: (membership: import('@lody/e2ee-core/protocol').Bytes.MembershipId) =>
        run(
          serial.withPermit(
            ownSubmission.pipe(
              Effect.andThen(
                withKeys((ctx) => Context.get(ctx, EpochPublisher).publishRemoving(membership))
              )
            )
          )
        ),
      abandonEpoch: (baseEpoch: number) =>
        run(
          serial.withPermit(
            ownSubmission.pipe(
              Effect.andThen(
                withKeys((ctx) => Context.get(ctx, EpochPublisher).publishAbandoning(baseEpoch))
              )
            )
          )
        ),
      rotate: () =>
        run(
          serial.withPermit(
            ownSubmission.pipe(
              Effect.andThen(withKeys((ctx) => Context.get(ctx, EpochPublisher).publish()))
            )
          )
        ),
      recoverHistory: () =>
        run(withKeys((ctx) => Context.get(ctx, InstalledEpochHistory).recover())),
      resumeRotation: () =>
        run(
          serial.withPermit(
            ownSubmission.pipe(
              Effect.andThen(withKeys((ctx) => Context.get(ctx, EpochPublisher).resume()))
            )
          )
        ),
      acknowledgeRotation: (result: Parameters<EpochPublisher['Service']['acknowledge']>[0]) =>
        run(
          serial.withPermit(
            ownSubmission.pipe(
              Effect.andThen(
                withKeys((ctx) => Context.get(ctx, EpochPublisher).acknowledge(result))
              )
            )
          )
        ),
      prepareDispatch: (
        ...args: Parameters<ReturnType<typeof makeE2eeRpcClient>['prepareDispatch']>
      ) => run(Effect.flatMap(rpcOwner(), (r) => r.prepareDispatch(...args))),
      /** Sign one schedule declaration with this admitted device. The host computes the
       * definition fingerprint from the document; callers never supply a digest. */
      signScheduleDeclaration: (
        document: Pick<ScheduleDocument, 'definition' | 'prompt' | 'message'>,
        manualRunKey?: string
      ) =>
        run(
          Effect.gen(function* () {
            yield* admitted();
            const subject = yield* Effect.try({
              try: () => scheduleDeclarationSubject(document, manualRunKey),
              catch: () => fail('invalid-input'),
            });
            const signature = yield* signExecutionIntent({
              ...subject,
              genesis: prepared.binding.genesis,
              workspaceId: prepared.binding.workspaceId,
              contentDigest: fromHex(subject.contentDigest),
              signer: device,
            });
            return encodeE2eeIntentRecord({
              kind: subject.kind,
              signer: device.publicKey.toBytes(),
              signature: signature.toBytes(),
            });
          })
        ),
      acceptResponse: (
        ...args: Parameters<ReturnType<typeof makeE2eeRpcClient>['acceptResponse']>
      ) => run(Effect.flatMap(rpcOwner(), (r) => r.acceptResponse(...args))),
      prepareFeature: (
        input: Parameters<ReturnType<typeof makeE2eeRpcClient>['prepareFeature']>[0]
      ) => run(Effect.flatMap(rpcOwner(), (r) => r.prepareFeature(input))),
      acceptFeatureResponse: (
        ...args: Parameters<ReturnType<typeof makeE2eeRpcClient>['acceptFeatureResponse']>
      ) => run(Effect.flatMap(rpcOwner(), (r) => r.acceptFeatureResponse(...args))),
      /** Resolves the machine's route from the admitted ledger; callers run the
       * returned route's network waits outside every session lock. */
      irohPath: (machineId: string) =>
        run(
          Effect.gen(function* () {
            const key = irohTargetDevice(yield* admitted(), machineId);
            if (!key || !irohEndpoint) return undefined;
            return makePersonalIrohRoute(irohEndpoint, key, irohWarming);
          })
        ),
      irohRoute: (machineId: string) =>
        run(
          Effect.gen(function* () {
            const key = irohTargetDevice(yield* admitted(), machineId);
            if (!key) return yield* fail('unsupported');
            return makePersonalIrohRoute(yield* irohOwner(), key, irohWarming);
          })
        ),
    });
  });
  return yield* Scope.provide(work, owner).pipe(
    Effect.onExit((exit) => (Exit.isFailure(exit) ? close : Effect.void))
  );
});
