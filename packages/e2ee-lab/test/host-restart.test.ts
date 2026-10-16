import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { StreamsClient } from '@loro-dev/streams-client';
import { Deferred, Effect, Fiber, Result } from 'effect';
import { expect, it } from 'vitest';
import * as Riverrun from '@loro-dev/sqlite-riverrun';
import { Bytes } from '@lody/e2ee-core';
import {
  signGenesisRecord,
  prepareDeviceAdmission,
  prepareJoinRequest,
  prepareLedgerCommand,
} from '@lody/e2ee-core/protocol';
import { hashRecordBytes, verifyLedger } from '@lody/e2ee-core/protocol';
import { signLedgerRecord } from '@lody/e2ee-core/protocol';
import { frameLedgerRecord } from '@lody/e2ee-core/protocol';
import { makeSqliteProtectedEpochKeys } from '@lody/e2ee-core/internal';
import { generateDevice } from '../src/platform/device';
import { makeLabHostSession, LabHostNativeServer } from '../src/platform/host-session';
import { makeLabHttpIdentity } from '../src/platform/http-identity';
import {
  openLabWorkspaceSession,
  type LabWorkspaceSessionInput,
} from '../src/platform/full-session';
import { labSyntheticProtector } from '../src/platform/synthetic-protection';

const ok = Result.getOrThrow;
it('closes and reopens the actual whole host, reconciles committed CAS/Pending snapshots and resumes the original client files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-whole-host-restart-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* generateDevice(),
            peer = yield* generateDevice(),
            third = yield* generateDevice(),
            joiner = yield* generateDevice();
          const material = new Uint8Array(32).fill(191);
          const membership = ok(Bytes.membershipId(new Uint8Array(16).fill(192)));
          const genesis = yield* signGenesisRecord({
            signer: owner,
            initialKey: ok(Bytes.epochKey(material)),
            membershipId: membership,
            userId: ok(Bytes.userId(new Uint8Array(32).fill(193))),
            encryptionPublicKey: owner.enc,
          });
          // Pins are independently witnessed signed originals, never host receipts,
          // endpoint JSON or SQLite-selected head/count.
          const originals = [new Uint8Array(genesis.record)];
          const point = () => ({
            head: hashRecordBytes(originals.at(-1)!),
            length: originals.length,
          });
          const ledger = () =>
            Effect.fromResult(
              verifyLedger({ anchor: genesis.genesis, records: originals, checkpoint: point() })
            );
          const hostDirectory = join(directory, 'host');
          let snapshotPuts = 0;
          const nativeFetch: typeof fetch = (input, init) => {
            const request = new Request(input, init);
            if (request.method === 'PUT' && new URL(request.url).pathname.includes('/snapshot/'))
              snapshotPuts++;
            return fetch(request);
          };
          const host = yield* makeLabHostSession({
            directory: hostDirectory,
            mode: 'create',
            genesisRecord: genesis.record,
            now: () => 0,
            resources: { loro: 'restart-loro', flock: 'restart-flock' },
            budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
            fetch: nativeFetch,
          });
          const baseUrl = host.baseUrl,
            publicPort = Number(new URL(baseUrl).port);
          let nativeBaseUrl = host.nativeBaseUrl;
          // Independent synthetic witness: own signed candidate + actual native
          // framed originals, verified before publishing a new network pin.
          // This is not a production checkpoint acquisition service.
          const clientFetch: typeof fetch = async (value, init) => {
            const request = new Request(value, init);
            const candidate =
              request.method === 'POST' &&
              new URL(request.url).pathname.endsWith('/control/append-cas')
                ? new Uint8Array(await request.clone().arrayBuffer()).subarray(4)
                : undefined;
            const response = await fetch(request);
            if (candidate) {
              const native = new StreamsClient({
                url: `${nativeBaseUrl}/ds/${Buffer.from(genesis.genesis.toBytes()).toString('hex')}/control`,
                retry: { maxAttempts: 1 },
              });
              const observed = await native.read({ offset: '-1' });
              const records = [...originals, new Uint8Array(candidate)];
              const framed = new Uint8Array(
                Buffer.concat(records.map((record) => Buffer.from(ok(frameLedgerRecord(record)))))
              );
              if (
                observed.ok &&
                Buffer.from(observed.result.payload.body).equals(Buffer.from(framed))
              ) {
                ok(
                  verifyLedger({
                    anchor: genesis.genesis,
                    records,
                    checkpoint: { head: hashRecordBytes(candidate), length: records.length },
                  })
                );
                originals.push(new Uint8Array(candidate));
              }
            }
            return response;
          };
          const identity = yield* makeLabHttpIdentity({ baseUrl, genesis: genesis.genesis });
          const unbound = yield* identity.authenticate(owner, 'unbound');
          yield* unbound.createWorkspace(genesis.record);
          expect((yield* host.registry.get(genesis.genesis))?.record).toEqual(genesis.record);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const keys = yield* makeSqliteProtectedEpochKeys({
                path: join(directory, 'owner-keys.sqlite'),
                mode: 'create',
                genesis: genesis.genesis,
                recipient: owner.publicKey,
                ledger,
                protector: labSyntheticProtector,
              });
              yield* keys.saveAndReload(0, ok(Bytes.epochKey(material)));
            })
          );
          let documentTime = 1;
          const config = (
            name: 'owner' | 'peer',
            mode: 'create' | 'open',
            expected?: ReturnType<typeof point>
          ): LabWorkspaceSessionInput => ({
            baseUrl,
            genesis: genesis.genesis,
            signer: name === 'owner' ? owner : peer,
            path: join(directory, `${name}-feed.sqlite`),
            journalPath: join(directory, `${name}-journal.sqlite`),
            mode,
            expected,
            checkpoint: () => Effect.succeed(point()),
            fetch: clientFetch,
            budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
            keys: {
              path: join(directory, `${name}-receive.sqlite`),
              mode,
              pair: (name === 'owner' ? owner : peer).encryption,
              keyStore: {
                path: join(directory, `${name}-keys.sqlite`),
                mode: name === 'owner' ? 'open' : mode,
                protector: labSyntheticProtector,
              },
              repairStore: { path: join(directory, `${name}-repair.sqlite`), mode },
              sendStore: { path: join(directory, `${name}-send.sqlite`), mode },
              outboxStore: { path: join(directory, `${name}-outbox.sqlite`), mode },
              currentPublication: () => Effect.succeed(new Uint8Array(genesis.record)),
            },
            documents: [
              {
                id: 'loro',
                model: 'loro',
                resource: 'restart-loro',
                path: join(directory, `${name}-loro.sqlite`),
                mode,
                streamUrl: `${baseUrl}/ds/${Buffer.from(genesis.genesis.toBytes()).toString('hex')}/loro`,
                snapshotUpload: true,
              },
              {
                id: 'flock',
                model: 'flock',
                now: () => ++documentTime,
                resource: 'restart-flock',
                path: join(directory, `${name}-flock.sqlite`),
                mode,
                streamUrl: `${baseUrl}/ds/${Buffer.from(genesis.genesis.toBytes()).toString('hex')}/flock`,
                snapshotUpload: true,
              },
            ],
          });
          const first = yield* openLabWorkspaceSession(config('owner', 'create'));
          const proof = yield* prepareDeviceAdmission({
            genesis: genesis.genesis,
            membershipId: membership,
            signer: peer,
            encryptionPublicKey: peer.enc,
            kind: 'personal',
          });
          const admission = yield* first.submit(proof);
          expect(admission.outcome).toBe('Committed');
          expect(originals.at(-1)).toEqual(admission.record);
          yield* first.acknowledge(admission);
          const second = yield* openLabWorkspaceSession(config('peer', 'create'));
          yield* first.keyRound();
          yield* second.keyRound();
          for (const model of ['loro', 'flock'] as const) {
            yield* first.createDocument(model);
            yield* first.append(model, `before-${model}`);
            yield* second.pull(model);
            expect(yield* second.text(model)).toBe(`before-${model}`);
          }
          const joinAuth = yield* identity.authenticate(joiner, 'unbound');
          const joinRequest = yield* prepareJoinRequest({
            genesis: genesis.genesis,
            signer: joiner,
            encryptionPublicKey: joiner.enc,
            userId: ok(Bytes.userId(new Uint8Array(32).fill(194))),
            requestId: ok(Bytes.requestId(new Uint8Array(16).fill(195))),
            expiresAt: null,
          });
          yield* joinAuth.submitJoin(joinRequest);
          expect(yield* first.listJoins()).toHaveLength(1);
          yield* first.uploadSnapshot('flock');
          const fault = new Database(join(hostDirectory, 'loro-snapshots.sqlite'));
          try {
            fault.exec(
              "CREATE TRIGGER deny_accept BEFORE UPDATE ON snapshot_publications WHEN NEW.phase='Accepted' BEGIN SELECT RAISE(IGNORE); END"
            );
          } finally {
            fault.close();
          }
          expect(Result.isFailure(yield* Effect.result(first.uploadSnapshot('loro')))).toBe(true);
          const pendingSnapshot = yield* host.snapshots.loro.pending();
          expect(pendingSnapshot?.phase).toBe('Pending');
          expect(snapshotPuts).toBe(2);
          const repairSnapshot = new Database(join(hostDirectory, 'loro-snapshots.sqlite'));
          try {
            repairSnapshot.exec('DROP TRIGGER deny_accept');
          } finally {
            repairSnapshot.close();
          }
          // The native CAS commits, but persisting the host's confirmed suffix fails.
          const creationFault = new Database(join(hostDirectory, 'creation.sqlite'));
          try {
            creationFault.exec(
              'CREATE TRIGGER deny_checkpoint BEFORE UPDATE ON creation BEGIN SELECT RAISE(IGNORE); END'
            );
          } finally {
            creationFault.close();
          }
          const thirdProof = yield* prepareDeviceAdmission({
            genesis: genesis.genesis,
            membershipId: membership,
            signer: third,
            encryptionPublicKey: third.enc,
            kind: 'personal',
          });
          expect(Result.isFailure(yield* Effect.result(first.submit(thirdProof)))).toBe(true);
          const journal = new Database(join(directory, 'owner-journal.sqlite'), { readonly: true });
          let pendingRecord: Uint8Array;
          try {
            pendingRecord = new Uint8Array(
              (
                journal.prepare('SELECT pending FROM submission_journal').get() as {
                  pending: Uint8Array;
                }
              ).pending
            );
          } finally {
            journal.close();
          }
          expect(pendingRecord.length).toBeGreaterThan(0);
          const remote = new StreamsClient({
            url: `${host.nativeBaseUrl}/ds/${Buffer.from(genesis.genesis.toBytes()).toString('hex')}/control`,
            retry: { maxAttempts: 1 },
          });
          const witnessed = yield* Effect.promise(() => remote.read({ offset: '-1' }));
          expect(witnessed.ok).toBe(true);
          const all = originals;
          expect(witnessed.ok && witnessed.result.payload.body).toEqual(
            new Uint8Array(
              Buffer.concat(all.map((record) => Buffer.from(ok(frameLedgerRecord(record)))))
            )
          );
          expect(originals.at(-1)).toEqual(pendingRecord);
          expect(
            ok(verifyLedger({ anchor: genesis.genesis, records: originals, checkpoint: point() }))
              .length
          ).toBe(3);
          expect(Result.isFailure(yield* Effect.result(host.current()))).toBe(true);
          const localOwner = (yield* first.current()).view;
          const localPeer = (yield* second.current()).view;
          yield* first.close();
          yield* second.close();
          const repairCreation = new Database(join(hostDirectory, 'creation.sqlite'));
          try {
            repairCreation.exec('DROP TRIGGER deny_checkpoint');
          } finally {
            repairCreation.close();
          }
          yield* host.close();
          expect(Result.isFailure(yield* Effect.result(host.current()))).toBe(true);
          expect(Result.isFailure(yield* Effect.result(host.snapshots.loro.pending()))).toBe(true);
          yield* Effect.promise(() => expect(fetch(`${baseUrl}/healthz`)).rejects.toThrow());
          yield* Effect.promise(() =>
            expect(fetch(`${host.nativeBaseUrl}/healthz`)).rejects.toThrow()
          );
          const reopenedHost = yield* makeLabHostSession({
            directory: hostDirectory,
            mode: 'open',
            genesisRecord: genesis.record,
            minimum: { head: localOwner.head, length: localOwner.length },
            port: publicPort,
            now: () => 0,
            resources: { loro: 'restart-loro', flock: 'restart-flock' },
            budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
            fetch: nativeFetch,
          });
          expect(reopenedHost.baseUrl).toBe(baseUrl);
          nativeBaseUrl = reopenedHost.nativeBaseUrl;
          const reopenedCheckpoint = new Database(join(hostDirectory, 'creation.sqlite'), {
            readonly: true,
          });
          try {
            expect(reopenedCheckpoint.prepare('SELECT count FROM creation').get()).toEqual({
              count: 3,
            });
          } finally {
            reopenedCheckpoint.close();
          }
          expect((yield* reopenedHost.current()).view.length).toBe(3);
          expect((yield* reopenedHost.registry.get(genesis.genesis))?.record).toEqual(
            genesis.record
          );
          expect((yield* reopenedHost.snapshots.loro.pending())?.body).toEqual(
            pendingSnapshot!.body
          );
          const ownerAgain = yield* openLabWorkspaceSession(
            config('owner', 'open', { head: localOwner.head, length: localOwner.length })
          );
          const peerAgain = yield* openLabWorkspaceSession(
            config('peer', 'open', { head: localPeer.head, length: localPeer.length })
          );
          const resumed = yield* ownerAgain.resume();
          expect(resumed?.outcome).toBe('Committed');
          expect(resumed?.record).toEqual(pendingRecord);
          yield* ownerAgain.acknowledge(resumed!);
          expect((yield* reopenedHost.current()).view.length).toBe(3);
          const credentialDb = new Database(join(hostDirectory, 'credentials.sqlite'), {
            readonly: true,
          });
          let token: string;
          try {
            token = (
              credentialDb
                .prepare(
                  'SELECT token FROM credentials WHERE device_hex=? AND genesis_hex=? ORDER BY rowid DESC LIMIT 1'
                )
                .get(
                  Buffer.from(owner.publicKey.toBytes()).toString('hex'),
                  Buffer.from(genesis.genesis.toBytes()).toString('hex')
                ) as { token: string }
            ).token;
          } finally {
            credentialDb.close();
          }
          yield* reopenedHost.resumeSnapshot('loro', token);
          expect(yield* reopenedHost.snapshots.loro.pending()).toBeNull();
          expect((yield* reopenedHost.snapshots.loro.current())?.body).toEqual(
            pendingSnapshot!.body
          );
          expect(snapshotPuts).toBe(2); // Recovery confirmed the original by GET, no second PUT.
          yield* ownerAgain.keyRound();
          yield* peerAgain.keyRound();
          expect(yield* ownerAgain.listJoins()).toHaveLength(1);
          for (const model of ['loro', 'flock'] as const) {
            expect(yield* ownerAgain.text(model)).toBe(`before-${model}`);
            yield* ownerAgain.append(model, '-after');
            yield* peerAgain.pull(model);
            expect(yield* peerAgain.text(model)).toBe(`before-${model}-after`);
          }
          const final = new StreamsClient({
            url: `${reopenedHost.nativeBaseUrl}/ds/${Buffer.from(genesis.genesis.toBytes()).toString('hex')}/control`,
            retry: { maxAttempts: 1 },
          });
          const exact = yield* Effect.promise(() => final.read({ offset: '-1' }));
          expect(exact.ok && exact.result.payload.body).toEqual(
            witnessed.ok && witnessed.result.payload.body
          );
          yield* ownerAgain.close();
          yield* peerAgain.close();
          yield* reopenedHost.close();
        })
      )
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('joins an actual held native response before closing the complete host Riverrun owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-host-held-body-'));
  let bodySettled = false,
    closedEarly = false;
  const start = Riverrun.startDevServer;
  const release = Deferred.makeUnsafe<void>();
  const instrument: typeof start = async (options) => {
    const server = await start(options);
    return {
      ...server,
      close: async () => {
        closedEarly ||= !bodySettled;
        await server.close();
      },
    };
  };
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>(),
            closeStarted = yield* Deferred.make<void>();
          const owner = yield* generateDevice();
          const genesis = yield* signGenesisRecord({
            signer: owner,
            initialKey: ok(Bytes.epochKey(new Uint8Array(32).fill(211))),
            encryptionPublicKey: owner.enc,
            membershipId: ok(Bytes.membershipId(new Uint8Array(16).fill(212))),
            userId: ok(Bytes.userId(new Uint8Array(32).fill(213))),
          });
          let enabled = false,
            reads = 0;
          const transport: typeof fetch = async (value, init) => {
            const request = new Request(value, init),
              response = await fetch(request);
            if (
              !enabled ||
              request.method !== 'GET' ||
              !new URL(request.url).pathname.endsWith('/control') ||
              ++reads !== 2 ||
              !response.body
            )
              return response;
            const reader = response.body.getReader();
            let gated = false;
            const body = new ReadableStream<Uint8Array>({
              async pull(controller) {
                if (!gated) {
                  gated = true;
                  Deferred.doneUnsafe(entered, Effect.void);
                  // Instrumented actual HTTP body deliberately does not cooperate
                  // with abort until this explicit native-settlement gate releases.
                  await Effect.runPromise(Deferred.await(release));
                }
                try {
                  const chunk = await reader.read();
                  if (chunk.done) {
                    bodySettled = true;
                    controller.close();
                  } else controller.enqueue(chunk.value);
                } catch (cause) {
                  bodySettled = true;
                  controller.error(cause);
                }
              },
            });
            return new Response(body, { status: response.status, headers: response.headers });
          };
          const host = yield* makeLabHostSession({
            directory: join(directory, 'host'),
            mode: 'create',
            genesisRecord: genesis.record,
            now: () => 0,
            resources: { loro: 'held-loro', flock: 'held-flock' },
            budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
            fetch: transport,
          });
          const identity = yield* makeLabHttpIdentity({
            baseUrl: host.baseUrl,
            genesis: genesis.genesis,
          });
          const initial = yield* identity.authenticate(owner, 'unbound');
          yield* initial.createWorkspace(genesis.record);
          const auth = yield* identity.authenticate(owner);
          enabled = true;
          const reading = yield* Effect.forkChild(
            Effect.result(
              Effect.tryPromise({
                try: async () => {
                  const response = await auth.fetch(
                    `${host.baseUrl}/ds/${Buffer.from(genesis.genesis.toBytes()).toString('hex')}/control?offset=-1`
                  );
                  await response.arrayBuffer();
                },
                catch: (cause) => cause,
              })
            )
          );
          yield* Deferred.await(entered);
          const closing = yield* Effect.forkChild(
            Effect.gen(function* () {
              yield* Deferred.succeed(closeStarted, undefined);
              yield* host.close();
            })
          );
          yield* Deferred.await(closeStarted);
          // Real native IO gives the closing owner a causal opportunity to settle;
          // no sleep, deadline or fixed microtask drain is used as evidence.
          const probe = yield* Effect.result(
            Effect.tryPromise({
              try: async () => {
                const response = await fetch(
                  `${host.nativeBaseUrl}/ds/${Buffer.from(genesis.genesis.toBytes()).toString('hex')}/control`,
                  { method: 'HEAD' }
                );
                await response.body?.cancel();
                return response.status;
              },
              catch: (cause) => cause,
            })
          );
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(reading);
          yield* Fiber.join(closing);
          expect(bodySettled).toBe(true);
          expect(closedEarly).toBe(false);
          expect(Result.isSuccess(probe) && probe.success).toBe(200);
          yield* Effect.promise(() =>
            expect(fetch(`${host.nativeBaseUrl}/healthz`)).rejects.toThrow()
          );
        }).pipe(
          Effect.timeoutOrElse({
            duration: '120 seconds',
            orElse: () => Effect.fail(new Error('host body harness watchdog')),
          }),
          Effect.ensuring(Deferred.succeed(release, undefined)),
          Effect.provideService(LabHostNativeServer, instrument)
        )
      )
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('denies output while a witnessed revocation checkpoint cannot persist, then permits only historical control reads after repair', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-host-revocation-gap-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* generateDevice(),
            peer = yield* generateDevice();
          const membership = ok(Bytes.membershipId(new Uint8Array(16).fill(201)));
          const genesis = yield* signGenesisRecord({
            signer: owner,
            initialKey: ok(Bytes.epochKey(new Uint8Array(32).fill(202))),
            membershipId: membership,
            userId: ok(Bytes.userId(new Uint8Array(32).fill(203))),
            encryptionPublicKey: owner.enc,
          });
          const host = yield* makeLabHostSession({
            directory: join(directory, 'host'),
            mode: 'create',
            genesisRecord: genesis.record,
            now: () => 0,
            resources: { loro: 'revocation-loro', flock: 'revocation-flock' },
            budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
          });
          const identity = yield* makeLabHttpIdentity({
            baseUrl: host.baseUrl,
            genesis: genesis.genesis,
          });
          const unbound = yield* identity.authenticate(owner, 'unbound');
          yield* unbound.createWorkspace(genesis.record);
          const initial = ok(
            verifyLedger({
              anchor: genesis.genesis,
              records: [genesis.record],
              checkpoint: { head: hashRecordBytes(genesis.record), length: 1 },
            })
          );
          const proof = yield* prepareDeviceAdmission({
            genesis: genesis.genesis,
            membershipId: membership,
            signer: peer,
            encryptionPublicKey: peer.enc,
            kind: 'personal',
          });
          const admitted = yield* signLedgerRecord(
            ok(prepareLedgerCommand(initial, owner.publicKey, proof)),
            owner
          );
          const position = (yield* host.current()).offset;
          const inserted = yield* Effect.promise(() =>
            host.creation.stream.appendCas({
              expectedOffset: position,
              part: {
                contentType: 'application/octet-stream',
                body: ok(frameLedgerRecord(admitted)),
              },
            })
          );
          expect(inserted.ok && inserted.result.kind).toBe('ok');
          yield* host.creation.refresh();
          const before = ok(
            verifyLedger({
              anchor: genesis.genesis,
              records: [genesis.record, admitted],
              checkpoint: { head: hashRecordBytes(admitted), length: 2 },
            })
          );
          const revoked = yield* signLedgerRecord(
            ok(
              prepareLedgerCommand(before, owner.publicKey, {
                _tag: 'RevokeDevice',
                target: peer.publicKey,
              })
            ),
            owner
          );
          const ownerAuth = yield* identity.authenticate(owner),
            peerAuth = yield* identity.authenticate(peer);
          const org = Buffer.from(genesis.genesis.toBytes()).toString('hex');
          const allowed = yield* Effect.promise(() =>
            peerAuth.fetch(`${host.baseUrl}/ds/${org}/control?offset=-1`)
          );
          expect(allowed.status).toBe(200);
          yield* Effect.promise(() => allowed.body?.cancel() ?? Promise.resolve());
          const fault = new Database(join(directory, 'host', 'creation.sqlite'));
          try {
            fault.exec(
              'CREATE TRIGGER deny_checkpoint BEFORE UPDATE ON creation BEGIN SELECT RAISE(IGNORE); END'
            );
          } finally {
            fault.close();
          }
          const sdk = new StreamsClient({
            url: `${host.baseUrl}/ds/${org}/control`,
            fetch: ownerAuth.fetch,
            retry: { maxAttempts: 1 },
          });
          const failedAck = yield* Effect.promise(() =>
            sdk.appendCas({
              expectedOffset:
                inserted.ok && inserted.result.kind === 'ok'
                  ? inserted.result.value.nextOffset
                  : '-1',
              part: {
                contentType: 'application/octet-stream',
                body: ok(frameLedgerRecord(revoked)),
              },
            })
          );
          expect(failedAck.ok).toBe(false);
          const native = new StreamsClient({
            url: `${host.nativeBaseUrl}/ds/${org}/control`,
            retry: { maxAttempts: 1 },
          });
          const actual = yield* Effect.promise(() => native.read({ offset: '-1' }));
          expect(actual.ok && actual.result.payload.body).toEqual(
            new Uint8Array(
              Buffer.concat(
                [genesis.record, admitted, revoked].map((record) =>
                  Buffer.from(ok(frameLedgerRecord(record)))
                )
              )
            )
          );
          for (const [method, suffix] of [
            ['GET', 'control?offset=-1'],
            ['PUT', 'loro'],
          ] as const) {
            const denied = yield* Effect.promise(() =>
              peerAuth.fetch(`${host.baseUrl}/ds/${org}/${suffix}`, {
                method,
                headers: { 'content-type': 'application/octet-stream' },
              })
            );
            expect(denied.status).toBeGreaterThanOrEqual(400);
            yield* Effect.promise(() => denied.body?.cancel() ?? Promise.resolve());
          }
          expect(Result.isFailure(yield* Effect.result(host.current()))).toBe(true);
          const repair = new Database(join(directory, 'host', 'creation.sqlite'));
          try {
            repair.exec('DROP TRIGGER deny_checkpoint');
          } finally {
            repair.close();
          }
          yield* host.creation.refresh();
          const learned = yield* Effect.promise(() =>
            new StreamsClient({
              url: `${host.baseUrl}/ds/${org}/control`,
              fetch: peerAuth.fetch,
              retry: { maxAttempts: 1 },
            }).read({ offset: '-1' })
          );
          expect(learned.ok).toBe(true);
          if (!learned.ok || !actual.ok) throw new Error('actual signed revocation bytes required');
          expect(learned.result.payload.body).toEqual(actual.result.payload.body);
          const removed = ok(
            verifyLedger({
              anchor: genesis.genesis,
              records: [genesis.record, admitted, revoked],
              checkpoint: { head: hashRecordBytes(revoked), length: 3 },
            })
          );
          expect(
            removed
              .inspectState()
              .devices.has(Buffer.from(peer.publicKey.toBytes()).toString('hex'))
          ).toBe(false);
          const denied = yield* Effect.promise(() =>
            peerAuth.fetch(`${host.baseUrl}/ds/${org}/loro`)
          );
          expect(denied.status).toBe(403);
          yield* Effect.promise(() => denied.body?.cancel() ?? Promise.resolve());
          yield* host.close();
        })
      )
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('rereads native control before authorizing a new content stream and refuses malformed backend additions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-host-native-authority-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* generateDevice();
          const genesis = yield* signGenesisRecord({
            signer: owner,
            initialKey: ok(Bytes.epochKey(new Uint8Array(32).fill(221))),
            encryptionPublicKey: owner.enc,
            membershipId: ok(Bytes.membershipId(new Uint8Array(16).fill(222))),
            userId: ok(Bytes.userId(new Uint8Array(32).fill(223))),
          });
          const host = yield* makeLabHostSession({
            directory: join(directory, 'host'),
            mode: 'create',
            genesisRecord: genesis.record,
            now: () => 0,
            resources: { loro: 'native-loro', flock: 'native-flock' },
            budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
          });
          const identity = yield* makeLabHttpIdentity({
            baseUrl: host.baseUrl,
            genesis: genesis.genesis,
          });
          const unbound = yield* identity.authenticate(owner, 'unbound');
          yield* unbound.createWorkspace(genesis.record);
          const ownerAuth = yield* identity.authenticate(owner);
          const org = Buffer.from(genesis.genesis.toBytes()).toString('hex');
          const native = new StreamsClient({
            url: `${host.nativeBaseUrl}/ds/${org}/control`,
            retry: { maxAttempts: 1 },
          });
          // Backend attacker capability, not a client fallback or alternate authority.
          const injected = yield* Effect.promise(() =>
            native.append({
              part: {
                contentType: 'application/octet-stream',
                body: new Uint8Array([0, 0, 0, 1, 0]),
              },
            })
          );
          expect(injected.ok).toBe(true);
          const blocked = yield* Effect.promise(() =>
            ownerAuth.fetch(`${host.baseUrl}/ds/${org}/flock`, {
              method: 'PUT',
              headers: { 'content-type': 'application/octet-stream' },
            })
          );
          expect(blocked.status).toBeGreaterThanOrEqual(400);
          yield* Effect.promise(() => blocked.body?.cancel() ?? Promise.resolve());
          const untouched = yield* Effect.promise(() =>
            fetch(`${host.nativeBaseUrl}/ds/${org}/flock`, { method: 'HEAD' })
          );
          expect(untouched.status).toBe(404);
          yield* Effect.promise(() => untouched.body?.cancel() ?? Promise.resolve());
          yield* host.close();
        })
      )
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
