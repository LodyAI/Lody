import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Deferred, Effect, Exit, Fiber, Result, Scope } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { StreamsClient } from '@loro-dev/streams-client';
import { Bytes } from '@lody/e2ee-core';
import {
  signGenesisRecord,
  prepareDeviceAdmission,
  prepareLedgerCommand,
} from '@lody/e2ee-core/protocol';
import { extendLedger, hashRecordBytes, verifyLedger } from '@lody/e2ee-core/protocol';
import { prepareLedgerRecord, signLedgerRecord } from '@lody/e2ee-core/protocol';
import { makeStreamsUpdateBinding } from '@lody/e2ee-core/adapters/loro-streams';
import { commitEpochKey, sealHistoryPacket } from '@lody/e2ee-core/protocol';
import { encodeCbor } from '@lody/e2ee-core/protocol';
import { makeSqliteProtectedEpochKeys } from '@lody/e2ee-core/internal';
import { makeSqliteSnapshotPublication } from '@lody/e2ee-core/adapters/node-sqlite';
import { makeLabLoroSession } from '../src/platform/content-session';
import { makeLabFlockSession } from '../src/platform/flock-session';
import { makeLabContentGateway } from '../src/platform/content-gateway';
import { makeLabRiverrunSnapshotBoundary } from '../src/platform/snapshot-boundary';
import { labSyntheticProtector } from '../src/platform/synthetic-protection';
import { fixture, history } from './ledger-fixture';
import { generateDevice } from '../src/platform/device';

const ok = Result.getOrThrow;
describe('current content-v0 protected snapshots with the released SDK', () => {
  it.each(['loro', 'flock'] as const)(
    'uploads and bootstraps %s, authenticates the host position and preserves failed durable reads',
    async (model) => {
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
              const ledger = () => Effect.succeed(view);
              const keys = yield* makeSqliteProtectedEpochKeys({
                path: join(f.dir, 'keys.sqlite'),
                mode: 'create',
                genesis: genesis.genesis,
                recipient: f.owner.publicKey,
                ledger,
                protector: labSyntheticProtector,
              });
              yield* keys.saveAndReload(0, ok(Bytes.epochKey(material)));
              const org = Buffer.from(genesis.genesis.toBytes()).toString('hex');
              expect(
                (yield* Effect.promise(() =>
                  fetch(`${f.server.baseUrl}/ds/${org}`, { method: 'PUT' })
                )).ok
              ).toBe(true);
              const url = `${f.server.baseUrl}/ds/${org}/${model}`;
              const common = {
                genesis: genesis.genesis,
                resource: 'snapshot-document',
                writeEpoch: 'current' as const,
                signer: f.owner,
                ledger,
                readEpochKey: keys.read,
                fetch,
                streamUrl: url,
                mode: 'create' as const,
              };
              let time = 100;
              const session = (file: string, upload = false, transport: typeof fetch = fetch) =>
                model === 'loro'
                  ? makeLabLoroSession({
                      ...common,
                      fetch: transport,
                      path: join(f.dir, file),
                      snapshotUpload: upload,
                    })
                  : makeLabFlockSession({
                      ...common,
                      fetch: transport,
                      path: join(f.dir, file),
                      snapshotUpload: upload,
                      replica: file,
                      now: () => time++,
                    });
              const writer = yield* session('writer.sqlite', true);
              yield* writer.create();
              yield* writer.append('before snapshot');
              const publication = yield* writer.uploadSnapshot();
              const raw = new StreamsClient({ url, retry: { maxAttempts: 1 } });
              const bootstrap = yield* Effect.promise(() => raw.bootstrap());
              expect(bootstrap.ok).toBe(true);
              if (!bootstrap.ok || !bootstrap.result.snapshot)
                throw new Error('missing protected snapshot');
              const body = new Uint8Array(bootstrap.result.snapshot.body);
              expect(body[5]).toBe(2);
              expect(body[10]).toBe(4);
              expect(bootstrap.result.snapshotOffset).toBe(publication.snapshotOffset);
              const reader = yield* session('reader.sqlite');
              yield* reader.pull();
              expect(yield* reader.text()).toBe('before snapshot');
              expect((yield* reader.cursor())?.nextOffset).toBe(publication.snapshotOffset);
              yield* writer.append(' after snapshot');
              yield* reader.pull();
              expect(yield* reader.text()).toBe('before snapshot after snapshot');
              const tailAfterSuffix = yield* Effect.promise(() => raw.head());
              if (!tailAfterSuffix.ok) throw new Error('missing actual suffix head');
              // Move an authentic old snapshot to a later existing position, or alter
              // its signed raw offset bytes. Neither failure may persist native state
              // or advance the exact durable SDK cursor.
              for (const attack of ['move-context', 'tamper-content-offset'] as const) {
                let writes = 0,
                  modified = false;
                const hostile: typeof fetch = async (target, init) => {
                  if (init?.method === 'PUT' || init?.method === 'POST') writes++;
                  const reply = await fetch(target, init);
                  if (!String(target).endsWith('/bootstrap')) return reply;
                  modified = true;
                  const bytes = new Uint8Array(await reply.arrayBuffer());
                  const headers = new Headers(reply.headers);
                  if (attack === 'move-context') {
                    headers.set('stream-snapshot-offset', tailAfterSuffix.result.nextOffset);
                  } else {
                    const at = Buffer.from(bytes).indexOf(body);
                    if (at < 0) throw new Error('missing original encrypted snapshot in bootstrap');
                    bytes[at + 11 + 41] ^= 1;
                  }
                  return new Response(bytes, { status: reply.status, headers });
                };
                const attacked = yield* session(`${attack}.sqlite`, false, hostile);
                const refused = yield* Effect.result(attacked.pull());
                expect(Result.isFailure(refused) && refused.failure).toMatchObject({
                  _tag: 'LabContentError',
                  code: 'decrypt_failed',
                });
                expect(modified).toBe(true);
                expect(writes).toBe(0);
                expect(yield* attacked.cursor()).toBeNull();
                const durable = new Database(join(f.dir, `${attack}.sqlite`), { readonly: true });
                try {
                  expect(
                    durable.prepare('SELECT count(*) AS n FROM lab_document_state').get()
                  ).toEqual({ n: 0 });
                } finally {
                  durable.close();
                }
              }
              const remoteStorage = new Database(f.server.dbPath, { readonly: true });
              try {
                const rows = remoteStorage
                  .prepare(`SELECT body FROM entries UNION ALL SELECT body FROM snapshots`)
                  .all() as { body: Uint8Array }[];
                for (const row of rows) {
                  expect(Buffer.from(row.body).includes(Buffer.from('before snapshot'))).toBe(
                    false
                  );
                  expect(Buffer.from(row.body).includes(Buffer.from('after snapshot'))).toBe(false);
                }
              } finally {
                remoteStorage.close();
              }
              const snapshotStore = yield* makeSqliteSnapshotPublication({
                path: join(f.dir, 'snapshot-admission.sqlite'),
                mode: 'create',
                genesis: genesis.genesis,
                resource: common.resource,
                model,
              });
              const gateway = yield* makeLabContentGateway({
                genesis: genesis.genesis,
                resource: common.resource,
                model,
                baseUrl: f.server.baseUrl,
                ledger,
                snapshotStore,
                snapshotBoundary: yield* makeLabRiverrunSnapshotBoundary({
                  baseUrl: f.server.baseUrl,
                  genesis: genesis.genesis,
                  model,
                }),
                now: () => 0,
              });
              const request = {
                credential: {
                  account: 'synthetic-owner',
                  token: '',
                  issuedAt: 0,
                  expiresAt: 1,
                  device: f.owner.publicKey,
                  genesis: genesis.genesis,
                },
                requestGenesis: genesis.genesis,
                body,
                continuationOffset: publication.snapshotOffset,
              };
              expect((yield* gateway.snapshot(request)).status).toBe(204);
              expect(
                Result.isFailure(
                  yield* Effect.result(
                    gateway.snapshot({
                      ...request,
                      continuationOffset: publication.snapshotOffset + '-different',
                    })
                  )
                )
              ).toBe(true);
              expect(
                Result.isFailure(
                  yield* Effect.result(
                    gateway.snapshot({
                      ...request,
                      credential: { ...request.credential, device: history(88).owner.publicKey },
                    })
                  )
                )
              ).toBe(true);
              const damaged = new Uint8Array(body);
              damaged[damaged.length - 1] ^= 1;
              expect(
                Result.isFailure(
                  yield* Effect.result(gateway.snapshot({ ...request, body: damaged }))
                )
              ).toBe(true);
              const still = yield* Effect.promise(() => raw.bootstrap());
              expect(still.ok && still.result.snapshot?.body).toEqual(body);
              const failed = yield* session('failed.sqlite');
              const db = new Database(join(f.dir, 'failed.sqlite'));
              try {
                db.exec(
                  'CREATE TRIGGER ignore_snapshot_state BEFORE INSERT ON lab_document_state BEGIN SELECT RAISE(IGNORE);END'
                );
                expect(Result.isFailure(yield* Effect.result(failed.pull()))).toBe(true);
                expect(yield* failed.cursor()).toBeNull();
                expect(db.prepare('SELECT count(*) AS n FROM lab_document_state').get()).toEqual({
                  n: 0,
                });
                db.exec('DROP TRIGGER ignore_snapshot_state');
              } finally {
                db.close();
              }
              // This host retained only the snapshot suffix. Retry it explicitly; never
              // rewrite earliest_offset or claim full-history recovery exists here.
              yield* failed.recoverFromFullHistory();
              expect(yield* failed.text()).toBe('before snapshot after snapshot');
              expect(yield* failed.cursor()).not.toBeNull();
            })
          )
        );
      } finally {
        await f.close();
      }
    }
  );
});

it.each(['publish-epoch', 'revoke-author'] as const)(
  'rechecks snapshot admission after %s during actual native signature verification',
  async (transition) => {
    const f = await fixture(),
      owner = f.owner,
      directory = f.dir;
    let forwarded = false;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const old = ok(Bytes.epochKey(new Uint8Array(32).fill(61))),
              next = ok(Bytes.epochKey(new Uint8Array(32).fill(62)));
            const genesis = yield* signGenesisRecord({
              userId: ok(Bytes.userId(new Uint8Array(32).fill(63))),
              membershipId: ok(Bytes.membershipId(new Uint8Array(16).fill(64))),
              encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(65))),
              initialKey: old,
              signer: owner,
            });
            let view = ok(
              verifyLedger({
                anchor: genesis.genesis,
                records: [genesis.record],
                checkpoint: { head: hashRecordBytes(genesis.record), length: 1 },
              })
            );
            const companion = yield* generateDevice();
            const consent = yield* prepareDeviceAdmission({
              genesis: genesis.genesis,
              membershipId: ok(Bytes.membershipId(new Uint8Array(16).fill(64))),
              encryptionPublicKey: companion.enc,
              kind: 'personal',
              signer: companion,
            });
            const admission = yield* signLedgerRecord(
              ok(prepareLedgerCommand(view, owner.publicKey, consent)),
              owner
            );
            view = ok(
              extendLedger(view, [admission], {
                head: hashRecordBytes(admission),
                length: view.length + 1,
              })
            );
            const org = Buffer.from(genesis.genesis.toBytes()).toString('hex');
            expect(
              (yield* Effect.promise(() =>
                fetch(`${f.server.baseUrl}/ds/${org}`, { method: 'PUT' })
              )).ok
            ).toBe(true);
            const raw = new StreamsClient({
              url: `${f.server.baseUrl}/ds/${org}/loro`,
              retry: { maxAttempts: 1 },
            });
            expect(
              (yield* Effect.promise(() => raw.create({ contentType: 'application/octet-stream' })))
                .ok
            ).toBe(true);
            const head = yield* Effect.promise(() => raw.head());
            if (!head.ok) throw new Error('missing real native head');
            const binding = yield* makeStreamsUpdateBinding({
              genesis: genesis.genesis,
              resource: 'document',
              model: 'loro',
              writeEpoch: 'current',
              signer: owner,
              ledger: () => Effect.succeed(view),
              readEpochKey: () =>
                Effect.sync(() => ok(Bytes.epochKey(new Uint8Array(32).fill(61)))),
            });
            const context = {
              protocol: 'loro-streams-crdt-payload-protection',
              version: 2,
              kind: 'snapshot',
              continuationOffset: head.result.nextOffset,
            } as const;
            let prefix!: Uint8Array;
            const sealed = yield* binding.seal({
              context,
              plaintext: new Uint8Array(9000).fill(10),
              additionalData: (header) => {
                prefix = new Uint8Array(10 + header.length);
                prefix.set([76, 83, 67, 69, 2, 2, 0, 0, 0, 0]);
                new DataView(prefix.buffer).setUint16(6, header.length, false);
                prefix.set(header, 10);
                return new Uint8Array(
                  Buffer.concat([
                    new TextEncoder().encode('loro-streams-crdt-payload-protection/v2\0'),
                    prefix,
                  ])
                );
              },
            });
            const snapshotStore = yield* makeSqliteSnapshotPublication({
              path: join(directory, 'admission.sqlite'),
              mode: 'create',
              genesis: genesis.genesis,
              resource: 'document',
              model: 'loro',
            });
            const gateway = yield* makeLabContentGateway({
              genesis: genesis.genesis,
              resource: 'document',
              model: 'loro',
              baseUrl: f.server.baseUrl,
              ledger: () => Effect.succeed(view),
              snapshotStore,
              snapshotBoundary: yield* makeLabRiverrunSnapshotBoundary({
                baseUrl: f.server.baseUrl,
                genesis: genesis.genesis,
                model: 'loro',
              }),
              now: () => 0,
              fetch: async (url, init) => {
                if (init?.method === 'PUT') forwarded = true;
                return fetch(url, init);
              },
            });
            const original = new Uint8Array(Buffer.concat([prefix, sealed.sealed]));
            const entered = yield* Deferred.make<void>(),
              release = yield* Deferred.make<void>();
            const native = crypto.subtle.verify.bind(crypto.subtle);
            let verifications = 0;
            const spy = vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
              const valid = await native(...args);
              // Hold admission's real native verification after it captured the
              // writer view; historical authentication was the first large call.
              if (args[3].byteLength > 8192 && ++verifications === 2) {
                Deferred.doneUnsafe(entered, Effect.void);
                await Effect.runPromise(Deferred.await(release));
              }
              return valid;
            });
            yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
            const pending = yield* Effect.forkChild(
              Effect.result(
                gateway.snapshot({
                  credential: {
                    account: 'synthetic-owner',
                    token: '',
                    issuedAt: 0,
                    expiresAt: 1,
                    device: owner.publicKey,
                    genesis: genesis.genesis,
                  },
                  requestGenesis: genesis.genesis,
                  continuationOffset: context.continuationOffset,
                  body: original,
                })
              )
            );
            yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
            yield* Deferred.await(entered);
            const record = yield* Effect.gen(function* () {
              if (transition === 'revoke-author')
                return yield* signLedgerRecord(
                  ok(
                    prepareLedgerCommand(view, companion.publicKey, {
                      _tag: 'RevokeDevice',
                      target: owner.publicKey,
                    })
                  ),
                  companion
                );
              const body = ok(
                encodeCbor([
                  view.head.toBytes(),
                  owner.publicKey.toBytes(),
                  [
                    7,
                    1,
                    ok(commitEpochKey(genesis.genesis, 1, next)).toBytes(),
                    ok(
                      sealHistoryPacket({
                        genesis: genesis.genesis,
                        epoch: 1,
                        currentKey: next,
                        previousKey: old,
                      })
                    ),
                  ],
                ])
              );
              return yield* signLedgerRecord(ok(prepareLedgerRecord(view, body)), owner);
            });
            view = ok(
              extendLedger(view, [record], {
                head: hashRecordBytes(record),
                length: view.length + 1,
              })
            );
            yield* Deferred.succeed(release, undefined);
            const result = yield* Fiber.join(pending);
            const nativeSnapshot = yield* Effect.promise(() => raw.readLatestSnapshot());
            expect(nativeSnapshot.ok).toBe(true);
            if (transition === 'publish-epoch') {
              expect(Result.isSuccess(result)).toBe(true);
              expect(ok(result).status).toBe(204);
              expect(forwarded).toBe(true);
              if (!nativeSnapshot.ok || !nativeSnapshot.result)
                throw new Error('missing accepted snapshot');
              expect(nativeSnapshot.result.snapshotOffset).toBe(context.continuationOffset);
              expect(new Uint8Array(nativeSnapshot.result.payload.body)).toEqual(original);
              expect(yield* snapshotStore.lookup(context.continuationOffset)).toMatchObject({
                phase: 'Accepted',
                offset: context.continuationOffset,
                body: original,
              });
              expect((yield* snapshotStore.current())?.offset).toBe(context.continuationOffset);
            } else {
              expect(Result.isFailure(result) && result.failure).toMatchObject({
                _tag: 'ContentError',
                code: 'unauthorized',
              });
              expect(forwarded).toBe(false);
              expect(nativeSnapshot.ok && nativeSnapshot.result).toBeNull();
              // HEAD/reservation already settled, so preserve the pending exact
              // original without publishing or advancing the accepted pointer.
              expect(yield* snapshotStore.lookup(context.continuationOffset)).toMatchObject({
                phase: 'Pending',
                offset: context.continuationOffset,
                body: original,
              });
              expect(yield* snapshotStore.current()).toBeNull();
            }
          })
        )
      );
    } finally {
      await f.close();
    }
  }
);

it('reopens an uncertain snapshot and confirms only its original bytes; older receipts never republish', async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const secret = new Uint8Array(32).fill(101);
          const genesis = yield* signGenesisRecord({
            userId: ok(Bytes.userId(new Uint8Array(32).fill(102))),
            membershipId: f.membership,
            encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(103))),
            initialKey: ok(Bytes.epochKey(secret)),
            signer: f.owner,
          });
          const view = ok(
            verifyLedger({
              anchor: genesis.genesis,
              records: [genesis.record],
              checkpoint: { head: hashRecordBytes(genesis.record), length: 1 },
            })
          );
          const ledger = () => Effect.succeed(view),
            org = Buffer.from(genesis.genesis.toBytes()).toString('hex');
          expect(
            (yield* Effect.promise(() => fetch(`${f.server.baseUrl}/ds/${org}`, { method: 'PUT' })))
              .ok
          ).toBe(true);
          const raw = new StreamsClient({
            url: `${f.server.baseUrl}/ds/${org}/loro`,
            retry: { maxAttempts: 1 },
          });
          expect(
            (yield* Effect.promise(() => raw.create({ contentType: 'application/octet-stream' })))
              .ok
          ).toBe(true);
          const binding = yield* makeStreamsUpdateBinding({
            genesis: genesis.genesis,
            resource: 'durable-snapshot',
            model: 'loro',
            writeEpoch: 'current',
            signer: f.owner,
            ledger,
            readEpochKey: () => Effect.sync(() => ok(Bytes.epochKey(secret))),
          });
          const sealedAt = Effect.fnUntraced(function* (offset: string) {
            let prefix!: Uint8Array;
            const sealed = yield* binding.seal({
              context: {
                protocol: 'loro-streams-crdt-payload-protection',
                version: 2,
                kind: 'snapshot',
                continuationOffset: offset,
              },
              plaintext: new TextEncoder().encode('synthetic storage-admission payload'),
              additionalData: (header) => {
                prefix = new Uint8Array(10 + header.length);
                prefix.set([76, 83, 67, 69, 2, 2, 0, 0, 0, 0]);
                new DataView(prefix.buffer).setUint16(6, header.length, false);
                prefix.set(header, 10);
                return new Uint8Array(
                  Buffer.concat([
                    new TextEncoder().encode('loro-streams-crdt-payload-protection/v2\0'),
                    prefix,
                  ])
                );
              },
            });
            return new Uint8Array(Buffer.concat([prefix, sealed.sealed]));
          });
          const head = yield* Effect.promise(() => raw.head());
          if (!head.ok) throw new Error('missing native tail');
          const offset = head.result.nextOffset,
            original = yield* sealedAt(offset),
            file = join(f.dir, 'publication.sqlite');
          // Preserve a snapshot of an earlier real boundary while the host grows.
          // The gateway must admit that boundary without ordering opaque tokens.
          expect(
            (yield* Effect.promise(() =>
              raw.append({
                part: { contentType: 'application/octet-stream', body: new Uint8Array([7, 8, 9]) },
              })
            )).ok
          ).toBe(true);
          const credential = {
            account: 'synthetic-owner',
            token: 'first-authenticated-token',
            issuedAt: 0,
            expiresAt: 100,
            device: f.owner.publicKey,
            genesis: genesis.genesis,
          };
          let puts = 0,
            clock = 0,
            expireAtHead = false;
          const make = Effect.fnUntraced(function* (mode: 'create' | 'open', loseAck: boolean) {
            const store = yield* makeSqliteSnapshotPublication({
              path: file,
              mode,
              genesis: genesis.genesis,
              resource: 'durable-snapshot',
              model: 'loro',
            });
            const gateway = yield* makeLabContentGateway({
              genesis: genesis.genesis,
              resource: 'durable-snapshot',
              model: 'loro',
              baseUrl: f.server.baseUrl,
              ledger,
              snapshotStore: store,
              snapshotBoundary: yield* makeLabRiverrunSnapshotBoundary({
                baseUrl: f.server.baseUrl,
                genesis: genesis.genesis,
                model: 'loro',
              }),
              now: () => clock,
              fetch: async (url, init) => {
                const reply = await fetch(url, init);
                if (init?.method === 'HEAD' && expireAtHead) clock = 1000;
                if (init?.method === 'PUT') {
                  puts++;
                  if (loseAck) {
                    await reply.arrayBuffer();
                    throw new Error('synthetic ACK lost after native commit');
                  }
                }
                return reply;
              },
            });
            return { store, gateway };
          });
          const firstScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
            Scope.close(scope, Exit.void)
          );
          const first = yield* make('create', true).pipe(
            Effect.provideService(Scope.Scope, firstScope)
          );
          const request = {
            credential,
            requestGenesis: genesis.genesis,
            continuationOffset: offset,
            body: original,
          };
          const nativeDb = new Database(f.server.dbPath, { readonly: true });
          let invalidPositions: string[];
          try {
            const row = nativeDb
              .prepare(
                `SELECT printf('%020d', next_offset + 1) AS ahead FROM streams WHERE bucket_id = ? AND stream_id = 'loro'`
              )
              .get(org) as { ahead: string };
            const middle = nativeDb
              .prepare(
                `SELECT printf('%020d', start_offset + 1) AS middle FROM entries e JOIN streams s ON s.id = e.stream_id_fk WHERE s.bucket_id = ? AND s.stream_id = 'loro' ORDER BY e.id LIMIT 1`
              )
              .get(org) as { middle: string };
            invalidPositions = [row.ahead, middle.middle, 'not-a-native-position'];
          } finally {
            nativeDb.close();
          }
          for (const invalid of invalidPositions) {
            const refused = yield* Effect.result(
              first.gateway.snapshot({
                ...request,
                continuationOffset: invalid,
                body: yield* sealedAt(invalid),
              })
            );
            expect(Result.isFailure(refused) && refused.failure).toMatchObject({
              _tag: 'LabContentGatewayError',
              status: 409,
            });
            expect(puts).toBe(0);
            expect(yield* first.store.pending()).toBeNull();
            const unchanged = yield* Effect.promise(() => raw.readLatestSnapshot());
            expect(unchanged.ok && unchanged.result).toBeNull();
          }
          expect(Result.isFailure(yield* Effect.result(first.gateway.snapshot(request)))).toBe(
            true
          );
          expect((yield* first.store.pending())?.body).toEqual(original);
          expect(puts).toBe(1);
          yield* Scope.close(firstScope, Exit.void);
          const reopened = yield* make('open', false),
            renewed = { ...credential, token: 'new-authenticated-token' };
          expect(
            (yield* reopened.gateway.resumeSnapshot({
              credential: renewed,
              requestGenesis: genesis.genesis,
            })).status
          ).toBe(204);
          expect(yield* reopened.store.pending()).toBeNull();
          expect((yield* reopened.store.lookup(offset))?.phase).toBe('Accepted');
          expect(puts).toBe(1);
          const different = yield* sealedAt(offset);
          expect(different).not.toEqual(original);
          expect(
            Result.isFailure(
              yield* Effect.result(
                reopened.gateway.snapshot({ ...request, credential: renewed, body: different })
              )
            )
          ).toBe(true);
          expect(puts).toBe(1);
          // A raw opaque transport marker advances the native boundary; this test
          // asserts publication identity/retry, not CRDT import of that marker.
          expect(
            (yield* Effect.promise(() =>
              raw.append({
                part: { contentType: 'application/octet-stream', body: new Uint8Array([1]) },
              })
            )).ok
          ).toBe(true);
          const next = yield* Effect.promise(() => raw.head());
          if (!next.ok) throw new Error('missing next native tail');
          const newer = yield* sealedAt(next.result.nextOffset);
          expect(
            (yield* reopened.gateway.snapshot({
              ...request,
              credential: renewed,
              continuationOffset: next.result.nextOffset,
              body: newer,
            })).status
          ).toBe(204);
          expect(puts).toBe(2);
          expect(
            (yield* reopened.gateway.snapshot({ ...request, credential: renewed })).status
          ).toBe(204);
          expect(puts).toBe(2);
          expect(yield* reopened.store.lookup(offset)).toMatchObject({
            body: null,
            phase: 'Accepted',
            digest: expect.stringMatching(/^[0-9a-f]{64}$/),
          });
          expect((yield* reopened.store.current())?.offset).toBe(next.result.nextOffset);
          expect((yield* reopened.store.current())?.body).toEqual(newer);
          const native = yield* Effect.promise(() => raw.readLatestSnapshot());
          expect(native.ok && native.result?.payload.body).toEqual(newer);
          expect(
            (yield* Effect.promise(() =>
              raw.append({
                part: { contentType: 'application/octet-stream', body: new Uint8Array([2]) },
              })
            )).ok
          ).toBe(true);
          const pendingHead = yield* Effect.promise(() => raw.head());
          if (!pendingHead.ok) throw new Error('missing pending native tail');
          const pendingBody = yield* sealedAt(pendingHead.result.nextOffset),
            pendingRequest = {
              ...request,
              continuationOffset: pendingHead.result.nextOffset,
              body: pendingBody,
            };
          expireAtHead = true;
          expect(
            Result.isFailure(yield* Effect.result(reopened.gateway.snapshot(pendingRequest)))
          ).toBe(true);
          expect(yield* reopened.store.pending()).toMatchObject({
            phase: 'Pending',
            issuedAt: 0,
            expiresAt: 100,
          });
          expect(puts).toBe(2);
          expireAtHead = false;
          const freshCredential = {
            ...credential,
            token: 'renewed-cannot-extend-original-intent',
            issuedAt: 1000,
            expiresAt: 2000,
          };
          expect(
            Result.isFailure(
              yield* Effect.result(
                reopened.gateway.snapshot({ ...pendingRequest, credential: freshCredential })
              )
            )
          ).toBe(true);
          expect(yield* reopened.store.pending()).toMatchObject({
            body: pendingBody,
            phase: 'Pending',
            issuedAt: 0,
            expiresAt: 100,
          });
          expect(puts).toBe(2);
          // Already accepted originals remain no-effect historical receipts even with
          // a fresh credential; that cannot renew the expired Pending write above.
          expect(
            (yield* reopened.gateway.snapshot({ ...request, credential: freshCredential })).status
          ).toBe(204);
          expect(puts).toBe(2);
        })
      )
    );
  } finally {
    await f.close();
  }
});
