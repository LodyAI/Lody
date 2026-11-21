import { Context, Effect, Layer, Result } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import { importBrowserDevice, type BrowserDevice } from '@lody/e2ee-core/adapters/browser-crypto';
import {
  accountUserId,
  Bytes,
  commitEpochKey,
  prepareDeviceAdmission,
  signDeviceCredentialBinding,
  signGenesisRecord,
} from '@lody/e2ee-core/protocol';
import { browserClientWriter } from '@lody/e2ee-core/adapters/browser-custody';
import {
  indexedDbClientInstallationStore,
  indexedDbClientKeyStores,
  indexedDbClientStores,
} from '@lody/e2ee-core/adapters/indexeddb';
import {
  ClientCustodyWriter,
  ClientInstallationStore,
  ClientKeyCustody,
  ClientPairingOriginalStore,
  DeviceIdentity,
  InstalledKeyStore,
  WorkspaceScope,
  type ClientCustodyBinding,
  ClientIdentityOriginals,
  type ClientKeyPurpose,
  type ClientWrappedKey,
} from '@lody/e2ee-core/services';
import {
  accountPairingOffer,
  credentialPacket,
  makeOwnedPersonalDeviceHost,
} from '@lody/e2ee-client';
import { personalEntryPins } from './entry-pins';
import { personalCloudDatabases, personalCloudHostPorts } from './ports';
import type { PersonalCloudConnection } from './network';

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const raw = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
const random = (size: number) => crypto.getRandomValues(new Uint8Array(size));
const fail = (code: string) => Object.assign(new Error(`e2ee_${code}`), { code });
const prepareFlights = new Map<
  string,
  Promise<{
    accountId: string;
    requestId: string;
    name: string;
    slug: string;
    genesisRecordHex: string;
    genesisHashHex: string;
    deviceCredentialHash: string;
  }>
>();
const recordCreatedFlights = new Map<string, Promise<void>>();
/** Share one in-progress operation for the same account/request. The app is a
 * single process; no cross-process lock is needed. */
function singleFlight<A>(
  flights: Map<string, Promise<A>>,
  key: string,
  work: () => Promise<A>
): Promise<A> {
  const running = flights.get(key);
  if (running) return running;
  const promise = work();
  flights.set(key, promise);
  void promise
    .finally(() => {
      if (flights.get(key) === promise) flights.delete(key);
    })
    .catch(() => {});
  return promise;
}
/** Stable across retries: the same creation request and destination scope reuse
 * one native installation, so a partial first attempt is resumable. */
const installationIdFor = (accountId: string, requestId: string, scope: string) =>
  hex(
    sha256(
      new TextEncoder().encode(
        `lody-e2ee/creation-installation/v1\0${accountId}\0${requestId}\0${scope}`
      )
    )
  );

/** Exact public intent retained before any device key is produced. */
export interface PortableCreationIntent {
  readonly accountId: string;
  readonly requestId: string;
  readonly name: string;
  readonly slug: string;
}

export interface PortableCreateOptions {
  readonly namespace: 'web' | 'mobile';
  readonly protection: 'web-crypto' | 'os-keystore';
  readonly client: PersonalCloudConnection['client'];
  /** Platform custody factory. The creation pass uses a private routing scope;
   * workspaces use the real account/workspace/genesis scope. */
  readonly custody: (
    binding: ClientCustodyBinding,
    databaseName: string
  ) => Layer.Layer<
    ClientKeyCustody | ClientIdentityOriginals,
    unknown,
    ClientInstallationStore | ClientCustodyWriter | ClientPairingOriginalStore
  >;
}

type Wrapped = { readonly purpose: ClientKeyPurpose; readonly blob: string };
type CreationRecord = PortableCreationIntent & {
  readonly version: 1;
  readonly phase: 'preparing' | 'ready';
  readonly genesisRecordHex: string;
  readonly genesisHashHex: string;
  readonly membershipId: string;
  readonly device: string;
  readonly encryptionPublicKey: string;
  readonly installationId: string;
  readonly credentialHash: string;
  readonly wrapped: readonly Wrapped[];
  readonly epochBlob: string | null;
  readonly boundWorkspaceId: string | null;
};

const DB_VERSION = 1;
const STORE = 'creations';

function openCreationDatabase(name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = (event) => {
      if (event.oldVersion !== 0) {
        request.transaction?.abort();
        return;
      }
      request.result.createObjectStore(STORE, { keyPath: 'requestId' });
    };
    request.onerror = request.onblocked = () => {
      settled = true;
      reject(fail('storage'));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      if (db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains(STORE)) {
        db.close();
        reject(fail('storage'));
        return;
      }
      resolve(db);
    };
  });
}

function deleteCreationDatabase(name: string) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = request.onblocked = () => reject(fail('storage'));
  });
}

function validRecord(value: unknown): value is CreationRecord {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<CreationRecord>;
  return (
    row.version === 1 &&
    (row.phase === 'preparing' || row.phase === 'ready') &&
    typeof row.accountId === 'string' &&
    typeof row.requestId === 'string' &&
    typeof row.name === 'string' &&
    typeof row.slug === 'string' &&
    typeof row.genesisRecordHex === 'string' &&
    /^[0-9a-f]{64}$/.test(row.genesisHashHex ?? '') &&
    typeof row.membershipId === 'string' &&
    typeof row.device === 'string' &&
    typeof row.encryptionPublicKey === 'string' &&
    typeof row.installationId === 'string' &&
    typeof row.credentialHash === 'string' &&
    Array.isArray(row.wrapped) &&
    (row.epochBlob === null || typeof row.epochBlob === 'string') &&
    (row.boundWorkspaceId === null || typeof row.boundWorkspaceId === 'string')
  );
}

/** Account-level durable creation record. No private key or credential is stored
 * here; every key body is a native/web-custody wrapped blob. */
function creationStore(databaseName: string) {
  const transact = <A>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => Promise<A>
  ): Promise<A> =>
    openCreationDatabase(databaseName).then(
      (db) =>
        new Promise<A>((resolve, reject) => {
          const tx = db.transaction(STORE, mode);
          let result: A;
          let error: unknown;
          tx.oncomplete = () => {
            db.close();
            resolve(result);
          };
          tx.onabort = () => {
            db.close();
            reject(error ?? fail('storage'));
          };
          const store = tx.objectStore(STORE);
          work(store).then(
            (value) => {
              result = value;
            },
            (cause) => {
              error = cause;
              tx.abort();
            }
          );
        })
    );
  return {
    read: (requestId: string): Promise<CreationRecord | null> =>
      transact<CreationRecord | null>('readonly', (store) => {
        const request = store.get(requestId);
        return new Promise((resolve) => {
          request.onsuccess = () => resolve(validRecord(request.result) ? request.result : null);
        });
      }),
    byGenesis: (genesisHashHex: string): Promise<CreationRecord | null> =>
      transact<CreationRecord | null>('readonly', (store) => {
        const request = store.openCursor();
        return new Promise((resolve, reject) => {
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              resolve(null);
              return;
            }
            if (validRecord(cursor.value) && cursor.value.genesisHashHex === genesisHashHex) {
              resolve(cursor.value);
              return;
            }
            cursor.continue();
          };
          request.onerror = () => reject(fail('storage'));
        });
      }),
    delete: (requestId: string): Promise<void> =>
      transact<void>('readwrite', (store) => {
        const request = store.delete(requestId);
        return new Promise((resolve) => {
          request.onsuccess = () => resolve(undefined);
        });
      }),
    write: (record: CreationRecord): Promise<void> =>
      transact<void>('readwrite', (store) => {
        const request = store.put(record);
        return new Promise((resolve) => {
          request.onsuccess = () => resolve(undefined);
        });
      }),
  };
}

function baseStores(
  binding: ClientCustodyBinding,
  names: { ledger: string; custody: string },
  mode: 'create-or-open' | 'open-existing'
) {
  return Layer.mergeAll(
    indexedDbClientStores({
      databaseName: names.ledger,
      accountId: binding.accountId,
      workspaceId: binding.workspaceId,
      mode,
    }),
    indexedDbClientInstallationStore({
      databaseName: names.custody,
      accountId: binding.accountId,
      workspaceId: binding.workspaceId,
      mode,
    }),
    browserClientWriter({ accountId: binding.accountId, workspaceId: binding.workspaceId })
  ).pipe(Layer.provide(Layer.succeed(WorkspaceScope, { genesis: binding.genesis })));
}

const creationNames = (namespace: 'web' | 'mobile', requestId: string) => {
  const root = `lody-e2ee:${namespace}:v1:creation:${requestId}`;
  return { ledger: root + ':ledger', custody: root + ':custody' };
};

const wrapIdentity = (
  custody: ClientKeyCustody['Service'],
  signing: Uint8Array,
  encryption: Uint8Array,
  packet: Uint8Array
) =>
  Effect.gen(function* () {
    const wrapped: ClientWrappedKey[] = [
      { purpose: 'signing-private-key', blob: yield* custody.wrap('signing-private-key', signing) },
      {
        purpose: 'encryption-private-key',
        blob: yield* custody.wrap('encryption-private-key', encryption),
      },
      { purpose: 'device-credential', blob: yield* custody.wrap('device-credential', packet) },
    ];
    return wrapped;
  });

/** Portable creation host: all private bodies stay inside platform custody. */
export function portableCreation(input: PortableCreateOptions & { readonly accountId: string }) {
  const databaseName = `lody-e2ee:${input.namespace}:v1:account:${input.accountId}:creation`;
  const pins = personalEntryPins(`lody-e2ee:${input.namespace}:v1:entry-pins`);

  const finishCreation = (
    record: CreationRecord,
    rawKeys?: {
      signing: Uint8Array;
      encryption: Uint8Array;
      credential: Uint8Array;
      epoch: Uint8Array;
    }
  ) =>
    Effect.gen(function* () {
      const store = creationStore(databaseName);
      const genesis = Result.getOrThrow(Bytes.genesisHash(raw(record.genesisHashHex)));
      const devicePublic = Result.getOrThrow(Bytes.signingPublicKey(raw(record.device)));
      const binding: ClientCustodyBinding = {
        accountId: record.accountId,
        workspaceId: `creation-${record.requestId}`,
        genesis,
        device: devicePublic,
        installationId: record.installationId,
      };
      const names = creationNames(input.namespace, record.requestId);
      const stores = yield* Layer.build(baseStores(binding, names, 'create-or-open'));
      const installations = Context.get(stores, ClientInstallationStore);
      let current = yield* installations.read();
      if (
        current &&
        (current.binding.accountId !== binding.accountId ||
          current.binding.workspaceId !== binding.workspaceId ||
          !current.binding.genesis.equals(binding.genesis) ||
          !current.binding.device.equals(binding.device) ||
          current.binding.installationId !== binding.installationId)
      )
        return yield* Effect.fail(fail('conflict'));
      if (!current) {
        yield* installations.compareAndSet(null, {
          binding,
          revision: 0,
          phase: 'prepared',
          wrapped: [],
        });
        current = (yield* installations.read())!;
      }
      const custodyScope = yield* Layer.build(
        input
          .custody(binding, names.custody + ':native-originals')
          .pipe(Layer.provide(Layer.succeedContext(stores)))
      );
      const custody = Context.get(custodyScope, ClientKeyCustody);
      yield* custody.create();
      let wrapped: ClientWrappedKey[] =
        current.wrapped.length === 3
          ? current.wrapped.map((row) => ({ ...row }))
          : record.wrapped.length === 3
            ? record.wrapped.map((row) => ({
                purpose: row.purpose as ClientWrappedKey['purpose'],
                blob: raw(row.blob),
              }))
            : [];
      if (wrapped.length === 0) {
        const originals = yield* Effect.result(
          Context.get(custodyScope, ClientIdentityOriginals).read()
        );
        if (Result.isSuccess(originals) && originals.success.length === 3)
          wrapped = originals.success.map((row) => ({ ...row }));
      }
      if (wrapped.length === 0 && rawKeys)
        wrapped = yield* wrapIdentity(
          custody,
          rawKeys.signing,
          rawKeys.encryption,
          rawKeys.credential
        );
      if (wrapped.length !== 3) return yield* Effect.fail(fail('identity_lost'));
      if (current.phase === 'prepared') {
        yield* installations.compareAndSet(current.revision, {
          binding,
          revision: current.revision + 1,
          phase: 'protected',
          wrapped,
        });
        current = (yield* installations.read())!;
      }
      if (current.phase === 'protected') {
        yield* installations.compareAndSet(current.revision, {
          binding,
          revision: current.revision + 1,
          phase: 'ready',
          wrapped,
        });
        current = (yield* installations.read())!;
      }
      if (current.phase !== 'ready') return yield* Effect.fail(fail('identity_lost'));
      const wrappedHex = wrapped.map((row) => ({ purpose: row.purpose, blob: hex(row.blob) }));
      // Persist each recoverable half before the next native/write step. A crash
      // after this point can resume from the exact wrappers and epoch key.
      const partial: CreationRecord = { ...record, wrapped: wrappedHex };
      yield* Effect.tryPromise({ try: () => store.write(partial), catch: (cause) => cause });
      const epochBlob = record.epochBlob
        ? raw(record.epochBlob)
        : rawKeys
          ? yield* custody.wrap('installed-epoch-key', rawKeys.epoch)
          : null;
      if (!epochBlob) return yield* Effect.fail(fail('identity_lost'));
      const withEpoch: CreationRecord = { ...partial, epochBlob: hex(epochBlob) };
      yield* Effect.tryPromise({ try: () => store.write(withEpoch), catch: (cause) => cause });
      const completed: CreationRecord = { ...withEpoch, phase: 'ready' };
      yield* Effect.tryPromise({ try: () => store.write(completed), catch: (cause) => cause });
      return completed;
    });

  /** A preparing record never returned its genesis, so the service cannot have
   * seen it. Discard the local identity and its creation-scope installation, then
   * regenerate under the same requestId. Never called for a ready record. */
  const discardPreparing = (record: CreationRecord) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const genesis = Result.getOrThrow(Bytes.genesisHash(raw(record.genesisHashHex)));
        const binding: ClientCustodyBinding = {
          accountId: record.accountId,
          workspaceId: `creation-${record.requestId}`,
          genesis,
          device: Result.getOrThrow(Bytes.signingPublicKey(raw(record.device))),
          installationId: record.installationId,
        };
        const names = creationNames(input.namespace, record.requestId);
        yield* Effect.result(
          Effect.scoped(
            Effect.gen(function* () {
              const stores = yield* Layer.build(baseStores(binding, names, 'open-existing'));
              const installations = Context.get(stores, ClientInstallationStore);
              if (!(yield* installations.read())) return;
              const custodyScope = yield* Layer.build(
                input
                  .custody(binding, names.custody + ':native-originals')
                  .pipe(Layer.provide(Layer.succeedContext(stores)))
              );
              yield* Context.get(custodyScope, ClientKeyCustody).delete();
            })
          )
        );
        yield* Effect.tryPromise({
          try: async () => {
            await deleteCreationDatabase(names.ledger);
            await deleteCreationDatabase(names.custody);
            await deleteCreationDatabase(names.custody + ':native-originals');
            await creationStore(databaseName).delete(record.requestId);
          },
          catch: (cause) => cause,
        });
      })
    );

  const prepareOnce = async (intent: PortableCreationIntent) => {
    if (intent.accountId !== input.accountId) throw fail('account_mismatch');
    const store = creationStore(databaseName);
    const existing = await store.read(intent.requestId);
    if (existing) {
      if (
        existing.accountId !== intent.accountId ||
        existing.name !== intent.name ||
        existing.slug !== intent.slug
      )
        throw fail('conflict');
      if (existing.phase === 'ready')
        return {
          ...intent,
          genesisRecordHex: existing.genesisRecordHex,
          genesisHashHex: existing.genesisHashHex,
          deviceCredentialHash: existing.credentialHash,
        };
      if (existing.wrapped.length === 3 && existing.epochBlob) {
        try {
          const completed = (await Effect.runPromise(
            Effect.scoped(finishCreation(existing))
          )) as CreationRecord;
          return {
            ...intent,
            genesisRecordHex: completed.genesisRecordHex,
            genesisHashHex: completed.genesisHashHex,
            deviceCredentialHash: completed.credentialHash,
          };
        } catch (error) {
          if ((error as { code?: string }).code !== 'identity_lost') throw error;
        }
      }
      // Nothing was returned to the caller, so the service never saw this
      // genesis. Drop the incomplete identity and start again under this ID.
      await discardPreparing(existing);
    }
    const userId = accountUserId(input.accountId);
    if (Result.isFailure(userId)) throw fail('account_identity_required');
    const signing = random(32);
    const encryption = random(32);
    const credential = random(32);
    const epoch = random(32);
    const membershipId = random(16);
    try {
      const createdRecord = (await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const device = yield* importBrowserDevice({
              signingPrivate: signing,
              encryptionPrivate: encryption,
            });
            const signed = yield* signGenesisRecord({
              signer: device,
              encryptionPublicKey: device.enc,
              initialKey: Result.getOrThrow(Bytes.epochKey(epoch)),
              userId: userId.success,
              membershipId: Result.getOrThrow(Bytes.membershipId(membershipId)),
            });
            const genesisHashHex = hex(signed.genesis.toBytes());
            const installationId = installationIdFor(input.accountId, intent.requestId, 'creation');
            const preparing: CreationRecord = {
              version: 1,
              phase: 'preparing',
              accountId: input.accountId,
              requestId: intent.requestId,
              name: intent.name,
              slug: intent.slug,
              genesisRecordHex: hex(signed.record),
              genesisHashHex,
              membershipId: hex(membershipId),
              device: hex(device.publicKey.toBytes()),
              encryptionPublicKey: hex(device.enc.toBytes()),
              installationId,
              credentialHash: hex(sha256(credential)),
              wrapped: [],
              epochBlob: null,
              boundWorkspaceId: null,
            };
            // The exact public intent and device identity are durable before any
            // native allocation, so a retry resumes instead of forking the request.
            const initialStore = creationStore(databaseName);
            yield* Effect.tryPromise({
              try: () => initialStore.write(preparing),
              catch: (cause) => cause,
            });
            return yield* finishCreation(preparing, { signing, encryption, credential, epoch });
          })
        )
      )) as CreationRecord;
      return {
        ...intent,
        genesisRecordHex: createdRecord.genesisRecordHex,
        genesisHashHex: createdRecord.genesisHashHex,
        deviceCredentialHash: createdRecord.credentialHash,
      };
    } finally {
      signing.fill(0);
      encryption.fill(0);
      credential.fill(0);
      epoch.fill(0);
      membershipId.fill(0);
    }
  };

  /** Same protected epoch-key body the public InstalledEpochKeys sealer uses.
   * Sealing it here avoids booting the whole key workflow just to store epoch 0. */
  const sealEpochKey = (
    custody: ClientKeyCustody['Service'],
    binding: ClientCustodyBinding,
    epochKey: Uint8Array
  ) =>
    Effect.gen(function* () {
      const purpose = new TextEncoder().encode('lody-e2ee/local-epoch-key/v1\0');
      const commitment = Result.getOrThrow(
        commitEpochKey(binding.genesis, 0, Result.getOrThrow(Bytes.epochKey(epochKey)))
      );
      const header = purpose.length + 32 + 32 + 4 + 32;
      const body = new Uint8Array(header + 32);
      body.set(purpose);
      body.set(binding.genesis.toBytes(), purpose.length);
      body.set(binding.device.toBytes(), purpose.length + 32);
      new DataView(body.buffer).setUint32(purpose.length + 64, 0);
      body.set(commitment.toBytes(), purpose.length + 68);
      body.set(epochKey, header);
      try {
        return yield* custody.wrap('installed-epoch-key', body);
      } finally {
        body.fill(0);
      }
    });

  const writeInitialRequest = (
    stores: Context.Context<ClientPairingOriginalStore>,
    binding: ClientCustodyBinding,
    offer: ReturnType<typeof accountPairingOffer>,
    device: BrowserDevice,
    credential: Uint8Array
  ) =>
    Effect.gen(function* () {
      const pairings = Context.get(stores, ClientPairingOriginalStore);
      const key = {
        ...binding,
        pairingSessionId: offer.pairingSessionId,
        purpose: 'request' as const,
      };
      if (yield* pairings.load(key)) return;
      const credentialHash = sha256(credential);
      const proof = yield* prepareDeviceAdmission({
        genesis: binding.genesis,
        membershipId: Result.getOrThrow(Bytes.membershipId(raw(offer.membershipId))),
        encryptionPublicKey: device.enc,
        kind: 'personal',
        signer: device,
      });
      const bound = yield* signDeviceCredentialBinding({
        genesis: binding.genesis,
        pairingSessionId: raw(offer.pairingSessionId),
        signingPublicKey: device.publicKey,
        credentialHash,
        signer: device,
      });
      const requestHex = hex(
        new TextEncoder().encode(
          JSON.stringify({
            ...offer,
            signingPublicKey: hex(device.publicKey.toBytes()),
            encryptionPublicKey: hex(device.enc.toBytes()),
            credentialHash: hex(credentialHash),
            possessionSignature: hex(proof.possessionSignature.toBytes()),
            bindingSignature: hex(bound.toBytes()),
            protection: input.protection,
          })
        )
      );
      yield* pairings.compareAndSet(key, null, {
        revision: 1,
        original: new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            binding: {
              accountId: binding.accountId,
              workspaceId: binding.workspaceId,
              genesis: hex(binding.genesis.toBytes()),
              device: hex(binding.device.toBytes()),
              installationId: binding.installationId,
            },
            offer,
            requestHex,
            replacing: null,
          })
        ),
        receipt: null,
      });
    });

  const unseal = (record: CreationRecord) =>
    Effect.scoped(
      Effect.gen(function* () {
        const genesis = Result.getOrThrow(Bytes.genesisHash(raw(record.genesisHashHex)));
        const binding: ClientCustodyBinding = {
          accountId: record.accountId,
          workspaceId: `creation-${record.requestId}`,
          genesis,
          device: Result.getOrThrow(Bytes.signingPublicKey(raw(record.device))),
          installationId: record.installationId,
        };
        const names = creationNames(input.namespace, record.requestId);
        const stores = yield* Layer.build(baseStores(binding, names, 'open-existing'));
        const installations = Context.get(stores, ClientInstallationStore);
        const installation = yield* installations.read();
        if (!installation || installation.phase !== 'ready') throw fail('identity_lost');
        const wrapped = new Map(installation.wrapped.map((row) => [row.purpose, row.blob]));
        const custodyScope = yield* Layer.build(
          input
            .custody(binding, names.custody + ':native-originals')
            .pipe(Layer.provide(Layer.succeedContext(stores)))
        );
        const custody = Context.get(custodyScope, ClientKeyCustody);
        const epochBlob = record.epochBlob;
        if (!epochBlob) return yield* Effect.fail(fail('identity_lost'));
        const body = (purpose: ClientWrappedKey['purpose']) => {
          const blob = wrapped.get(purpose);
          if (!blob) return Effect.fail(fail('identity_lost'));
          return custody.unwrap(purpose, blob);
        };
        return {
          signing: yield* body('signing-private-key'),
          encryption: yield* body('encryption-private-key'),
          credential: yield* body('device-credential'),
          epoch: yield* custody.unwrap('installed-epoch-key', raw(record.epochBlob ?? '')),
        };
      })
    );

  const recordCreatedOnce = (created: {
    workspaceId: string;
    genesisHash: string;
    requestId?: string;
  }) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = creationStore(databaseName);
          const record = (yield* Effect.tryPromise({
            try: async () =>
              created.requestId
                ? await store.read(created.requestId)
                : await store.byGenesis(created.genesisHash),
            catch: (cause) => cause,
          })) as CreationRecord | null;
          if (!record || record.genesisHashHex !== created.genesisHash || record.phase !== 'ready')
            return yield* Effect.fail(fail('missing_binding'));
          if (record.boundWorkspaceId && record.boundWorkspaceId !== created.workspaceId)
            return yield* Effect.fail(fail('conflict'));
          if (record.boundWorkspaceId === created.workspaceId) return undefined;
          const keys = yield* unseal(record);
          try {
            const genesis = Result.getOrThrow(Bytes.genesisHash(raw(record.genesisHashHex)));
            const device = yield* importBrowserDevice({
              signingPrivate: keys.signing,
              encryptionPrivate: keys.encryption,
            });
            const installationId = installationIdFor(
              record.accountId,
              record.requestId,
              created.workspaceId
            );
            const binding: ClientCustodyBinding = {
              accountId: record.accountId,
              workspaceId: created.workspaceId,
              genesis,
              device: device.publicKey,
              installationId,
            };
            const offer = accountPairingOffer(
              { workspaceId: created.workspaceId, genesis },
              { genesisRecordHex: record.genesisRecordHex, membershipId: record.membershipId }
            );
            const names = personalCloudDatabases(
              { accountId: record.accountId, workspaceId: created.workspaceId, genesis },
              input.namespace
            );
            const stores = yield* Layer.build(baseStores(binding, names, 'create-or-open'));
            const installations = Context.get(stores, ClientInstallationStore);
            let current = yield* installations.read();
            if (
              current &&
              (current.binding.accountId !== binding.accountId ||
                current.binding.workspaceId !== binding.workspaceId ||
                !current.binding.genesis.equals(binding.genesis) ||
                !current.binding.device.equals(binding.device) ||
                current.binding.installationId !== binding.installationId)
            )
              return yield* Effect.fail(fail('conflict'));
            if (!current) {
              yield* installations.compareAndSet(null, {
                binding,
                revision: 0,
                phase: 'prepared',
                wrapped: [],
              });
              current = (yield* installations.read())!;
            }
            const custodyScope = yield* Layer.build(
              input
                .custody(binding, names.custody + ':native-originals')
                .pipe(Layer.provide(Layer.succeedContext(stores)))
            );
            const custody = Context.get(custodyScope, ClientKeyCustody);
            yield* custody.create();
            let wrapped: ClientWrappedKey[] =
              current.wrapped.length === 3 ? current.wrapped.map((row) => ({ ...row })) : [];
            if (wrapped.length === 0) {
              const packet = yield* Effect.fromResult(
                credentialPacket(binding, offer, keys.credential)
              ).pipe(Effect.mapError(() => fail('corrupt')));
              wrapped = yield* wrapIdentity(custody, keys.signing, keys.encryption, packet);
              packet.fill(0);
            }
            if (current.phase === 'prepared') {
              yield* installations.compareAndSet(current.revision, {
                binding,
                revision: current.revision + 1,
                phase: 'protected',
                wrapped,
              });
              current = (yield* installations.read())!;
            }
            if (current.phase === 'protected') {
              yield* installations.compareAndSet(current.revision, {
                binding,
                revision: current.revision + 1,
                phase: 'ready',
                wrapped,
              });
              current = (yield* installations.read())!;
            }
            if (current.phase !== 'ready') return yield* Effect.fail(fail('identity_lost'));
            yield* writeInitialRequest(stores, binding, offer, device, keys.credential);
            const epochBlob = yield* sealEpochKey(custody, binding, keys.epoch);
            const keyScope = yield* Layer.build(
              indexedDbClientKeyStores({
                databaseName: names.custody,
                binding,
                mode: 'create-or-open',
              }).pipe(
                Layer.provide(
                  Layer.mergeAll(
                    Layer.succeed(DeviceIdentity, {
                      signer: device,
                      encryptionKeyPair: device.encryption,
                    }),
                    Layer.succeed(WorkspaceScope, { genesis })
                  )
                )
              )
            );
            yield* Context.get(keyScope, InstalledKeyStore).insertIfAbsent(0, epochBlob);
            const ports = personalCloudHostPorts(
              {
                accountId: record.accountId,
                offer,
                platformNamespace: input.namespace,
                mode: 'create-or-open',
                client: input.client,
                currentAccount: () => Effect.succeed(record.accountId),
                // No earlier reader exists for this brand-new binding. A replacement
                // must go through the application owner, never this creation path.
                drainOld: () => Effect.fail(fail('unsupported')),
              },
              {
                protection: input.protection,
                custody: (candidate) =>
                  input.custody(candidate, names.custody + ':native-originals'),
              }
            );
            yield* Effect.scoped(
              Effect.gen(function* () {
                const host = yield* makeOwnedPersonalDeviceHost(ports);
                yield* host.acceptAccountHistory({
                  genesisRecordHex: record.genesisRecordHex,
                  membershipId: record.membershipId,
                  pages: [
                    {
                      workspaceId: created.workspaceId,
                      genesisHash: record.genesisHashHex,
                      checkpoint: { length: 1, headHash: record.genesisHashHex },
                      startIndex: 0,
                      recordsHex: [record.genesisRecordHex],
                      position: 'genesis',
                      nextCursor: null,
                    },
                  ],
                });
                yield* host.close();
              })
            );
            yield* pins.prepare(record.accountId, offer);
            yield* pins.finish(record.accountId, offer, 'ready');
            yield* Effect.tryPromise({
              try: () => store.write({ ...record, boundWorkspaceId: created.workspaceId }),
              catch: (cause) => cause,
            });
          } finally {
            keys.signing.fill(0);
            keys.encryption.fill(0);
            keys.credential.fill(0);
            keys.epoch.fill(0);
          }
          return undefined;
        })
      )
    );

  return {
    prepare: (intent: PortableCreationIntent) =>
      singleFlight(prepareFlights, `${intent.accountId}\0${intent.requestId}`, () =>
        prepareOnce(intent)
      ),
    recordCreated: (created: { workspaceId: string; genesisHash: string; requestId?: string }) =>
      singleFlight(
        recordCreatedFlights,
        `${input.accountId}\0${created.requestId ?? created.workspaceId}`,
        () => recordCreatedOnce(created)
      ),
  };
}
