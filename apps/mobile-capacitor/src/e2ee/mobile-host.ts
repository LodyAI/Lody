import { Context, Effect, Layer } from 'effect';
import {
  personalCloudHostPorts,
  personalCloudDatabases,
  portableCreation,
  makePersonalAccountPairingStore,
  makePersonalCloudAccountPairingPorts,
  type PersonalCloudConnection,
  personalEntry,
  personalEntryPins,
  type PersonalEntryOptions,
} from '@lody/client-e2ee';
import { ClientCustodyError, LedgerFeedStore, WorkspaceScope } from '@lody/e2ee-core/services';
import { indexedDbClientStores } from '@lody/e2ee-core/adapters/indexeddb';
import { verifyPersonalOffer } from '@lody/e2ee-client';
import type {
  E2eeRuntimeFactory,
  E2eeWorkspacePrepareInput,
  PlatformSessionState,
  ReadonlyStore,
} from '@lody/platform';
import { nativeCustody, type NativeKekBridge } from './native-custody';
import { nativeKekBridge } from './native-bridge';
import { nativeIrohPort } from './iroh-bridge';

const fail = (reason: ClientCustodyError['reason']) => new ClientCustodyError({ reason });

/** Native app composition; never activates WebCrypto custody or node:sqlite. */
export function mobilePersonalHost(
  client: PersonalCloudConnection['client'],
  run: PersonalEntryOptions['run'],
  plugin: NativeKekBridge | undefined = nativeKekBridge(),
  /** Owning tests only: inject the account-pairing key-delivery retry clock. */
  testing: {
    keyDeliveryRetry?: NonNullable<PersonalEntryOptions['accountPairing']>['keyDeliveryRetry'];
  } = {},
  iroh: ReturnType<typeof nativeIrohPort> = nativeIrohPort()
) {
  // The account of the latest runtime's login; the relay refuses while it is signed out.
  // The server still re-checks the account on every call.
  let accountSession: ReadonlyStore<PlatformSessionState> | undefined;
  const connection: PersonalCloudConnection = {
    client,
    currentAccount: () =>
      Effect.sync(() => {
        const state = accountSession?.get();
        return state?.status === 'authenticated' ? state.user.id : null;
      }),
  };
  const stores = new Map<string, ReturnType<typeof makePersonalAccountPairingStore>>();
  const pairingPorts = makePersonalCloudAccountPairingPorts(connection);
  const creations = new Map<string, ReturnType<typeof portableCreation>>();
  const pendingNames = new Map<string, string>();
  const workspaceNames = new Map<string, string>();
  const creationFor = (accountId: string) => {
    let creation = creations.get(accountId);
    if (!creation) {
      creation = portableCreation({
        accountId,
        namespace: 'mobile',
        protection: 'os-keystore',
        client,
        custody: (binding, databaseName) => {
          const bridge = plugin;
          if (!bridge) return Layer.effectContext(Effect.fail(fail('unavailable')));
          return nativeCustody({ binding, plugin: bridge, databaseName });
        },
      });
      creations.set(accountId, creation);
    }
    return creation;
  };
  const entry = personalEntry({
    run,
    ...(iroh ? { iroh: true } : {}),
    pins: personalEntryPins('lody-e2ee:mobile:v1:entry-pins'),
    ports: (input) => {
      const bridge = plugin;
      if (!bridge) return Layer.effectContext(Effect.fail(fail('unavailable')));
      return personalCloudHostPorts(
        { ...input, platformNamespace: 'mobile', client },
        {
          protection: 'os-keystore',
          ...(iroh ? { iroh } : {}),
          custody: (binding, candidateRequest) =>
            nativeCustody({
              binding,
              plugin: bridge,
              candidateRequest,
              databaseName: personalCloudDatabases(binding, 'mobile').custody + ':native-originals',
            }),
        }
      );
    },
    recordCreated: async (input) => {
      await creationFor(input.accountId).recordCreated(input);
      const name = input.requestId ? pendingNames.get(input.requestId) : undefined;
      if (name) workspaceNames.set(input.workspaceId, name);
    },
    accountPairing: {
      store: (accountId) => {
        let store = stores.get(accountId);
        if (!store) {
          store = makePersonalAccountPairingStore(accountId);
          stores.set(accountId, store);
        }
        return store;
      },
      relay: pairingPorts.relay,
      deviceName: 'Lody mobile',
      appendRecord: pairingPorts.appendRecord,
      historyBatch: pairingPorts.historyBatch,
      appendRecordsBatch: pairingPorts.appendRecordsBatch,
      workspaceName: (workspaceId) => workspaceNames.get(workspaceId) ?? null,
      // Without these the new phone has no workspace to request and never submits.
      requester: {
        workspaces: async () => {
          const listed = await pairingPorts.requester.workspaces();
          for (const workspace of listed) workspaceNames.set(workspace.workspaceId, workspace.name);
          return listed;
        },
        history: pairingPorts.requester.history,
        historyBatch: pairingPorts.requester.historyBatch,
      },
      ...(testing.keyDeliveryRetry ? { keyDeliveryRetry: testing.keyDeliveryRetry } : {}),
    },
    ledgerRecords: (accountId, offer) => (view) =>
      Effect.scoped(
        Effect.gen(function* () {
          const verified = yield* Effect.fromResult(verifyPersonalOffer(offer));
          const scope = { accountId, workspaceId: offer.workspaceId, genesis: verified.genesis };
          const storage = yield* Layer.build(
            indexedDbClientStores({
              databaseName: personalCloudDatabases(scope, 'mobile').ledger,
              accountId,
              workspaceId: offer.workspaceId,
              mode: 'open-existing',
            }).pipe(Layer.provide(Layer.succeed(WorkspaceScope, { genesis: scope.genesis })))
          );
          const contents = yield* Context.get(storage, LedgerFeedStore).load(16384);
          return (
            contents?.records
              .map((record, index) => ({ record, position: contents.originCount + index }))
              .filter((row) => row.position < view.length) ?? []
          );
        })
      ),
  });
  const createRuntime: E2eeRuntimeFactory = (input) => {
    accountSession = input.session;
    return entry.createRuntime(input);
  };
  return {
    ...entry,
    createRuntime,
    close: async () => {
      // An incomplete close keeps its pairing work, so the stores stay open with it.
      await entry.close();
      for (const store of stores.values()) store.close();
      stores.clear();
    },
    prepareCreation: async (input: E2eeWorkspacePrepareInput) => {
      const creation = creationFor(input.accountId);
      const prepared = await creation.prepare(input);
      pendingNames.set(input.requestId, input.name);
      return prepared;
    },
  };
}
