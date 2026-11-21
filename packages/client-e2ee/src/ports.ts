import { Context, Effect, Layer } from 'effect';
import {
  personalLedgerControl,
  PersonalHostPlatform,
  PersonalHostRemote,
  PersonalMachineSharing,
  verifyPersonalOffer,
  decodePersonalRequest,
  type PersonalPairingOffer,
  type PersonalHostPorts,
} from '@lody/e2ee-client';
import { InstalledEpochHistory } from '@lody/e2ee-core';
import { decodeRecord } from '@lody/e2ee-core/protocol';
import { makeLazyMachineSharingHost } from '@lody/e2ee-machine-sharing';
import { openIndexedDbMachineSharingStore } from '@lody/e2ee-machine-sharing/indexeddb';
import {
  ClientInstallationStore,
  ClientCustodyWriter,
  ClientPairingOriginalStore,
  LedgerFeedStore,
  LedgerPinStore,
  SubmissionJournal,
  LedgerFeedSource,
  LedgerLog,
  LedgerViewSource,
  DeviceIdentity,
  WorkspaceScope,
  KeyMailbox,
  EpochStagingStore,
  EpochPublicationSource,
  LocalStoreError,
  ClientCustodyError,
  type ClientCustodyScope,
  type ClientCustodyBinding,
} from '@lody/e2ee-core/services';
import {
  indexedDbClientStores,
  indexedDbClientInstallationStore,
  indexedDbClientKeyStores,
  indexedDbClientRpcOriginals,
  indexedDbClientApprovalEvidence,
} from '@lody/e2ee-core/adapters/indexeddb';
import { browserClientWriter } from '@lody/e2ee-core/adapters/browser-custody';
import { makePersonalCloudNetwork, hex, raw, type PersonalCloudConnection } from './network';

/** Stable, disjoint durable names, outside the ordinary replica/cursor cache families. */
export type PersonalCloudPlatformNamespace = 'web' | 'mobile';
export function personalCloudDatabases(
  scope: ClientCustodyScope,
  platformNamespace: PersonalCloudPlatformNamespace
) {
  if (platformNamespace !== 'web' && platformNamespace !== 'mobile')
    throw new ClientCustodyError({ reason: 'corrupt' });
  const root =
    `lody-e2ee:${platformNamespace}:v1:` +
    JSON.stringify([scope.accountId, scope.workspaceId, hex(scope.genesis.toBytes())]);
  return Object.freeze({
    ledger: root + ':ledger',
    custody: root + ':custody',
    submission: (binding: ClientCustodyBinding) => root + ':submission:' + binding.installationId,
    /** Policy pins and request originals of one installation; a replacement identity
     * never reads another incarnation's sharing state. */
    machineSharing: (binding: ClientCustodyBinding) =>
      root + ':machine-sharing:' + binding.installationId,
  });
}
export interface PersonalCloudHostOptions extends PersonalCloudConnection {
  /** Fixed by the platform wrapper; never a recovery, preference, or identity selector. */
  readonly platformNamespace: PersonalCloudPlatformNamespace;
  readonly accountId: string;
  /** Direct desktop transfer or retained exact original. A directory/describe label is not this pin. */
  readonly offer: PersonalPairingOffer;
  readonly mode: 'create-or-open' | 'open-existing';
  /** App-level owner must drain every other reader of this exact old binding. No no-op default. */
  readonly drainOld: (binding: ClientCustodyBinding) => Effect.Effect<void, unknown>;
}
/** Prepare resource-owning Layers only; no storage/crypto/network work until explicitly acquired by the application owner. */
export type PersonalCloudCustodyAdapter = Pick<
  PersonalHostPlatform['Service'],
  'protection' | 'custody' | 'iroh'
>;
export function personalCloudHostPorts(
  input: PersonalCloudHostOptions,
  adapters: PersonalCloudCustodyAdapter
): Layer.Layer<PersonalHostPorts, unknown> {
  const options = { ...input, offer: { ...input.offer } };
  const protection = adapters.protection;
  const custody = adapters.custody.bind(adapters);
  return Layer.effectContext(
    Effect.gen(function* () {
      const view = yield* Effect.fromResult(verifyPersonalOffer(options.offer));
      const scope = Object.freeze({
        accountId: options.accountId,
        workspaceId: options.offer.workspaceId,
        genesis: view.genesis,
      });
      if (!scope.accountId || (yield* options.currentAccount()) !== scope.accountId)
        return yield* new ClientCustodyError({ reason: 'unavailable' });
      const names = yield* Effect.try({
        try: () => personalCloudDatabases(scope, options.platformNamespace),
        catch: () => new ClientCustodyError({ reason: 'corrupt' }),
      });
      const ws = Layer.succeed(WorkspaceScope, { genesis: scope.genesis });
      const baseOptions = {
        databaseName: names.ledger,
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        mode: options.mode,
      };
      const storage = yield* Layer.build(
        Layer.mergeAll(
          indexedDbClientStores(baseOptions),
          indexedDbClientInstallationStore({ ...baseOptions, databaseName: names.custody }),
          browserClientWriter({ accountId: scope.accountId, workspaceId: scope.workspaceId })
        ).pipe(Layer.provide(ws))
      );
      const feed = Context.get(storage, LedgerFeedStore),
        pins = Context.get(storage, LedgerPinStore);
      const network = makePersonalCloudNetwork({
        scope,
        genesisRecordHex: options.offer.genesisRecordHex,
        client: options.client,
        currentAccount: options.currentAccount,
        replacement: (request) =>
          Effect.gen(function* () {
            // Select proof shape from the retained installation, never an authorization verdict.
            const previous = yield* Context.get(storage, ClientInstallationStore).read();
            const parsed = yield* Effect.try({
              try: () => decodePersonalRequest(request.requestHex),
              catch: () => new ClientCustodyError({ reason: 'corrupt' }),
            });
            return (
              previous !== null &&
              hex(previous.binding.device.toBytes()) !== parsed.signingPublicKey
            );
          }),
      });
      const matches = (b: ClientCustodyBinding) =>
        b.accountId === scope.accountId &&
        b.workspaceId === scope.workspaceId &&
        b.genesis.equals(scope.genesis);
      const guard = (b: ClientCustodyBinding): Effect.Effect<void, ClientCustodyError> =>
        matches(b) ? Effect.void : Effect.fail(new ClientCustodyError({ reason: 'corrupt' }));
      const platform = PersonalHostPlatform.of({
        scope,
        protection,
        // Native shells only; the port receives the seed once per session.
        ...(adapters.iroh ? { iroh: adapters.iroh } : {}),
        custody: (binding, candidateRequest) =>
          Layer.unwrap(guard(binding).pipe(Effect.map(() => custody(binding, candidateRequest)))),
        control: (binding, credential, approval) =>
          Layer.effectContext(
            Effect.gen(function* () {
              yield* guard(binding);
              const business = yield* Layer.build(
                indexedDbClientStores({
                  ...baseOptions,
                  databaseName: names.submission(binding),
                  // The approved incarnation may not have opened a session yet.
                  // Its submission partition is independent of custody creation.
                  mode: 'create-or-open',
                }).pipe(Layer.provide(ws))
              );
              const remote = network.ledger(hex(credential));
              return yield* Layer.build(
                personalLedgerControl({ approval }).pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      ws,
                      Layer.succeed(LedgerFeedStore, feed),
                      Layer.succeed(LedgerPinStore, pins),
                      Layer.succeed(SubmissionJournal, Context.get(business, SubmissionJournal)),
                      Layer.succeed(LedgerFeedSource, remote.source),
                      Layer.succeed(LedgerLog, remote.log)
                    )
                  )
                )
              );
            })
          ),
        keys: (binding, credential) =>
          Layer.unwrap(
            guard(binding).pipe(
              Effect.map(() => {
                const credentialHex = hex(credential);
                return Layer.mergeAll(
                  indexedDbClientKeyStores({
                    databaseName: names.custody,
                    binding,
                    mode: options.mode,
                  }),
                  Layer.succeed(KeyMailbox, network.mailbox(credentialHex)),
                  Layer.succeed(EpochStagingStore, network.staging(credentialHex)),
                  Layer.succeed(EpochPublicationSource, {
                    current: (verified) =>
                      Effect.gen(function* () {
                        if (!verified.genesis.equals(scope.genesis))
                          return yield* new LocalStoreError({
                            store: 'EpochPublicationSource',
                            reason: 'corrupt',
                          });
                        const epoch = verified.inspectState().epoch.number;
                        if (epoch === 0) return raw(options.offer.genesisRecordHex);
                        const stored = yield* feed.load(16384);
                        if (!stored) return null;
                        for (let i = stored.records.length - 1; i >= 0; i--) {
                          if (stored.originCount + i >= verified.length) continue;
                          const parsed = yield* Effect.fromResult(
                            decodeRecord(stored.records[i])
                          ).pipe(
                            Effect.mapError(
                              () =>
                                new LocalStoreError({
                                  store: 'EpochPublicationSource',
                                  reason: 'corrupt',
                                })
                            )
                          );
                          if (
                            parsed.body.type === 'ordinary' &&
                            (parsed.body.operation.type === 'publishEpoch' ||
                              parsed.body.operation.type === 'removeMemberAndPublishEpoch') &&
                            parsed.body.operation.epoch === epoch
                          )
                            return new Uint8Array(stored.records[i]);
                        }
                        return null;
                      }),
                  })
                );
              })
            )
          ),
        evidence: (binding) =>
          Layer.unwrap(
            guard(binding).pipe(
              Effect.as(
                indexedDbClientApprovalEvidence({
                  databaseName: names.custody,
                  binding,
                  mode: options.mode,
                })
              )
            )
          ),
        rpc: (binding) =>
          Layer.unwrap(
            guard(binding).pipe(
              Effect.as(
                indexedDbClientRpcOriginals({
                  databaseName: names.custody,
                  binding,
                  mode: options.mode,
                })
              )
            )
          ),
        contentToken: (binding, credential, request) =>
          guard(binding).pipe(Effect.andThen(network.contentToken(hex(credential), request))),
        members: network.members,
        // The shared machine-sharing host: core verifies policy signatures, pins and
        // generations exactly as on desktop; this host supplies only IndexedDB storage,
        // the device-authenticated transport and its own local ledger originals.
        machineSharing: (binding, credential) =>
          Layer.effect(
            PersonalMachineSharing,
            Effect.gen(function* () {
              yield* guard(binding);
              const device = yield* DeviceIdentity;
              if (!device.signer.publicKey.equals(binding.device))
                return yield* new ClientCustodyError({ reason: 'corrupt' });
              const ledger = yield* LedgerViewSource;
              const history = yield* InstalledEpochHistory;
              const remote = network.machineSharing;
              const host = yield* makeLazyMachineSharingHost({
                store: openIndexedDbMachineSharingStore(names.machineSharing(binding)),
                workspaceId: scope.workspaceId,
                genesisHash: hex(scope.genesis.toBytes()),
                signer: device.signer,
                ledger: () => ledger.current(),
                // Local originals only; core authenticates every position against the
                // verified view. A missing admission refuses sharing, never execution.
                admissionHistory: (view) =>
                  Effect.map(
                    feed.load(16384),
                    (stored) =>
                      stored?.records
                        .map((record, index) => ({
                          record: new Uint8Array(record),
                          length: stored.originCount + index + 1,
                        }))
                        .filter((row) => row.length <= view.length) ?? []
                  ),
                readEpochKey: (epoch) => history.read(epoch),
                // The session refreshes its verified ledger before every read and update.
                refreshLedger: () => Effect.void,
                credential: hex(credential),
              });
              return PersonalMachineSharing.of({
                read: (machineId) => host.read(machineId, remote),
                update: (machineId, generation, requestId, change) =>
                  host.write(machineId, generation, requestId, change, remote),
              });
            })
          ),
        drainOld: (binding) => guard(binding).pipe(Effect.andThen(options.drainOld(binding))),
      });
      return Context.make(
        ClientInstallationStore,
        Context.get(storage, ClientInstallationStore)
      ).pipe(
        Context.add(ClientCustodyWriter, Context.get(storage, ClientCustodyWriter)),
        Context.add(ClientPairingOriginalStore, Context.get(storage, ClientPairingOriginalStore)),
        Context.add(PersonalHostPlatform, platform),
        Context.add(PersonalHostRemote, network.remote)
      );
    })
  );
}
