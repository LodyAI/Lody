import { Effect, Result, Scope, Exit, Deferred, Fiber } from 'effect';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { runOwnedChild } from './native-child';
import { fileURLToPath } from 'node:url';
import { makeSqliteProtectedEpochKeys } from '@lody/e2ee-core/internal';
import { labSyntheticProtector } from '../src/platform/synthetic-protection';
import { join } from 'node:path';
import { StreamsClient } from '@loro-dev/streams-client';
import { makeLabLoroSession } from '../src/platform/content-session';
import { makeLabSdkOwner } from '../src/platform/sdk-owner';
import { makeLabDocumentStore } from '../src/platform/document-sqlite';
import { Flock } from '@loro-dev/flock-wasm';
import {
  StreamsCrdt as FlockStreamsCrdt,
  createFlockAdapter,
  type VersionVector,
} from '@loro-dev/streams-crdt/flock';
import { LoroDoc } from 'loro-crdt';
import {
  StreamsCrdt,
  createLoroDocAdapter,
  InMemoryRemoteCursorStore,
} from '@loro-dev/streams-crdt/loro';
import { Bytes } from '@lody/e2ee-core';
import { signGenesisRecord } from '@lody/e2ee-core/protocol';
import { hashRecordBytes, verifyLedger } from '@lody/e2ee-core/protocol';
import { makeLabUpdateProvider } from '../src/platform/content-provider';
import { fixture } from './ledger-fixture';
const ok = Result.getOrThrow;

describe('public update provider with released CRDT SDK', () => {
  it('syncs actual protected Loro updates between two SDK clients over real SQLite Riverrun', async () => {
    const f = await fixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const material = new Uint8Array(32).fill(71);
            const genesis = yield* signGenesisRecord({
              userId: ok(Bytes.userId(new Uint8Array(32).fill(72))),
              membershipId: f.membership,
              encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(73))),
              initialKey: ok(Bytes.epochKey(material)),
              signer: f.owner,
            });
            const view = ok(
              verifyLedger({
                anchor: genesis.genesis,
                records: [genesis.record],
                checkpoint: { head: hashRecordBytes(genesis.record), length: 1 },
              })
            );
            const keys = yield* makeSqliteProtectedEpochKeys({
              path: join(f.dir, 'content-keys.sqlite'),
              mode: 'create',
              genesis: genesis.genesis,
              recipient: f.owner.publicKey,
              ledger: () => Effect.succeed(view),
              protector: labSyntheticProtector,
            });
            yield* keys.saveAndReload(0, ok(Bytes.epochKey(material)));
            writeFileSync(join(f.dir, 'content-genesis.cbor'), genesis.record);
            const provider = yield* makeLabUpdateProvider({
              genesis: genesis.genesis,
              resource: 'document-A',
              model: 'loro',
              writeEpoch: 0,
              signer: f.owner,
              ledger: () => Effect.succeed(view),
              readEpochKey: keys.read,
            });
            const writerDoc = yield* Effect.acquireRelease(
              Effect.sync(() => new LoroDoc()),
              (doc) => Effect.sync(() => doc.free())
            );
            const readerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
              Scope.close(scope, Exit.void)
            );
            const readerDoc = yield* Effect.acquireRelease(
              Effect.sync(() => new LoroDoc()),
              (doc) => Effect.sync(() => doc.free())
            ).pipe(Effect.provideService(Scope.Scope, readerScope));
            const url = `${f.server.baseUrl}/ds/synthetic/content-A`;
            const writer = yield* makeLabSdkOwner(
              () =>
                new StreamsCrdt({
                  streamUrl: url,
                  adapter: createLoroDocAdapter(writerDoc),
                  remoteCursorStore: new InMemoryRemoteCursorStore(),
                  payloadProtectionRequired: true,
                  e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
                })
            );
            const path = join(f.dir, 'document-A.sqlite');
            const store = yield* makeLabDocumentStore({
              path,
              mode: 'create',
              genesis: Buffer.from(genesis.genesis.toBytes()).toString('hex'),
              resource: 'document-A',
              model: 'loro',
              streamUrl: url,
            }).pipe(Effect.provideService(Scope.Scope, readerScope));
            const reader = yield* makeLabSdkOwner(
              ({ assertOpen }) =>
                new StreamsCrdt({
                  streamUrl: url,
                  adapter: createLoroDocAdapter(readerDoc),
                  remoteCursorStore: store.cursorStore,
                  payloadProtectionRequired: true,
                  beforeRemoteCursorSave: async () => {
                    assertOpen();
                    ok(store.stage(readerDoc.export({ mode: 'snapshot' })));
                  },
                  e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
                })
            ).pipe(Effect.provideService(Scope.Scope, readerScope));
            expect((yield* writer.invoke((sdk) => sdk.createStream())).ok).toBe(true);
            writerDoc.getText('text').insert(0, 'synthetic protected update');
            writerDoc.commit();
            expect((yield* writer.invoke((sdk) => sdk.appendWriteOnly())).ok).toBe(true);
            const faultDb = new Database(path);
            try {
              faultDb.exec(
                'CREATE TRIGGER reject_actual_document BEFORE INSERT ON lab_document_state BEGIN SELECT RAISE(IGNORE); END'
              );
            } finally {
              faultDb.close();
            }
            expect((yield* reader.invoke((sdk) => sdk.sync())).ok).toBe(false);
            expect(yield* store.inspectCursor()).toBeNull();
            expect(yield* store.restore()).toBeNull();
            const repairDb = new Database(path);
            try {
              repairDb.exec('DROP TRIGGER reject_actual_document');
            } finally {
              repairDb.close();
            }
            expect((yield* reader.invoke((sdk) => sdk.sync())).ok).toBe(true);
            expect(yield* store.inspectCursor()).not.toBeNull();
            const reopened = new LoroDoc();
            try {
              reopened.import((yield* store.restore())!);
              expect(reopened.getText('text').toString()).toBe('synthetic protected update');
            } finally {
              reopened.free();
            }
            expect(readerDoc.getText('text').toString()).toBe('synthetic protected update');
            const prior = yield* store.inspectCursor();
            yield* Scope.close(readerScope, Exit.void);
            writerDoc.getText('text').insert(writerDoc.getText('text').length, ' + second');
            writerDoc.commit();
            expect((yield* writer.invoke((sdk) => sdk.appendWriteOnly())).ok).toBe(true);
            const child = yield* runOwnedChild([
              '--import',
              'tsx',
              fileURLToPath(new URL('./content-reopen.mts', import.meta.url)),
              f.dir,
              url,
              Buffer.from(genesis.genesis.toBytes()).toString('hex'),
              Buffer.from(f.owner.publicKey.toBytes()).toString('hex'),
            ]);
            const recovered = JSON.parse(child.trim()) as {
              text: string;
              cursor: { nextOffset: string };
            };
            expect(recovered.text).toBe('synthetic protected update + second');
            expect(recovered.cursor.nextOffset).not.toBe(prior!.nextOffset);
          })
        )
      );
    } finally {
      await f.close();
    }
  });
  it('awaits a real one-shot SDK operation before SDK close and Wasm free, refusing late output', async () => {
    const f = await fixture();
    let freed = false,
      rawSettled = false,
      closedEarly = false;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const provider = yield* makeLabUpdateProvider({
              genesis: f.anchor,
              resource: 'owned-empty',
              model: 'loro',
              writeEpoch: 0,
              signer: f.owner,
              ledger: () => Effect.succeed(f.view),
              readEpochKey: () => Effect.die('empty stream never reads key'),
            });
            const child = yield* Effect.acquireRelease(Scope.make(), (scope) =>
              Scope.close(scope, Exit.void)
            );
            const doc = yield* Effect.acquireRelease(
              Effect.sync(() => new LoroDoc()),
              (value) =>
                Effect.sync(() => {
                  value.free();
                  freed = true;
                })
            ).pipe(Effect.provideService(Scope.Scope, child));
            const entered = yield* Deferred.make<void>(),
              release = yield* Deferred.make<void>();
            const transport = yield* makeLabSdkOwner(({ assertOpen }) => {
              const sdk = new StreamsCrdt({
                streamUrl: `${f.server.baseUrl}/ds/synthetic/owned-empty`,
                adapter: createLoroDocAdapter(doc),
                payloadProtectionRequired: true,
                e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
                // Controlled native-fetch gate intentionally ignores abort. Actual HTTP/SDK remain real.
                fetch: async (url, init) => {
                  const response = await fetch(url, { ...init, signal: undefined });
                  if (url.includes('/bootstrap')) {
                    Effect.runSync(Deferred.succeed(entered, undefined));
                    await Effect.runPromise(Deferred.await(release));
                    try {
                      assertOpen();
                    } catch (error) {
                      await response.body?.cancel();
                      throw error;
                    }
                  }
                  return response;
                },
              });
              return {
                createStream: () => sdk.createStream(),
                sync: () => sdk.sync(),
                close: async () => {
                  // Observe real shutdown order, not a mock invocation count.
                  closedEarly = !rawSettled;
                  await sdk.close();
                },
              };
            }).pipe(Effect.provideService(Scope.Scope, child));
            expect((yield* transport.invoke((sdk) => sdk.createStream())).ok).toBe(true);
            const reading = yield* Effect.forkChild(
              Effect.result(
                transport.invoke((sdk) =>
                  sdk.sync().finally(() => {
                    rawSettled = true;
                  })
                )
              )
            );
            yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
            yield* Deferred.await(entered);
            const closing = yield* Effect.sync(() => Effect.runFork(Scope.close(child, Exit.void)));
            expect(
              Result.isFailure(yield* Effect.result(transport.invoke((sdk) => sdk.createStream())))
            ).toBe(true);
            expect(freed).toBe(false);
            yield* Deferred.succeed(release, undefined);
            expect(Result.isFailure(yield* Fiber.join(reading))).toBe(true);
            yield* Fiber.join(closing);
            expect(rawSettled).toBe(true);
            expect(closedEarly).toBe(false);
            expect(freed).toBe(true);
          })
        )
      );
    } finally {
      await f.close();
    }
  });
  it('consumes published Flock SDK with real protected updates and paired native-file/cursor persistence', async () => {
    const f = await fixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const material = new Uint8Array(32).fill(71);
            const genesis = yield* signGenesisRecord({
              userId: ok(Bytes.userId(new Uint8Array(32).fill(72))),
              membershipId: f.membership,
              encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(73))),
              initialKey: ok(Bytes.epochKey(material)),
              signer: f.owner,
            });
            const view = ok(
              verifyLedger({
                anchor: genesis.genesis,
                records: [genesis.record],
                checkpoint: { head: hashRecordBytes(genesis.record), length: 1 },
              })
            );
            const keys = yield* makeSqliteProtectedEpochKeys({
              path: join(f.dir, 'content-keys.sqlite'),
              mode: 'create',
              genesis: genesis.genesis,
              recipient: f.owner.publicKey,
              ledger: () => Effect.succeed(view),
              protector: labSyntheticProtector,
            });
            yield* keys.saveAndReload(0, ok(Bytes.epochKey(material)));
            writeFileSync(join(f.dir, 'content-genesis.cbor'), genesis.record);
            const readerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
              Scope.close(scope, Exit.void)
            );
            const provider = yield* makeLabUpdateProvider({
              genesis: genesis.genesis,
              resource: 'flock-A',
              model: 'flock',
              writeEpoch: 0,
              signer: f.owner,
              ledger: () => Effect.succeed(view),
              readEpochKey: keys.read,
            });
            // Public Flock0.4.3 has no dispose/free. Stop/await SDK and unsubscribe, then drop references;
            // this probe makes no deterministic native allocation deallocation claim.
            let writerDoc: Flock | undefined,
              readerDoc: Flock | undefined,
              restored: Flock | undefined;
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                writerDoc = new Flock('synthetic-flock-writer');
                readerDoc = new Flock('synthetic-flock-reader');
              }),
              () =>
                Effect.sync(() => {
                  writerDoc = undefined;
                  readerDoc = undefined;
                  restored = undefined;
                })
            );
            const url = `${f.server.baseUrl}/ds/synthetic/flock-A`;
            const store = yield* makeLabDocumentStore<VersionVector>({
              path: join(f.dir, 'flock-A.sqlite'),
              mode: 'create',
              genesis: Buffer.from(genesis.genesis.toBytes()).toString('hex'),
              resource: 'flock-A',
              model: 'flock',
              streamUrl: url,
            }).pipe(Effect.provideService(Scope.Scope, readerScope));
            const writer = yield* makeLabSdkOwner(
              () =>
                new FlockStreamsCrdt({
                  streamUrl: url,
                  adapter: createFlockAdapter(writerDoc!),
                  payloadProtectionRequired: true,
                  e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
                })
            );
            const reader = yield* makeLabSdkOwner(
              ({ assertOpen }) =>
                new FlockStreamsCrdt({
                  streamUrl: url,
                  adapter: createFlockAdapter(readerDoc!),
                  remoteCursorStore: store.cursorStore,
                  beforeRemoteCursorSave: async () => {
                    assertOpen();
                    ok(store.stage(readerDoc!.exportFile()));
                  },
                  payloadProtectionRequired: true,
                  e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
                })
            ).pipe(Effect.provideService(Scope.Scope, readerScope));
            expect((yield* writer.invoke((sdk) => sdk.createStream())).ok).toBe(true);
            writerDoc!.put(['private', 'note'], { value: 'synthetic flock update' }, 100);
            expect((yield* writer.invoke((sdk) => sdk.appendWriteOnly())).ok).toBe(true);
            expect((yield* reader.invoke((sdk) => sdk.catchup())).ok).toBe(true);
            expect(readerDoc!.get(['private', 'note'])).toEqual({
              value: 'synthetic flock update',
            });
            expect(yield* store.inspectCursor()).not.toBeNull();
            restored = Flock.fromFile((yield* store.restore())!, 'synthetic-restored-flock');
            expect(restored.get(['private', 'note'])).toEqual({ value: 'synthetic flock update' });
            const prior = yield* store.inspectCursor();
            yield* Scope.close(readerScope, Exit.void);
            readerDoc = undefined;
            restored = undefined;
            writerDoc!.put(['private', 'second'], { value: 'new process receives second' }, 101);
            expect((yield* writer.invoke((sdk) => sdk.appendWriteOnly())).ok).toBe(true);
            const child = yield* runOwnedChild([
              '--import',
              'tsx',
              fileURLToPath(new URL('./content-reopen.mts', import.meta.url)),
              f.dir,
              url,
              Buffer.from(genesis.genesis.toBytes()).toString('hex'),
              Buffer.from(f.owner.publicKey.toBytes()).toString('hex'),
              'flock',
            ]);
            const recovered = JSON.parse(child.trim()) as {
              value: { value: string };
              second: { value: string };
              restoredCursor: unknown;
              cursor: { nextOffset: string };
            };
            expect(recovered.value).toEqual({ value: 'synthetic flock update' });
            expect(recovered.second).toEqual({ value: 'new process receives second' });
            expect(recovered.restoredCursor).toEqual(prior);
            expect(recovered.cursor.nextOffset).not.toBe(prior!.nextOffset);
            const durable = yield* makeLabDocumentStore<VersionVector>({
              path: join(f.dir, 'flock-A.sqlite'),
              mode: 'open',
              genesis: Buffer.from(genesis.genesis.toBytes()).toString('hex'),
              resource: 'flock-A',
              model: 'flock',
              streamUrl: url,
            });
            const retainedState = yield* durable.restore();
            const retainedCursor = yield* durable.inspectCursor();
            // Real released Loro SDK seals a same-Org/resource, different-model update.
            // Appending that original protected wire into Flock must never import it.
            const crossProvider = yield* makeLabUpdateProvider({
              genesis: genesis.genesis,
              resource: 'flock-A',
              model: 'loro',
              writeEpoch: 0,
              signer: f.owner,
              ledger: () => Effect.succeed(view),
              readEpochKey: keys.read,
            });
            const crossDoc = yield* Effect.acquireRelease(
              Effect.sync(() => new LoroDoc()),
              (value) => Effect.sync(() => value.free())
            );
            const crossUrl = `${f.server.baseUrl}/ds/synthetic/flock-cross-loro`;
            const crossSdk = yield* makeLabSdkOwner(
              () =>
                new StreamsCrdt({
                  streamUrl: crossUrl,
                  adapter: createLoroDocAdapter(crossDoc),
                  payloadProtectionRequired: true,
                  e2ee: {
                    provider: crossProvider,
                    readPolicy: 'encrypted-only',
                    writePolicy: 'encrypt',
                  },
                })
            );
            expect((yield* crossSdk.invoke((sdk) => sdk.createStream())).ok).toBe(true);
            crossDoc.getText('text').insert(0, 'synthetic cross-model secret');
            crossDoc.commit();
            expect((yield* crossSdk.invoke((sdk) => sdk.appendWriteOnly())).ok).toBe(true);
            const rawSdk = yield* makeLabSdkOwner(() => ({
              source: new StreamsClient({ url: crossUrl, retry: { maxAttempts: 1 } }),
              target: new StreamsClient({ url, retry: { maxAttempts: 1 } }),
              close: async () => undefined, // HTTP facades: no protocol EOF during disposal.
            }));
            const wire = yield* rawSdk.invoke(({ source }) =>
              source.read({ offset: '-1', signal: rawSdk.signal })
            );
            expect(wire.ok).toBe(true);
            if (!wire.ok) throw new Error('synthetic protected wire unavailable');
            expect(
              (yield* rawSdk.invoke(({ target }) =>
                target.append({
                  part: {
                    contentType: 'application/octet-stream',
                    body: wire.result.payload.body,
                  },
                })
              )).ok
            ).toBe(true);
            const failed = yield* Effect.result(
              runOwnedChild([
                '--import',
                'tsx',
                fileURLToPath(new URL('./content-reopen.mts', import.meta.url)),
                f.dir,
                url,
                Buffer.from(genesis.genesis.toBytes()).toString('hex'),
                Buffer.from(f.owner.publicKey.toBytes()).toString('hex'),
                'flock',
              ])
            );
            expect(Result.isFailure(failed)).toBe(true);
            expect(yield* durable.restore()).toEqual(retainedState);
            expect(yield* durable.inspectCursor()).toEqual(retainedCursor);
          })
        )
      );
    } finally {
      await f.close();
    }
  });

  it('recovers a hostile snapshot through real encrypted history, retaining the durable pair on SQL failure and isolating documents', async () => {
    const f = await fixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const material = new Uint8Array(32).fill(81);
            const genesis = yield* signGenesisRecord({
              userId: ok(Bytes.userId(new Uint8Array(32).fill(82))),
              membershipId: f.membership,
              encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(83))),
              initialKey: ok(Bytes.epochKey(material)),
              signer: f.owner,
            });
            const view = ok(
              verifyLedger({
                anchor: genesis.genesis,
                records: [genesis.record],
                checkpoint: { head: hashRecordBytes(genesis.record), length: 1 },
              })
            );
            const common = {
              genesis: genesis.genesis,
              writeEpoch: 0,
              signer: f.owner,
              ledger: () => Effect.succeed(view),
              readEpochKey: () => Effect.sync(() => ok(Bytes.epochKey(material))),
              fetch: (url: string, init?: RequestInit) => fetch(url, init),
              mode: 'create' as const,
            };
            const url = `${f.server.baseUrl}/ds/synthetic/session-A`;
            const writer = yield* makeLabLoroSession({
              ...common,
              resource: 'session-A',
              streamUrl: url,
              path: join(f.dir, 'writer-A.sqlite'),
            });
            yield* writer.create();
            yield* writer.pull();
            const historyStart = yield* writer.cursor();
            yield* writer.append('remote A');
            yield* writer.pull();
            const published = yield* writer.cursor();
            expect(published).not.toBeNull();
            // Real Riverrun snapshot API stores attacker bytes; no invented protected snapshot format.
            const host = new StreamsClient({ url, retry: { maxAttempts: 1 } });
            const beforeSnapshot = yield* Effect.promise(() => host.read({ offset: '-1' }));
            expect(
              beforeSnapshot.ok && beforeSnapshot.result.payload.body.byteLength
            ).toBeGreaterThan(0);
            expect(yield* writer.text()).toBe('remote A');
            expect(
              (yield* Effect.promise(() =>
                host.putSnapshot({
                  offset: historyStart!.nextOffset,
                  part: {
                    contentType: 'application/octet-stream',
                    body: new Uint8Array([1, 2, 3]),
                  },
                })
              )).ok
            ).toBe(true);
            const path = join(f.dir, 'reader-A.sqlite');
            const reader = yield* makeLabLoroSession({
              ...common,
              resource: 'session-A',
              streamUrl: url,
              path,
            });
            // Automatic verified-history fallback reaches the real SQL barrier.
            // Refusing that write must retain both halves of the prior durable pair.
            const fault = new Database(path);
            try {
              fault.exec(
                'CREATE TRIGGER reject_recovery BEFORE INSERT ON lab_document_state BEGIN SELECT RAISE(IGNORE); END'
              );
            } finally {
              fault.close();
            }
            expect(Exit.isFailure(yield* Effect.exit(reader.pull()))).toBe(true);
            expect(yield* reader.status()).toBe('document-stopped');
            expect(yield* reader.cursor()).toBeNull();
            const other = yield* makeLabLoroSession({
              ...common,
              resource: 'session-B',
              streamUrl: `${f.server.baseUrl}/ds/synthetic/session-B`,
              path: join(f.dir, 'reader-B.sqlite'),
            });
            yield* other.create();
            yield* other.append('independent B');
            yield* other.pull();
            expect(yield* other.text()).toBe('independent B');
            expect(Exit.isFailure(yield* Effect.exit(reader.recoverFromFullHistory()))).toBe(true);
            expect(yield* reader.cursor()).toBeNull();
            expect(yield* reader.status()).toBe('document-stopped');
            const repair = new Database(path);
            try {
              expect(repair.prepare('SELECT count(*) AS n FROM lab_document_state').get()).toEqual({
                n: 0,
              });
              repair.exec('DROP TRIGGER reject_recovery');
            } finally {
              repair.close();
            }
            yield* reader.recoverFromFullHistory();
            expect(yield* reader.text()).toBe('remote A');
            expect(yield* reader.status()).toBe('active');
            expect((yield* reader.cursor())!.nextOffset).toBe(published!.nextOffset);
            expect(yield* other.status()).toBe('active');
            const stillHosted = yield* Effect.promise(() => host.bootstrap());
            expect(stillHosted.ok && stillHosted.result.snapshot?.body).toEqual(
              new Uint8Array([1, 2, 3])
            );
            // A failed local publish keeps real durable local CRDT edits. Recovery only reads;
            // the intentionally unavailable signing capability is never needed to replay history.
            const local = yield* makeLabLoroSession({
              ...common,
              resource: 'session-A',
              streamUrl: url,
              path: join(f.dir, 'local-A.sqlite'),
              signer: {
                publicKey: f.owner.publicKey,
                sign: () => Effect.die('synthetic signing unavailable'),
              },
            });
            expect(Exit.isFailure(yield* Effect.exit(local.append('local A')))).toBe(true);
            expect(yield* local.status()).toBe('active');
            expect(yield* local.cursor()).toBeNull();
            yield* local.recoverFromFullHistory();
            const preserved = yield* local.text();
            expect(preserved).toContain('local A');
            expect(preserved).toContain('remote A');
            // Actual Riverrun snapshot publication at tail changes earliest_offset. No client may
            // fabricate success when the public history endpoint no longer supplies that prefix.
            expect(
              (yield* Effect.promise(() =>
                host.putSnapshot({
                  offset: published!.nextOffset,
                  part: {
                    contentType: 'application/octet-stream',
                    body: new Uint8Array([4, 5, 6]),
                  },
                })
              )).ok
            ).toBe(true);
            const unavailable = yield* makeLabLoroSession({
              ...common,
              resource: 'session-A',
              streamUrl: url,
              path: join(f.dir, 'unavailable-A.sqlite'),
            });
            expect(Exit.isFailure(yield* Effect.exit(unavailable.pull()))).toBe(true);
            expect(Exit.isFailure(yield* Effect.exit(unavailable.recoverFromFullHistory()))).toBe(
              true
            );
            expect(yield* unavailable.status()).toBe('active');
            expect(yield* unavailable.cursor()).toBeNull();
            expect(yield* other.status()).toBe('active');
          })
        )
      );
    } finally {
      await f.close();
    }
  });
});

it('a real SDK provider defect remains a harness failure instead of an expected crypto rejection', async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeLabLoroSession({
            path: join(f.dir, 'provider-defect.sqlite'),
            mode: 'create',
            streamUrl: `${f.server.baseUrl}/ds/synthetic/provider-defect`,
            fetch,
            genesis: f.anchor,
            resource: 'document',
            writeEpoch: 0,
            signer: f.owner,
            ledger: () => Effect.die(new Error('synthetic provider implementation defect')),
            readEpochKey: () => Effect.die('must not read a key after ledger defect'),
          });
          yield* session.create();
          const result = yield* Effect.result(session.append('local original'));
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure).toMatchObject({ _tag: 'LabProviderError', code: 'harness' });
          expect(yield* session.status()).toBe('active');
        })
      )
    );
  } finally {
    await f.close();
  }
});

it('keeps transport and permission failures retryable while stopping authenticated remote corruption', async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const material = new Uint8Array(32).fill(91);
          const genesis = yield* signGenesisRecord({
            userId: ok(Bytes.userId(new Uint8Array(32).fill(92))),
            membershipId: f.membership,
            encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(93))),
            initialKey: ok(Bytes.epochKey(material)),
            signer: f.owner,
          });
          const view = ok(
            verifyLedger({
              anchor: genesis.genesis,
              records: [genesis.record],
              checkpoint: { head: hashRecordBytes(genesis.record), length: 1 },
            })
          );
          const url = `${f.server.baseUrl}/ds/synthetic/retryable-content`;
          const common = {
            genesis: genesis.genesis,
            writeEpoch: 0,
            signer: f.owner,
            ledger: () => Effect.succeed(view),
            readEpochKey: () => Effect.sync(() => ok(Bytes.epochKey(material))),
            mode: 'create' as const,
            resource: 'retryable-content',
            streamUrl: url,
          };
          const writer = yield* makeLabLoroSession({
            ...common,
            fetch,
            path: join(f.dir, 'retry-writer.sqlite'),
          });
          yield* writer.create();
          yield* writer.append('retained authentic content');
          let fault: 'network' | number | undefined;
          const reader = yield* makeLabLoroSession({
            ...common,
            path: join(f.dir, 'retry-reader.sqlite'),
            fetch: async (input, init) => {
              if (fault === 'network') throw new TypeError('synthetic connection reset');
              if (typeof fault === 'number')
                return new Response('synthetic refusal', { status: fault });
              return fetch(input, init);
            },
          });
          for (const [injected, code] of [
            ['network', 'network_error'],
            [502, 'server_error'],
            [409, 'protocol_error'],
            [403, 'auth_failed'],
          ] as const) {
            fault = injected;
            const failed = yield* Effect.result(reader.pull());
            expect(Result.isFailure(failed)).toBe(true);
            if (Result.isFailure(failed))
              expect(failed.failure).toMatchObject({ _tag: 'LabContentError', code });
            expect(yield* reader.status()).toBe('active');
            expect(yield* reader.text()).toBe(
              injected === 'network' ? '' : 'retained authentic content'
            );
            fault = undefined;
            yield* reader.pull();
            expect(yield* reader.status()).toBe('active');
            expect(yield* reader.text()).toBe('retained authentic content');
          }
          const raw = new StreamsClient({ url, retry: { maxAttempts: 1 } });
          const original = yield* Effect.promise(() => raw.read({ offset: '-1' }));
          if (!original.ok) throw new Error('actual protected frame required');
          const changed = new Uint8Array(original.result.payload.body);
          changed[changed.length - 1] ^= 1;
          expect(
            (yield* Effect.promise(() =>
              raw.append({ part: { contentType: 'application/octet-stream', body: changed } })
            )).ok
          ).toBe(true);
          const tampered = yield* Effect.result(reader.pull());
          expect(Result.isFailure(tampered)).toBe(true);
          if (Result.isFailure(tampered))
            expect(tampered.failure).toMatchObject({ code: 'decrypt_failed' });
          expect(yield* reader.status()).toBe('document-stopped');
          const malformedUrl = `${f.server.baseUrl}/ds/synthetic/malformed-content`;
          const malformedRemote = new StreamsClient({
            url: malformedUrl,
            retry: { maxAttempts: 1 },
          });
          expect((yield* Effect.promise(() => malformedRemote.create())).ok).toBe(true);
          expect(
            (yield* Effect.promise(() =>
              malformedRemote.append({
                part: {
                  contentType: 'application/octet-stream',
                  body: new Uint8Array([1, 2, 3, 4]),
                },
              })
            )).ok
          ).toBe(true);
          const malformedReader = yield* makeLabLoroSession({
            ...common,
            streamUrl: malformedUrl,
            path: join(f.dir, 'malformed-reader.sqlite'),
            fetch,
          });
          const malformedResult = yield* Effect.result(malformedReader.pull());
          expect(Result.isFailure(malformedResult)).toBe(true);
          expect(yield* malformedReader.status()).toBe('document-stopped');
        })
      )
    );
  } finally {
    await f.close();
  }
});
