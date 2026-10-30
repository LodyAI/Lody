import { Context, Deferred, Effect, Exit, Fiber, Layer, Result, Scope } from 'effect';
import { browserClientCustody, browserClientWriter } from '../../src/adapters/browser-custody';
import {
  indexedDbClientInstallationStore,
  indexedDbClientKeyStores,
  indexedDbClientStores,
  indexedDbSnapshotPublication,
} from '../../src/adapters/indexeddb';
import {
  ClientInstallationStore,
  ClientKeyCustody,
  ClientCustodyWriter,
  ClientIdentityOriginals,
  ClientPairingOriginalStore,
  SnapshotPublicationJournal,
  WorkspaceScope,
  DeviceIdentity,
  InstalledKeyStore,
  ReceiveJournal,
  RepairJournal,
  DistributionJournal,
  DeliveryOutbox,
  EpochCandidateStore,
} from '../../src/services';
import { importBrowserDevice } from '../../src/adapters/browser-crypto';
import * as Protocol from '../../src/protocol';
import fixture from '../client-custody-vector.json';
import { copyEpochKeyBytes, disposeEpochKey } from '../../src/internal/foundation/epoch-key';
import hpke from '../hpke-vector.json';
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (x) => parseInt(x, 16));
const hex = (value: Uint8Array) =>
  Array.from(value, (x) => x.toString(16).padStart(2, '0')).join('');
let binding = {
  accountId: fixture.binding.accountId,
  workspaceId: fixture.binding.workspaceId,
  genesis: Result.getOrThrow(Protocol.Bytes.genesisHash(bytes(fixture.binding.genesisHex))),
  device: Result.getOrThrow(Protocol.Bytes.signingPublicKey(bytes(fixture.binding.deviceHex))),
  installationId: fixture.binding.installationId,
};
const secrets = [
  bytes('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'),
  bytes(hpke.epoch.skR),
  new Uint8Array(32).fill(0x73),
];
let expectedEnc = hpke.epoch.pkR;
let replacingFrom: import('../../src/services').ClientInstallation | undefined;
let scope: Scope.Closeable;
let snapshot: SnapshotPublicationJournal['Service'] | undefined;
let ports: Context.Context<
  | ClientInstallationStore
  | ClientKeyCustody
  | ClientCustodyWriter
  | ClientIdentityOriginals
  | ClientPairingOriginalStore
  | InstalledKeyStore
  | ReceiveJournal
  | RepairJournal
  | DistributionJournal
  | DeliveryOutbox
  | EpochCandidateStore
>;
const own = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return hex(value);
  if (Array.isArray(value)) return value.map(own);
  if (value !== null && typeof value === 'object') {
    if ('toBytes' in value && typeof value.toBytes === 'function')
      return hex((value.toBytes as () => Uint8Array).call(value));
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, own(v)]));
  }
  return value;
};
const reason = (value: unknown) => {
  if (value !== null && typeof value === 'object') {
    if ('reason' in value && typeof value.reason === 'string') return value.reason;
    if ('code' in value && typeof value.code === 'string') return value.code;
  }
  return 'fixture-error';
};
let activeDatabaseName = '';
export async function boot(
  databaseName: string,
  mode: 'create-or-open' | 'open-existing' = 'create-or-open',
  variant = 0,
  candidate = false,
  maxTasks = 10000,
  mismatch?: 'account' | 'workspace' | 'genesis'
) {
  activeDatabaseName = databaseName;
  await Effect.runPromise(
    Effect.gen(function* () {
      scope = yield* Scope.make();
      snapshot = undefined;
      replacingFrom = undefined;
      secrets[0] = bytes(
        variant === 0
          ? '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
          : '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'
      );
      secrets[1] =
        variant === 0 ? bytes(hpke.epoch.skR) : bytes(hpke.epoch.skR).map((x) => x ^ 0x55);
      secrets[2] = new Uint8Array(32).fill(0x73 + variant);
      const device = yield* importBrowserDevice({
        signingPrivate: secrets[0],
        encryptionPrivate: secrets[1],
      }).pipe(Effect.provideService(Scope.Scope, scope));
      binding = {
        accountId: fixture.binding.accountId + (mismatch === 'account' ? '/wrong' : ''),
        workspaceId: fixture.binding.workspaceId + (mismatch === 'workspace' ? '/wrong' : ''),
        genesis: Result.getOrThrow(
          Protocol.Bytes.genesisHash(
            mismatch === 'genesis'
              ? new Uint8Array(32).fill(0x74)
              : bytes(fixture.binding.genesisHex)
          )
        ),
        device: device.publicKey,
        installationId: variant === 0 ? fixture.binding.installationId : '77'.repeat(32),
      };
      expectedEnc = hex(device.enc.toBytes());
      const workspace = Layer.succeed(WorkspaceScope, { genesis: binding.genesis });
      const base = Layer.mergeAll(
        indexedDbClientStores({
          databaseName: databaseName + '/pairing',
          mode,
          accountId: binding.accountId,
          workspaceId: binding.workspaceId,
        }),
        indexedDbClientKeyStores({ databaseName, binding, mode, maxTasks }).pipe(
          Layer.provide(
            Layer.succeed(DeviceIdentity, { signer: device, encryptionKeyPair: device.encryption })
          )
        ),
        indexedDbClientInstallationStore({
          databaseName,
          accountId: binding.accountId,
          workspaceId: binding.workspaceId,
          mode,
        }),
        browserClientWriter({
          accountId: binding.accountId,
          workspaceId: binding.workspaceId,
        })
      ).pipe(Layer.provide(workspace));
      ports = yield* Layer.buildWithScope(
        browserClientCustody({
          databaseName,
          binding,
          mode,
          candidateRequest: candidate
            ? { ...binding, purpose: 'request', pairingSessionId: 'aa'.repeat(16) }
            : undefined,
        }).pipe(Layer.provideMerge(base), Layer.provide(workspace)),
        scope
      );
    })
  );
}
export async function invoke(action: string) {
  const result = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const store = yield* ClientInstallationStore,
          custody = yield* ClientKeyCustody,
          writer = yield* ClientCustodyWriter;
        if (action.startsWith('snapshot')) {
          if (!snapshot) {
            const device = yield* importBrowserDevice({
              signingPrivate: secrets[0],
              encryptionPrivate: secrets[1],
            });
            const journal = yield* Layer.buildWithScope(
              indexedDbSnapshotPublication({
                databaseName: activeDatabaseName,
                binding,
                resource: 'doc:test',
                model: 'loro',
                mode: action === 'snapshotSeed' ? 'create-or-open' : 'open-existing',
              }).pipe(
                Layer.provide(
                  Layer.mergeAll(
                    Layer.succeed(WorkspaceScope, { genesis: binding.genesis }),
                    Layer.succeed(DeviceIdentity, {
                      signer: device,
                      encryptionKeyPair: device.encryption,
                    })
                  )
                )
              ),
              scope
            );
            snapshot = Context.get(journal, SnapshotPublicationJournal);
          }
          const first = {
            offset: 'opaque/4',
            signer: fixture.binding.deviceHex,
            body: Uint8Array.of(41, 42),
            issuedAt: 1,
            expiresAt: 200,
          };
          switch (action) {
            case 'snapshotSeed':
              return yield* snapshot.reserve(first);
            case 'snapshotRows':
              return {
                pending: yield* snapshot.pending(),
                current: yield* snapshot.current(),
                old: yield* snapshot.lookup('opaque/4'),
              };
            case 'snapshotBusy':
              return yield* snapshot.reserve({
                ...first,
                offset: 'opaque/5',
                body: Uint8Array.of(45),
              });
            case 'snapshotMismatch':
              return yield* snapshot.reserve({ ...first, body: Uint8Array.of(99) });
            case 'snapshotAccept':
              return yield* snapshot.accept((yield* snapshot.pending())!);
            case 'snapshotSecond': {
              const next = yield* snapshot.reserve({
                ...first,
                offset: 'opaque/5',
                body: Uint8Array.of(51, 52),
              });
              yield* snapshot.accept(next);
              return yield* snapshot.current();
            }
            case 'snapshotRetryOld': {
              const old = yield* snapshot.reserve({ ...first, expiresAt: 999 });
              yield* snapshot.accept(old);
              return yield* snapshot.lookup(first.offset);
            }
          }
        }
        switch (action) {
          case 'wrapOnly':
          case 'wrapOnlyAndHold': {
            const wrapped = [];
            for (const [i, purpose] of (
              ['signing-private-key', 'encryption-private-key', 'device-credential'] as const
            ).entries())
              wrapped.push({ purpose, blob: yield* custody.wrap(purpose, secrets[i]) });
            if (action === 'wrapOnlyAndHold') {
              (globalThis as unknown as { wrappersCommitted: boolean }).wrappersCommitted = true;
              return yield* Effect.never;
            }
            return wrapped;
          }
          case 'identityOriginals':
            return yield* (yield* ClientIdentityOriginals).read();
          case 'restoreProtected': {
            const row = yield* store.read(),
              originals = yield* (yield* ClientIdentityOriginals).read();
            if (!row || originals.length !== 3) throw new Error('incomplete originals');
            return yield* store.compareAndSet(row.revision, {
              ...row,
              revision: row.revision + 1,
              phase: 'protected',
              wrapped: originals,
            });
          }
          case 'candidateRequest':
            return yield* (yield* ClientPairingOriginalStore).compareAndSet(
              { ...binding, purpose: 'request', pairingSessionId: 'aa'.repeat(16) },
              null,
              { revision: 1, original: Uint8Array.of(61, 62), receipt: null }
            );
          case 'retire': {
            const current = yield* store.read();
            if (!current) throw new Error('missing old');
            replacingFrom = { ...current, revision: current.revision + 1, phase: 'retired' };
            return yield* writer.run(store.compareAndSet(current.revision, replacingFrom));
          }
          case 'switchOrdinary': {
            const current = yield* store.read(),
              wrapped = yield* (yield* ClientIdentityOriginals).read();
            return yield* store.compareAndSet(current!.revision, {
              binding,
              revision: current!.revision + 1,
              phase: 'protected',
              wrapped,
            });
          }
          case 'replaceBeforeRetire': {
            const current = yield* store.read(),
              wrapped = yield* (yield* ClientIdentityOriginals).read();
            return yield* writer.run(
              store.replace(
                { binding: current!.binding, revision: current!.revision },
                { binding, revision: current!.revision + 1, phase: 'protected', wrapped }
              )
            );
          }
          case 'replaceCandidate': {
            if (!replacingFrom) throw new Error('missing retained expected');
            const wrapped = yield* (yield* ClientIdentityOriginals).read();
            return yield* writer.run(
              store.replace(
                { binding: replacingFrom.binding, revision: replacingFrom.revision },
                { binding, revision: replacingFrom.revision + 1, phase: 'protected', wrapped }
              )
            );
          }
          case 'readOld':
            return yield* store.readRetired({
              ...binding,
              device: Result.getOrThrow(
                Protocol.Bytes.signingPublicKey(bytes(fixture.binding.deviceHex))
              ),
              installationId: fixture.binding.installationId,
            });
          case 'delete':
            return yield* custody.delete();
          case 'reuseArchived': {
            const old = yield* store.read();
            if (!old) throw new Error('no current');
            const fresh = {
              ...binding,
              device: Result.getOrThrow(
                Protocol.Bytes.signingPublicKey(bytes(fixture.binding.deviceHex))
              ),
              installationId: '88'.repeat(32),
            };
            return yield* store.replace(
              { binding: old.binding, revision: old.revision },
              { ...old, binding: fresh, revision: old.revision + 1, phase: 'protected' }
            );
          }
          case 'journalAckEarly':
            return yield* (yield* DistributionJournal).acknowledge('distribution-1');
          case 'journalReportChanged':
            return yield* (yield* ReceiveJournal).queueReport('receive-1', Uint8Array.of(77));
          case 'journalAck': {
            yield* (yield* ReceiveJournal).acknowledge('receive-1');
            yield* (yield* RepairJournal).acknowledge('repair-1');
            yield* (yield* DistributionJournal).acknowledge('distribution-1');
            return undefined;
          }
          case 'journalResults':
            return {
              receive: yield* (yield* ReceiveJournal).results(10),
              repair: yield* (yield* RepairJournal).results(null, 10),
              distribution: yield* (yield* DistributionJournal).results(null, 10),
            };
          case 'journalOriginalsWin': {
            yield* (yield* InstalledKeyStore).insertIfAbsent(1, Uint8Array.of(99));
            yield* (yield* InstalledKeyStore).replace(1, Uint8Array.of(99), Uint8Array.of(98));
            yield* (yield* ReceiveJournal).insertIfAbsent({
              id: 'receive-1',
              body: Uint8Array.of(99),
              frame: Uint8Array.of(98),
              publication: null,
            });
            yield* (yield* RepairJournal).insertIfAbsent({
              id: 'repair-1',
              epoch: 2,
              rejected: null,
            });
            yield* (yield* DistributionJournal).insertIfAbsent({
              id: 'distribution-1',
              epoch: 2,
              recipient: '44'.repeat(32),
              revision: 99,
            });
            return yield* (yield* DeliveryOutbox).saveOriginal('slot-1', Uint8Array.of(99));
          }
          case 'distributionMore':
            return yield* (yield* DistributionJournal).insertIfAbsent({
              id: 'distribution-2',
              epoch: 1,
              recipient: '44'.repeat(32),
              revision: 0,
            });
          case 'journalPages': {
            const repair = yield* RepairJournal;
            yield* repair.insertIfAbsent({ id: 'repair-2', epoch: 2, rejected: null });
            const a = yield* repair.pending(null, 1),
              b = yield* repair.pending(a.next, 1);
            return { first: a, second: b };
          }
          case 'candidateSeed': {
            const blob = yield* custody.wrap('rotation-candidate', Uint8Array.of(64, 65));
            return yield* (yield* EpochCandidateStore).insert({
              id: '61'.repeat(32),
              parent: new Uint8Array(32).fill(7),
              parentCount: 3,
              epoch: 1,
              commitment: new Uint8Array(32).fill(8),
              record: Uint8Array.of(9),
              envelopes: Uint8Array.of(0x80),
              blob,
              outcome: null,
              binding: null,
              consumed: false,
            });
          }
          case 'candidateSeedMore': {
            const c = yield* EpochCandidateStore,
              old = (yield* c.load('61'.repeat(32)))!;
            return yield* c.insert({
              ...old,
              id: '62'.repeat(32),
              record: Uint8Array.of(10),
              blob: yield* custody.wrap('rotation-candidate', Uint8Array.of(66)),
              outcome: null,
              binding: null,
              consumed: false,
            });
          }
          case 'candidateUnconsume': {
            const c = yield* EpochCandidateStore,
              old = (yield* c.load('61'.repeat(32)))!;
            return yield* c.replace(old, { ...old, consumed: false });
          }
          case 'candidateRows': {
            const c = yield* EpochCandidateStore;
            return { active: yield* c.active(), retained: yield* c.load('61'.repeat(32)) };
          }
          case 'candidateStale': {
            const c = yield* EpochCandidateStore,
              current = (yield* c.active())!;
            return yield* c.replace(
              { ...current, outcome: 'Committed' },
              { ...current, outcome: 'Conflict', blob: new Uint8Array(), consumed: true }
            );
          }
          case 'candidateChanged': {
            const c = yield* EpochCandidateStore,
              current = (yield* c.active())!;
            return yield* c.replace(current, { ...current, record: Uint8Array.of(99) });
          }
          case 'candidateFinish': {
            const c = yield* EpochCandidateStore,
              current = (yield* c.active())!;
            return yield* c.replace(current, {
              ...current,
              outcome: 'Conflict',
              blob: new Uint8Array(),
              consumed: true,
            });
          }
          case 'journalSeed': {
            yield* (yield* InstalledKeyStore).insertIfAbsent(
              1,
              yield* custody.wrap('installed-epoch-key', Uint8Array.of(1, 2, 3))
            );
            yield* (yield* ReceiveJournal).insertIfAbsent({
              id: 'receive-1',
              body: Uint8Array.of(11),
              frame: Uint8Array.of(12),
              publication: null,
            });
            yield* (yield* RepairJournal).insertIfAbsent({
              id: 'repair-1',
              epoch: 1,
              rejected: null,
            });
            yield* (yield* DistributionJournal).insertIfAbsent({
              id: 'distribution-1',
              epoch: 1,
              recipient: '33'.repeat(32),
              revision: 0,
            });
            return yield* (yield* DeliveryOutbox).saveOriginal('slot-1', Uint8Array.of(81, 82));
          }
          case 'journalRows':
            return {
              installed: yield* (yield* InstalledKeyStore).load(1),
              receive: yield* (yield* ReceiveJournal).load('receive-1'),
              repair: yield* (yield* RepairJournal).load('repair-1'),
              distribution: yield* (yield* DistributionJournal).load('distribution-1'),
              outbox: yield* (yield* DeliveryOutbox).load('slot-1'),
            };
          case 'journalProgress': {
            const receive = yield* ReceiveJournal,
              repair = yield* RepairJournal,
              distribution = yield* DistributionJournal;
            yield* receive.queueReport('receive-1', Uint8Array.of(19));
            yield* receive.markReported('receive-1');
            yield* repair.finish('repair-1', 'Repaired');
            yield* distribution.finish('distribution-1', 'Observed');
            return {
              receive: yield* receive.results(10),
              repair: yield* repair.results(null, 10),
              distribution: yield* distribution.results(null, 10),
            };
          }
          case 'read':
            return yield* store.read();
          case 'status':
            return yield* custody.status();
          case 'prepare':
            return yield* writer.run(
              store.compareAndSet(null, { binding, revision: 0, phase: 'prepared', wrapped: [] })
            );
          case 'wrapVectors': {
            const out = [];
            for (const item of fixture.vectors)
              out.push(
                hex(
                  yield* custody.wrap(
                    item.purpose as import('../../src/services').ClientKeyPurpose,
                    bytes(item.plaintextHex)
                  )
                )
              );
            return out;
          }
          case 'forkWrap': {
            const decided = yield* Deferred.make<void>();
            (globalThis as unknown as { notifyEntered: () => void }).notifyEntered = () =>
              Deferred.doneUnsafe(decided, Effect.void);
            const child = yield* writer.run(
              Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(
                  custody
                    .wrap('signing-private-key', secrets[0])
                    .pipe(Effect.onExit(() => Deferred.succeed(decided, undefined)))
                );
                yield* Deferred.await(decided);
                return fiber;
              })
            );
            (globalThis as unknown as { outerReturned: boolean }).outerReturned = true;
            return yield* Fiber.join(child);
          }
          case 'nestedWrap':
            return yield* writer.run(custody.wrap('signing-private-key', secrets[0]));
          case 'wrapEpoch':
            return yield* custody.wrap('installed-epoch-key', new Uint8Array(32).fill(0x44));
          case 'wrapSigning':
            return yield* custody.wrap('signing-private-key', secrets[0]);
          case 'create':
            return yield* custody.create();
          case 'protect': {
            const wrapped = [];
            for (const [i, purpose] of (
              ['signing-private-key', 'encryption-private-key', 'device-credential'] as const
            ).entries())
              wrapped.push({ purpose, blob: yield* custody.wrap(purpose, secrets[i]) });
            return yield* store.compareAndSet(0, {
              binding,
              revision: 1,
              phase: 'protected',
              wrapped,
            });
          }
          case 'open': {
            const row = yield* store.read();
            if (!row) throw new Error('missing receipt');
            const raw = [];
            try {
              for (const item of row.wrapped)
                raw.push(yield* custody.unwrap(item.purpose, item.blob));
              const device = yield* importBrowserDevice({
                signingPrivate: raw[0],
                encryptionPrivate: raw[1],
              });
              if (
                !device.publicKey.equals(binding.device) ||
                hex(device.enc.toBytes()) !== expectedEnc
              )
                throw new Error('wrong keys');
              if (expectedEnc === hpke.epoch.pkR) {
                const v = hpke.epoch,
                  context = {
                    genesis: Result.getOrThrow(Protocol.Bytes.genesisHash(bytes(v.genesis))),
                    epoch: Result.getOrThrow(Protocol.Bytes.epochNumber(v.epoch)),
                    sender: Result.getOrThrow(Protocol.Bytes.signingPublicKey(bytes(v.sender))),
                    recipient: Result.getOrThrow(
                      Protocol.Bytes.signingPublicKey(bytes(v.recipient))
                    ),
                  };
                const key = yield* Protocol.openEpochKeyHpke(
                  device.encryption,
                  device.enc,
                  context,
                  { enc: bytes(v.enc), ct: bytes(v.ct) }
                );
                try {
                  const opened = copyEpochKeyBytes(key);
                  try {
                    if (hex(opened) !== v.pt) throw new Error('wrong HPKE original');
                  } finally {
                    opened.fill(0);
                  }
                } finally {
                  disposeEpochKey(key);
                }
              }
              const message = Uint8Array.of(7, 9, 31),
                signature = yield* Protocol.signVerified(device, message);
              if (row.phase === 'protected')
                yield* store.compareAndSet(row.revision, {
                  ...row,
                  revision: row.revision + 1,
                  phase: 'ready',
                });
              return {
                publicKey: hex(device.publicKey.toBytes()),
                signature: hex(signature.toBytes()),
                credential: hex(raw[2]),
              };
            } finally {
              for (const body of raw) body.fill(0);
            }
          }
          case 'badTag':
          case 'badVersion': {
            const row = (yield* store.read())!,
              blob = new Uint8Array(row.wrapped[0].blob);
            if (action === 'badVersion') blob[0] = 2;
            else blob[blob.length - 1] ^= 1;
            return yield* custody.unwrap(row.wrapped[0].purpose, blob);
          }
          case 'wrongPurpose': {
            const row = yield* store.read();
            return yield* custody.unwrap('rotation-candidate', row!.wrapped[0].blob);
          }
          default:
            throw new Error('unknown action');
        }
      })
    ).pipe(Effect.provide(ports), Effect.provideService(Scope.Scope, scope))
  );
  return Result.isSuccess(result)
    ? { ok: true, value: own(result.success) }
    : { ok: false, reason: reason(result.failure) };
}
export async function stop() {
  if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
}
