import Database from 'better-sqlite3';
import { startDevServer } from '@loro-dev/sqlite-riverrun';
import { StreamsClient } from '@loro-dev/streams-client';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Deferred, Effect, Exit, Fiber, Result, Scope } from 'effect';
import { describe, expect, it } from 'vitest';
import { Bytes } from '@lody/e2ee-core';
import { commitEpochKey } from '@lody/e2ee-core/protocol';
import {
  signGenesisRecord,
  prepareDeviceAdmission,
  prepareLedgerCommand,
} from '@lody/e2ee-core/protocol';
import { makeSqliteProtectedEpochKeys } from '@lody/e2ee-core/internal';
import { verifyLedger, decodeRecord } from '@lody/e2ee-core/protocol';
import { generateDevice } from '../src/platform/device';
import { labSyntheticProtector } from '../src/platform/synthetic-protection';
import { openLabExistingWorkspace } from '../src/platform/workspace-session';
import { frameLedgerRecord } from '@lody/e2ee-core/protocol';
import { hashRecordBytes } from '@lody/e2ee-core/protocol';
import { makeStreamsUpdateBinding } from '@lody/e2ee-core/adapters/loro-streams';
import { signLedgerRecord } from '@lody/e2ee-core/protocol';
import { makeLabScenarioFixture } from '../src/platform/scenario-fixture';
import { makeLabContentGateway } from '../src/platform/content-gateway';
import { makeLabCredentials } from '../src/platform/credentials';
import { makeLabHttpHost } from '../src/platform/host';
import { makeLabHttpIdentity } from '../src/platform/http-identity';
import { makeLabControlGateway } from '../src/platform/control-gateway';
import { makeLabStreamReader } from '../src/platform/stream-read';
import { makeLabWorkspaceCreationRequest } from '../src/platform/workspace-creation-request';
import { makeLabWorkspaceCreation } from '../src/platform/workspace-creation';
import { makeLabWorkspaceRegistry } from '../src/platform/workspace-registry';
import { history } from './ledger-fixture';
import { runOwnedChild } from './native-child';
const ok = Result.getOrThrow;

describe('current signed-genesis workspace publication', () => {
  it('durably reserves original genesis, recovers lost create ACK and post-CAS checkpoint gap, then independently reopens in an OS child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-create-'));
    const f = history();
    const server = await startDevServer({
      host: '127.0.0.1',
      port: 0,
      protocol: 'http1',
      dbPath: join(dir, 'native.sqlite'),
    });
    const registryPath = join(dir, 'registry.sqlite');
    const path = join(dir, 'creation.sqlite');
    const org = Buffer.from(f.anchor.toBytes()).toString('hex');
    const credential = {
      token: 'synthetic',
      account: 'synthetic',
      device: f.owner.publicKey,
      genesis: null,
      issuedAt: 0,
      expiresAt: 100,
    };
    let loseCreateAck = true;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const registry = yield* makeLabWorkspaceRegistry({
              path: registryPath,
              mode: 'create',
            });
            const owner = yield* makeLabWorkspaceCreation({
              path,
              mode: 'create',
              genesisRecord: f.genesis,
              baseUrl: server.baseUrl,
              registry,
              budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
              fetch: async (request, init) => {
                const outgoing = new Request(request, init);
                const response = await fetch(outgoing);
                if (
                  outgoing.method === 'PUT' &&
                  outgoing.url.endsWith('/control') &&
                  loseCreateAck
                ) {
                  loseCreateAck = false;
                  await response.body?.cancel();
                  throw new Error('synthetic lost create ACK');
                }
                return response;
              },
            });
            expect(Result.isFailure(yield* Effect.result(owner.checkpoint()))).toBe(true);
            expect(
              Result.isFailure(yield* Effect.result(owner.create(credential, f.genesis)))
            ).toBe(true);
            const pending = yield* owner.status();
            expect(pending.phase).toBe('Pending');
            expect(Result.isFailure(yield* Effect.result(owner.current()))).toBe(true);
            expect((yield* registry.get(f.anchor))?.record).toEqual(f.genesis);
            const receipt = yield* owner.create(credential, f.genesis);
            expect(receipt.genesisHex).toBe(org);
            expect(receipt.count).toBe(1);
            const sdk = new StreamsClient({
              url: `${server.baseUrl}/ds/${org}/control`,
              retry: { maxAttempts: 1 },
            });
            const first = yield* Effect.promise(() => sdk.read({ offset: '-1' }));
            expect(first.ok && first.result.payload.body).toEqual(ok(frameLedgerRecord(f.genesis)));
            const append = yield* Effect.promise(() =>
              sdk.appendCas({
                expectedOffset: receipt.offset,
                part: {
                  contentType: 'application/octet-stream',
                  body: ok(frameLedgerRecord(f.rotate)),
                },
              })
            );
            expect(append.ok && append.result.kind).toBe('ok');
            // A real remote write happened while the old durable host floor remains.
            expect((yield* owner.current()).view.length).toBe(1);
            const recovered = yield* owner.refresh();
            expect(recovered.view.length).toBe(2);
            expect(recovered.view.head.equals(f.checkpoint.head)).toBe(true);
            expect((yield* owner.create(credential)).count).toBe(2);
            expect(
              Result.isFailure(
                yield* Effect.result(
                  owner.create({ ...credential, device: history(79).owner.publicKey })
                )
              )
            ).toBe(true);
          })
        )
      );
      const output = await Effect.runPromise(
        runOwnedChild([
          '--import',
          'tsx',
          'test/workspace-creation-reopen.mts',
          path,
          registryPath,
          server.baseUrl,
          Buffer.from(f.genesis).toString('hex'),
          Buffer.from(f.checkpoint.head.toBytes()).toString('hex'),
          '2',
        ])
      );
      expect(JSON.parse(output)).toEqual({
        count: 2,
        head: Buffer.from(f.checkpoint.head.toBytes()).toString('hex'),
        original: Buffer.from(f.genesis).toString('hex'),
      });
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back ignored final checkpoint writes, retains exact original and retries same handle; known signed rollback is rejected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-create-fault-'));
    const f = history();
    const server = await startDevServer({
      host: '127.0.0.1',
      port: 0,
      protocol: 'http1',
      dbPath: join(dir, 'native.sqlite'),
    });
    const path = join(dir, 'creation.sqlite');
    const credential = {
      token: 'synthetic',
      account: 'synthetic',
      device: f.owner.publicKey,
      genesis: null,
      issuedAt: 0,
      expiresAt: 100,
    };
    let rollback = false;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const registry = yield* makeLabWorkspaceRegistry({
              path: join(dir, 'registry.sqlite'),
              mode: 'create',
            });
            const owner = yield* makeLabWorkspaceCreation({
              path,
              mode: 'create',
              genesisRecord: f.genesis,
              baseUrl: server.baseUrl,
              registry,
              budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
              fetch: async (request, init) => {
                const outgoing = new Request(request, init);
                if (
                  rollback &&
                  outgoing.method === 'GET' &&
                  new URL(outgoing.url).pathname.endsWith('/control')
                )
                  return new Response(new Uint8Array(ok(frameLedgerRecord(f.genesis))), {
                    headers: {
                      'content-type': 'application/octet-stream',
                      'stream-next-offset': 'synthetic-old',
                      'stream-up-to-date': 'true',
                      'stream-closed': 'false',
                    },
                  });
                return fetch(outgoing);
              },
            });
            const db = new Database(path);
            try {
              db.exec(
                'CREATE TRIGGER fault BEFORE UPDATE ON creation BEGIN SELECT RAISE(IGNORE); END;'
              );
              expect(Result.isFailure(yield* Effect.result(owner.create(credential)))).toBe(true);
              expect((yield* owner.status()).phase).toBe('Pending');
              expect(db.prepare('SELECT original,phase,count,offset FROM creation').get()).toEqual({
                original: Buffer.from(f.genesis),
                phase: 'Pending',
                count: 1,
                offset: '-1',
              });
              db.exec('DROP TRIGGER fault');
              const receipt = yield* owner.create(credential);
              const sdk = new StreamsClient({
                url: `${server.baseUrl}/ds/${receipt.genesisHex}/control`,
                retry: { maxAttempts: 1 },
              });
              expect(
                (yield* Effect.promise(() =>
                  sdk.appendCas({
                    expectedOffset: receipt.offset,
                    part: {
                      contentType: 'application/octet-stream',
                      body: ok(frameLedgerRecord(f.rotate)),
                    },
                  })
                )).ok
              ).toBe(true);
              yield* owner.refresh();
              const before = db
                .prepare('SELECT original,phase,head,count,offset FROM creation')
                .get();
              rollback = true;
              expect(Result.isFailure(yield* Effect.result(owner.refresh()))).toBe(true);
              expect((yield* owner.current()).view.length).toBe(2);
              expect(
                db.prepare('SELECT original,phase,head,count,offset FROM creation').get()
              ).toEqual(before);
            } finally {
              db.close();
            }
          })
        )
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const registry = yield* makeLabWorkspaceRegistry({
              path: join(dir, 'registry.sqlite'),
              mode: 'open',
            });
            expect(
              Result.isFailure(
                yield* Effect.result(
                  makeLabWorkspaceCreation({
                    path,
                    mode: 'open',
                    genesisRecord: f.genesis,
                    baseUrl: server.baseUrl,
                    registry,
                    minimum: { head: hashRecordBytes(history(79).genesis), length: 1 },
                    budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
                  })
                )
              )
            ).toBe(true);
          })
        )
      );
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('creates via real possession/bearer HTTP, resumes original client journal after lost ACK, binds once and rejects foreign signer or changed genesis', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-create-http-'));
    const device = await Effect.runPromise(generateDevice());
    const initialKey = ok(Bytes.epochKey(crypto.getRandomValues(new Uint8Array(32))));
    const membershipId = ok(Bytes.membershipId(new Uint8Array(16).fill(31)));
    const generated = await Effect.runPromise(
      signGenesisRecord({
        userId: ok(Bytes.userId(new Uint8Array(32).fill(32))),
        membershipId,
        encryptionPublicKey: device.enc,
        initialKey,
        signer: device,
      })
    );
    const f = {
      owner: device,
      anchor: generated.genesis,
      genesis: generated.record,
      rotate: history().rotate,
    };
    const initialPoint = { head: hashRecordBytes(f.genesis), length: 1 };
    const initialView = ok(
      verifyLedger({ anchor: f.anchor, records: [f.genesis], checkpoint: initialPoint })
    );
    const keysPath = join(dir, 'owner-keys.sqlite');
    // The caller performs the already-public producer and installed-key path before
    // publication. No parallel crypto, identity store or implicit backup format.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const keys = yield* makeSqliteProtectedEpochKeys({
            path: keysPath,
            mode: 'create',
            genesis: f.anchor,
            recipient: device.publicKey,
            ledger: () => Effect.succeed(initialView),
            protector: labSyntheticProtector,
          });
          yield* keys.saveAndReload(0, initialKey);
        })
      )
    );
    const server = await startDevServer({
      host: '127.0.0.1',
      port: 0,
      protocol: 'http1',
      dbPath: join(dir, 'native.sqlite'),
    });
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const registry = yield* makeLabWorkspaceRegistry({
              path: join(dir, 'registry.sqlite'),
              mode: 'create',
            });
            let failAfterNativeCas = true;
            let witnessedPublication: Uint8Array | undefined;
            const creation = yield* makeLabWorkspaceCreation({
              path: join(dir, 'creation.sqlite'),
              mode: 'create',
              genesisRecord: f.genesis,
              baseUrl: server.baseUrl,
              registry,
              budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
              fetch: async (request, init) => {
                const outgoing = new Request(request, init);
                const publication =
                  outgoing.method === 'POST' &&
                  new URL(outgoing.url).pathname.endsWith('/append-cas')
                    ? new Uint8Array(await outgoing.clone().arrayBuffer())
                    : undefined;
                const response = await fetch(outgoing);
                if (
                  failAfterNativeCas &&
                  outgoing.method === 'POST' &&
                  new URL(outgoing.url).pathname.endsWith('/append-cas')
                ) {
                  failAfterNativeCas = false;
                  if (
                    !publication ||
                    publication.length < 5 ||
                    new DataView(publication.buffer, publication.byteOffset, 4).getUint32(0) !==
                      publication.length - 4
                  )
                    throw new Error('single actual public control frame required');
                  witnessedPublication = publication.slice(4);
                  const fault = new Database(join(dir, 'creation.sqlite'));
                  try {
                    fault.exec(
                      'CREATE TRIGGER ignore_after_cas BEFORE UPDATE ON creation BEGIN SELECT RAISE(IGNORE); END;'
                    );
                  } finally {
                    fault.close();
                  }
                }
                return response;
              },
            });
            const credentials = yield* makeLabCredentials({
              path: join(dir, 'credentials.sqlite'),
              mode: 'create',
              now: () => 0,
              ledger: () => creation.refresh().pipe(Effect.map((value) => value.view)),
            });
            const gateway = yield* makeLabControlGateway({
              genesis: f.anchor,
              stream: creation.stream,
              checkpoint: creation.checkpoint,
              now: () => 0,
              budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
              afterAppend: () => creation.refresh().pipe(Effect.asVoid),
            });
            const reader = yield* makeLabStreamReader({
              genesis: f.anchor,
              baseUrl: server.baseUrl,
              maxBytes: 1024 * 1024,
              ledger: () => creation.refresh().pipe(Effect.map((value) => value.view)),
            });
            const host = yield* makeLabHttpHost({
              credentials,
              creation,
              workspaces: registry,
              control: () => gateway,
              streams: () => reader,
            });
            let loseAck = true;
            const identity = yield* makeLabHttpIdentity({
              baseUrl: host.baseUrl,
              genesis: f.anchor,
              fetch: async (request, init) => {
                const outgoing = new Request(request, init);
                const response = await fetch(outgoing);
                if (
                  outgoing.method === 'POST' &&
                  new URL(outgoing.url).pathname === '/v1/spaces' &&
                  loseAck
                ) {
                  loseAck = false;
                  await response.body?.cancel();
                  throw new Error('synthetic created-but-lost-response');
                }
                return response;
              },
            });
            const auth = yield* identity.authenticate(f.owner, 'unbound');
            const requestPath = join(dir, 'request.sqlite');
            const request = yield* makeLabWorkspaceCreationRequest({
              path: requestPath,
              mode: 'create',
              genesisRecord: f.genesis,
              send: auth.createWorkspace,
            });
            expect(Result.isFailure(yield* Effect.result(request.resume()))).toBe(true);
            expect(yield* request.result()).toBeUndefined();
            expect((yield* creation.current()).view.length).toBe(1);
            const result = yield* request.resume();
            expect(result.original).toEqual(f.genesis);
            expect(result.receipt?.count).toBe(1);
            const requestDb = new Database(requestPath);
            try {
              requestDb.exec(
                'CREATE TRIGGER ignore_ack BEFORE UPDATE ON creation_request BEGIN SELECT RAISE(IGNORE); END;'
              );
              expect(Result.isFailure(yield* Effect.result(request.acknowledge(result)))).toBe(
                true
              );
              expect((yield* request.result())?.consumed).toBe(false);
              requestDb.exec('DROP TRIGGER ignore_ack');
              yield* request.acknowledge(result);
              expect((yield* request.result())?.consumed).toBe(true);
              expect(requestDb.prepare('SELECT original FROM creation_request').get()).toEqual({
                original: Buffer.from(f.genesis),
              });
            } finally {
              requestDb.close();
            }
            const foreignIdentity = yield* makeLabHttpIdentity({
              baseUrl: host.baseUrl,
              genesis: f.anchor,
            });
            const foreign = yield* foreignIdentity.authenticate(history(79).owner, 'unbound');
            expect(Result.isFailure(yield* Effect.result(foreign.createWorkspace(f.genesis)))).toBe(
              true
            );
            expect(Result.isFailure(yield* Effect.result(auth.createWorkspace(f.rotate)))).toBe(
              true
            );
            // Public client actor consumes this complete signed prefix, never metadata-only genesis.
            const published = new StreamsClient({
              url: `${host.baseUrl}/ds/${Buffer.from(f.anchor.toBytes()).toString('hex')}/control`,
              fetch: auth.fetch,
              retry: { maxAttempts: 1 },
            });
            const read = yield* Effect.promise(() => published.read({ offset: '-1' }));
            expect(read.ok && read.result.payload.body).toEqual(ok(frameLedgerRecord(f.genesis)));
            const reopened = yield* makeLabWorkspaceCreationRequest({
              path: requestPath,
              mode: 'open',
              genesisRecord: f.genesis,
              send: () => Effect.die('published/consumed request must not dispatch again'),
            });
            expect((yield* reopened.resume()).consumed).toBe(true);
            const workspace = yield* openLabExistingWorkspace({
              baseUrl: host.baseUrl,
              genesis: f.anchor,
              signer: device,
              path: join(dir, 'local-feed.sqlite'),
              journalPath: join(dir, 'local-p09.sqlite'),
              mode: 'create',
              checkpoint: () => Effect.succeed(initialPoint),
              budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
            });
            expect((yield* workspace.control.current()).view.head.equals(initialPoint.head)).toBe(
              true
            );
            const keys = yield* makeSqliteProtectedEpochKeys({
              path: keysPath,
              mode: 'open',
              genesis: f.anchor,
              recipient: device.publicKey,
              ledger: () => workspace.control.current().pipe(Effect.map((value) => value.view)),
              protector: labSyntheticProtector,
            });
            const loaded = yield* keys.read(0);
            const body = ok(decodeRecord(f.genesis)).body;
            if (body.type !== 'genesis') throw new Error('actual genesis required');
            expect(ok(commitEpochKey(f.anchor, 0, loaded)).equals(body.epochCommitment)).toBe(true);
            const child = yield* runOwnedChild([
              '--import',
              'tsx',
              'test/workspace-creation-reopen.mts',
              join(dir, 'creation.sqlite'),
              join(dir, 'registry.sqlite'),
              server.baseUrl,
              Buffer.from(f.genesis).toString('hex'),
              Buffer.from(initialPoint.head.toBytes()).toString('hex'),
              '1',
              keysPath,
            ]);
            const childResult = JSON.parse(child);
            expect(childResult.count).toBe(1);
            expect(childResult.keyCommitment).toBe(true);
            const newDevice = yield* generateDevice();
            const admission = yield* prepareDeviceAdmission({
              genesis: f.anchor,
              membershipId,
              kind: 'personal',
              encryptionPublicKey: newDevice.enc,
              signer: newDevice,
            });
            expect(
              Result.isFailure(yield* Effect.result(workspace.control.execute(admission)))
            ).toBe(true);
            const actual = yield* Effect.promise(() =>
              new StreamsClient({
                url: `${server.baseUrl}/ds/${Buffer.from(f.anchor.toBytes()).toString('hex')}/control`,
                retry: { maxAttempts: 1 },
              }).read({ offset: '-1' })
            );
            expect(actual.ok && actual.result.payload.body.length).toBeGreaterThan(
              ok(frameLedgerRecord(f.genesis)).length
            );
            const durable = new Database(join(dir, 'creation.sqlite'));
            try {
              expect(durable.prepare('SELECT count FROM creation').get()).toEqual({ count: 1 });
              durable.exec('DROP TRIGGER ignore_after_cas');
            } finally {
              durable.close();
            }
            yield* creation.refresh();
            // External witness is the actually witnessed retained signed admission;
            // host receipt is never used as the client's independent checkpoint.
            if (!witnessedPublication)
              throw new Error('independently captured actual original publication required');
            const resumedPoint = { head: hashRecordBytes(witnessedPublication), length: 2 };
            const witnessed = ok(
              verifyLedger({
                anchor: f.anchor,
                records: [f.genesis, witnessedPublication],
                checkpoint: resumedPoint,
              })
            );
            expect(witnessed.length).toBe(2);
            const witnessedRecord = ok(decodeRecord(witnessedPublication));
            if (
              witnessedRecord.body.type !== 'ordinary' ||
              witnessedRecord.body.operation.type !== 'admitDevice'
            )
              throw new Error('witnessed admission required');
            expect(
              witnessedRecord.body.operation.signingPublicKey.equals(newDevice.publicKey)
            ).toBe(true);
            yield* workspace.close();
            const reopenedWorkspace = yield* openLabExistingWorkspace({
              baseUrl: host.baseUrl,
              genesis: f.anchor,
              signer: device,
              path: join(dir, 'local-feed.sqlite'),
              journalPath: join(dir, 'local-p09.sqlite'),
              mode: 'open',
              expected: initialPoint,
              checkpoint: () => Effect.succeed(resumedPoint),
              budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
            });
            const committed = yield* reopenedWorkspace.control.resume();
            expect(committed?.outcome).toBe('Committed');
            expect((yield* reopenedWorkspace.control.current()).view.length).toBe(2);
            if (committed) yield* reopenedWorkspace.control.acknowledge(committed);
            const finalRead = yield* Effect.promise(() =>
              new StreamsClient({
                url: `${server.baseUrl}/ds/${Buffer.from(f.anchor.toBytes()).toString('hex')}/control`,
                retry: { maxAttempts: 1 },
              }).read({ offset: '-1' })
            );
            if (!actual.ok || !finalRead.ok) throw new Error('real native history required');
            expect(finalRead.result.payload.body).toEqual(actual.result.payload.body);
          })
        )
      );
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects close-time admission and joins an abort-ignoring borrowed send before closing its actual SQLite owner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-create-close-'));
    const f = history(),
      path = join(dir, 'request.sqlite');
    let released!: () => void;
    const release = new Promise<void>((resolve) => {
      released = resolve;
    });
    let settled = false,
      closedEarly = false,
      databaseClosed = false;
    const originalClose = Database.prototype.close;
    Database.prototype.close = function () {
      if (this.name === path) {
        closedEarly = !settled;
        databaseClosed = true;
      }
      return originalClose.call(this);
    };
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Scope.make();
            const entered = yield* Deferred.make<void>();
            yield* Effect.addFinalizer(() => Effect.sync(released));
            const request = yield* makeLabWorkspaceCreationRequest({
              path,
              mode: 'create',
              genesisRecord: f.genesis,
              send: () =>
                Effect.uninterruptible(
                  Effect.gen(function* () {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Effect.promise(() => release);
                    settled = true;
                    return {
                      genesisHex: Buffer.from(f.anchor.toBytes()).toString('hex'),
                      headHex: Buffer.from(hashRecordBytes(f.genesis).toBytes()).toString('hex'),
                      count: 1,
                      offset: 'synthetic-confirmed',
                    };
                  })
                ),
            }).pipe(Effect.provideService(Scope.Scope, scope));
            const active = yield* Effect.forkChild(Effect.exit(request.resume()));
            yield* Deferred.await(entered);
            const closing = yield* Effect.forkChild(Effect.exit(Scope.close(scope, Exit.void)), {
              startImmediately: true,
            });
            expect(Result.isFailure(yield* Effect.result(request.resume()))).toBe(true);
            const closeBeforeSettlement = closing.pollUnsafe();
            released();
            yield* Fiber.join(closing);
            yield* Fiber.join(active);
            expect(closedEarly).toBe(false);
            expect(closeBeforeSettlement).toBeUndefined();
            expect(settled).toBe(true);
            expect(databaseClosed).toBe(true);
            const db = new Database(path, { readonly: true });
            try {
              expect(db.prepare('SELECT receipt,consumed FROM creation_request').get()).toEqual({
                receipt: null,
                consumed: 0,
              });
            } finally {
              db.close();
            }
          })
        )
      );
    } finally {
      released();
      Database.prototype.close = originalClose;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('retains a newly verified revocation across checkpoint SQL failure and rejects stale current authorization or rollback before retry', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lab-host-observed-floor-'));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* makeLabScenarioFixture(join(directory, 'fixture'));
            const registry = yield* makeLabWorkspaceRegistry({
              path: join(directory, 'registry.sqlite'),
              mode: 'create',
            });
            const path = join(directory, 'creation.sqlite');
            let replayOldPrefix = false;
            const originalPrefix = new Uint8Array(
              Buffer.concat(f.records.map((record) => Buffer.from(ok(frameLedgerRecord(record)))))
            );
            const creation = yield* makeLabWorkspaceCreation({
              path,
              mode: 'create',
              genesisRecord: f.records[0],
              baseUrl: f.server.baseUrl,
              registry,
              budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
              fetch: async (request, init) => {
                const outgoing = new Request(request, init);
                if (
                  replayOldPrefix &&
                  outgoing.method === 'GET' &&
                  new URL(outgoing.url).pathname.endsWith('/control')
                )
                  return new Response(new Uint8Array(originalPrefix), {
                    headers: {
                      'content-type': 'application/octet-stream',
                      'stream-next-offset': 'synthetic-previous-valid-prefix',
                      'stream-up-to-date': 'true',
                      'stream-closed': 'false',
                    },
                  });
                return fetch(outgoing);
              },
            });
            yield* creation.create({
              token: 'synthetic',
              account: 'synthetic',
              device: f.owner.publicKey,
              genesis: null,
              issuedAt: 0,
              expiresAt: 100,
            });
            const ledger = () => creation.current().pipe(Effect.map((value) => value.view));
            const credentials = yield* makeLabCredentials({
              path: join(directory, 'credentials.sqlite'),
              mode: 'create',
              now: () => 0,
              ledger,
            });
            const gateway = yield* makeLabControlGateway({
              genesis: f.genesis,
              stream: creation.stream,
              checkpoint: creation.checkpoint,
              now: () => 0,
              afterAppend: () => creation.refresh().pipe(Effect.asVoid),
              budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
            });
            const content = yield* makeLabContentGateway({
              genesis: f.genesis,
              resource: 'document-A',
              model: 'loro',
              baseUrl: f.server.baseUrl,
              ledger,
            });
            const host = yield* makeLabHttpHost({
              credentials,
              control: () => gateway,
              contents: () => content,
            });
            const identity = yield* makeLabHttpIdentity({
              baseUrl: host.baseUrl,
              genesis: f.genesis,
            });
            const ownerAuth = yield* identity.authenticate(f.owner),
              peerAuth = yield* identity.authenticate(f.peer);
            const streamUrl = `${host.baseUrl}/ds/${Buffer.from(f.genesis.toBytes()).toString('hex')}/loro`;
            const created = yield* Effect.promise(() =>
              peerAuth.fetch(streamUrl, { method: 'PUT' })
            );
            expect(created.status).toBe(201);
            yield* Effect.promise(() => created.body?.cancel() ?? Promise.resolve());
            const prefix = new Uint8Array([76, 83, 67, 69, 2, 1, 0, 1, 0, 0, 3]);
            const domain = new TextEncoder().encode('loro-streams-crdt-payload-protection/v2\0');
            const aad = new Uint8Array(domain.length + prefix.length);
            aad.set(domain);
            aad.set(prefix, domain.length);
            const binding = yield* makeStreamsUpdateBinding({
              genesis: f.genesis,
              resource: 'document-A',
              model: 'loro',
              writeEpoch: 0,
              signer: f.peer,
              ledger: f.ledger,
              readEpochKey: () => Effect.succeed(ok(Bytes.epochKey(new Uint8Array(32).fill(117)))),
            });
            const sealed = yield* binding.seal({
              context: {
                protocol: 'loro-streams-crdt-payload-protection',
                version: 2,
                kind: 'update_batch',
              },
              plaintext: new TextEncoder().encode('synthetic authorized bytes before revocation'),
              additionalData: () => aad,
            });
            const body = new Uint8Array(4 + prefix.length + sealed.sealed.length);
            new DataView(body.buffer).setUint32(0, body.length - 4);
            body.set(prefix, 4);
            body.set(sealed.sealed, 4 + prefix.length);
            const record = yield* signLedgerRecord(
              ok(
                prepareLedgerCommand(f.view(), f.owner.publicKey, {
                  _tag: 'RevokeDevice',
                  target: f.peer.publicKey,
                })
              ),
              f.owner
            );
            const native = new StreamsClient({
              url: `${f.server.baseUrl}/ds/${Buffer.from(f.genesis.toBytes()).toString('hex')}/loro`,
              retry: { maxAttempts: 1 },
            });
            const before = yield* Effect.promise(() => native.head());
            const db = new Database(path);
            try {
              db.exec(
                'CREATE TRIGGER ignore_revocation_checkpoint BEFORE UPDATE ON creation BEGIN SELECT RAISE(IGNORE); END;'
              );
              const control = new StreamsClient({
                url: `${host.baseUrl}/ds/${Buffer.from(f.genesis.toBytes()).toString('hex')}/control`,
                fetch: ownerAuth.fetch,
                retry: { maxAttempts: 1 },
              });
              const previousOffset = (yield* creation.current()).offset;
              const failedAck = yield* Effect.promise(() =>
                control.appendCas({
                  expectedOffset: previousOffset,
                  part: {
                    contentType: 'application/octet-stream',
                    body: ok(frameLedgerRecord(record)),
                  },
                })
              );
              expect(failedAck.ok).toBe(false);
              const refused = yield* Effect.promise(() =>
                peerAuth.fetch(streamUrl, {
                  method: 'POST',
                  headers: { 'content-type': 'application/octet-stream' },
                  body: new Uint8Array(body),
                })
              );
              // The new authority observation cannot yet be confirmed in SQL.
              // This is host storage unavailability, not a fake permission proof.
              expect(refused.status).toBe(500);
              yield* Effect.promise(() => refused.body?.cancel() ?? Promise.resolve());
              expect(Result.isFailure(yield* Effect.result(creation.current()))).toBe(true);
              expect(Result.isFailure(yield* Effect.result(creation.checkpoint()))).toBe(true);
              expect(db.prepare('SELECT count FROM creation').get()).toEqual({ count: 2 });
              replayOldPrefix = true;
              expect(Result.isFailure(yield* Effect.result(creation.refresh()))).toBe(true);
              expect(Result.isFailure(yield* Effect.result(creation.current()))).toBe(true);
              db.exec('DROP TRIGGER ignore_revocation_checkpoint');
              replayOldPrefix = false;
              expect((yield* creation.refresh()).view.length).toBe(3);
              const stillRefused = yield* Effect.promise(() =>
                peerAuth.fetch(streamUrl, {
                  method: 'POST',
                  headers: { 'content-type': 'application/octet-stream' },
                  body: new Uint8Array(body),
                })
              );
              expect(stillRefused.status).toBe(403);
              yield* Effect.promise(() => stillRefused.body?.cancel() ?? Promise.resolve());
              const after = yield* Effect.promise(() => native.head());
              if (!before.ok || !after.ok) throw new Error('actual native content tail required');
              expect(after.result.nextOffset).toBe(before.result.nextOffset);
            } finally {
              db.close();
            }
          })
        )
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
