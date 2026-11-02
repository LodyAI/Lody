import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Deferred, Effect, Exit, Fiber, Result, Scope } from 'effect';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setEd25519WasmEnabled } from '@lody/e2ee-core/internal';
import { Bytes } from '@lody/e2ee-core';
import { encodeCbor, type CborValue } from '@lody/e2ee-core/protocol';
import { contentPermissions } from '@lody/e2ee-core/protocol';
import { prepareLedgerRecord, signLedgerRecord } from '@lody/e2ee-core/protocol';
import { commitEpochKey, sealHistoryPacket } from '@lody/e2ee-core/protocol';
import { makeStreamsUpdateBinding } from '@lody/e2ee-core/adapters/loro-streams';
import { makeLabContentGateway } from '../src/platform/content-gateway';
import { makeLabScenarioFixture } from '../src/platform/scenario-fixture';
import { openLabExistingWorkspace } from '../src/platform/workspace-session';
import { makeLabHttpIdentity } from '../src/platform/http-identity';
import { history } from './ledger-fixture';

const ok = Result.getOrThrow;

describe('on the Web Crypto fallback (no WebAssembly verifier)', () => {
  // These tests pause native Web Crypto verification; the WebAssembly verifier is synchronous.
  beforeAll(() => setEd25519WasmEnabled(false));
  afterAll(() => setEd25519WasmEnabled(true));
  it('rechecks genuine current permission after native verification settles and never forwards a writer revoked during the await', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lab-content-admission-revoke-'));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* makeLabScenarioFixture(join(root, 'fixture'));
            const control = yield* openLabExistingWorkspace(f.input('owner', 'create'));
            const gateway = yield* makeLabContentGateway({
              genesis: f.genesis,
              resource: 'document-A',
              model: 'loro',
              baseUrl: f.server.baseUrl,
              ledger: f.ledger,
            });
            // Explicit pre-authenticated principal; this test owns current write
            // admission, while the fixture's real control path authenticates CAS.
            const credential = {
              account: 'synthetic-peer',
              token: '',
              issuedAt: 0,
              expiresAt: 1,
              device: f.peer.publicKey,
              genesis: f.genesis,
            };
            const request = { credential, requestGenesis: f.genesis };
            expect(
              (yield* gateway.write({ ...request, method: 'PUT', body: new Uint8Array() })).status
            ).toBe(201);
            const org = Buffer.from(f.genesis.toBytes()).toString('hex');
            const remote = yield* Effect.acquireRelease(
              Effect.sync(
                () =>
                  new Database(join(f.directory, 'riverrun.sqlite'), {
                    readonly: true,
                    fileMustExist: true,
                  })
              ),
              (db) => Effect.sync(() => db.close())
            );
            const disk = () =>
              remote
                .prepare(`
            SELECT s.next_offset, count(e.id) AS entries,
              coalesce(sum(length(e.body)),0) AS bytes
            FROM streams s LEFT JOIN entries e ON e.stream_id_fk=s.id
            WHERE s.bucket_id=? AND s.stream_id='loro' GROUP BY s.id
          `)
                .get(org);
            const read = async () => {
              const response = await fetch(`${f.server.baseUrl}/ds/${org}/loro?offset=-1`);
              return {
                status: response.status,
                offset: response.headers.get('stream-next-offset'),
                body: new Uint8Array(await response.arrayBuffer()),
              };
            };
            const before = disk(),
              beforeBody = yield* Effect.promise(read);
            expect(before).toEqual({ next_offset: 0, entries: 0, bytes: 0 });
            expect(beforeBody.status).toBe(200);
            expect(beforeBody.body).toEqual(new Uint8Array());
            expect(ok(contentPermissions(f.view(), f.peer.publicKey)).maySealNewContent).toBe(true);

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
              readEpochKey: () =>
                Effect.sync(() => ok(Bytes.epochKey(new Uint8Array(32).fill(117)))),
            });
            const sealed = yield* binding.seal({
              context: {
                protocol: 'loro-streams-crdt-payload-protection',
                version: 2,
                kind: 'update_batch',
              },
              // Bypass the <=8192-byte mathematical tuple cache, including the
              // successful fixed verification already performed while signing.
              plaintext: new Uint8Array(9000).fill(104),
              additionalData: () => aad,
            });
            const body = new Uint8Array(4 + prefix.length + sealed.sealed.length);
            new DataView(body.buffer).setUint32(0, body.length - 4, false);
            body.set(prefix, 4);
            body.set(sealed.sealed, 4 + prefix.length);

            const verified = yield* Deferred.make<boolean>();
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
              release = resolve;
            });
            const verifyNative = crypto.subtle.verify.bind(crypto.subtle);
            const spy = vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
              const valid = await verifyNative(...args);
              if (args[3].byteLength > 8192) {
                Deferred.doneUnsafe(verified, Effect.succeed(valid));
                await gate;
              }
              return valid;
            });
            yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
            const pending = yield* Effect.forkChild(
              Effect.result(gateway.write({ ...request, method: 'POST', body }))
            );
            // Registered after the worker: assertion failure releases its actual
            // native completion gate before Scope waits for that worker to close.
            yield* Effect.addFinalizer(() => Effect.sync(release));
            expect(yield* Deferred.await(verified)).toBe(true);
            expect(pending.pollUnsafe()).toBeUndefined();
            expect(disk()).toEqual(before);

            const revoked = yield* control.control.execute({
              _tag: 'RevokeDevice',
              target: f.peer.publicKey,
            });
            expect(revoked.outcome).toBe('Committed');
            yield* control.control.acknowledge(revoked);
            expect(ok(contentPermissions(f.view(), f.peer.publicKey)).maySealNewContent).toBe(
              false
            );
            release();
            const result = yield* Fiber.join(pending);
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result))
              expect(result.failure).toMatchObject({ _tag: 'LabContentGatewayError', status: 403 });
            expect(disk()).toEqual(before);
            expect(yield* Effect.promise(read)).toEqual(beforeBody);
          })
        )
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it('uploads the original HTTP batch during required rotation and after tag7/tag8 without restoring forbidden writers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-content-upload-epoch-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture'), [
            { id: 'owner', role: 'owner' },
            { id: 'peer', role: 'owner', memberOf: 'owner' },
            { id: 'guest', role: 'guest' },
            { id: 'recovery', role: 'owner', kind: 'recovery', memberOf: 'owner' },
          ]);
          const owner = yield* openLabExistingWorkspace(f.input('owner', 'create'));
          const identity = yield* makeLabHttpIdentity({
            baseUrl: f.host.baseUrl,
            genesis: f.genesis,
          });
          const forbidden = [];
          for (const actor of ['peer', 'guest', 'recovery'])
            forbidden.push(yield* identity.authenticate(f.devices.get(actor)!));
          const org = Buffer.from(f.genesis.toBytes()).toString('hex');
          const url = `${f.host.baseUrl}/ds/${org}/loro`;
          const request = (transport: typeof fetch, method: 'PUT' | 'POST', body?: Uint8Array) =>
            Effect.tryPromise({
              try: async () => {
                const reply = await transport(url, {
                  method,
                  headers: { 'content-type': 'application/octet-stream' },
                  body: body === undefined ? undefined : Buffer.from(body),
                });
                await reply.body?.cancel();
                return reply.status;
              },
              catch: (cause) => cause,
            });
          expect(yield* request(owner.identity.fetch, 'PUT')).toBe(201);
          const prefix = new Uint8Array([76, 83, 67, 69, 2, 1, 0, 1, 0, 0, 3]);
          const aad = new Uint8Array(
            Buffer.concat([Buffer.from('loro-streams-crdt-payload-protection/v2\0'), prefix])
          );
          const binding = yield* makeStreamsUpdateBinding({
            genesis: f.genesis,
            resource: 'document-A',
            model: 'loro',
            writeEpoch: 0,
            signer: f.owner,
            ledger: f.ledger,
            readEpochKey: () => Effect.sync(() => ok(Bytes.epochKey(new Uint8Array(32).fill(117)))),
          });
          const sealed = yield* binding.seal({
            context: {
              protocol: 'loro-streams-crdt-payload-protection',
              version: 2,
              kind: 'update_batch',
            },
            plaintext: new TextEncoder().encode('prepared before rotation'),
            additionalData: () => aad,
          });
          const original = new Uint8Array(4 + prefix.length + sealed.sealed.length);
          new DataView(original.buffer).setUint32(0, original.length - 4, false);
          original.set(prefix, 4);
          original.set(sealed.sealed, 4 + prefix.length);
          const disk = yield* Effect.acquireRelease(
            Effect.sync(
              () => new Database(join(f.directory, 'riverrun.sqlite'), { readonly: true })
            ),
            (db) => Effect.sync(() => db.close())
          );
          const originals = () =>
            (
              disk
                .prepare(`SELECT e.body FROM entries e JOIN streams s ON e.stream_id_fk=s.id
              WHERE s.bucket_id=? AND s.stream_id='loro' ORDER BY e.id`)
                .all(org) as { body: Uint8Array }[]
            ).map((row) => new Uint8Array(row.body));
          expect(originals()).toEqual([]);
          const revoked = yield* owner.control.execute({
            _tag: 'RevokeDevice',
            target: f.peer.publicKey,
          });
          expect(revoked.outcome).toBe('Committed');
          yield* owner.control.acknowledge(revoked);
          expect(f.view().inspectState().epoch.rotationRequired).toBe(true);
          expect(yield* request(owner.identity.fetch, 'POST', original)).toBe(204);
          expect(originals()).toEqual([original]);
          const availableSeal = yield* Effect.result(
            binding.seal({
              context: {
                protocol: 'loro-streams-crdt-payload-protection',
                version: 2,
                kind: 'update_batch',
              },
              plaintext: new Uint8Array([1]),
              additionalData: () => aad,
            })
          );
          const pendingSeal = ok(availableSeal);
          expect(
            yield* binding.open({
              ...pendingSeal,
              context: {
                protocol: 'loro-streams-crdt-payload-protection',
                version: 2,
                kind: 'update_batch',
              },
              additionalData: aad,
            })
          ).toEqual(new Uint8Array([1]));
          for (const auth of forbidden) {
            // Empty PUT has no frame/signature mismatch to conceal the role check.
            expect(yield* request(auth.fetch, 'PUT')).toBe(403);
            expect(yield* request(auth.fetch, 'POST', original)).toBe(403);
          }
          expect(originals()).toEqual([original]);
          for (const tag of [7, 8] as const) {
            const epoch = tag === 7 ? 1 : 2;
            const currentKey = ok(Bytes.epochKey(new Uint8Array(32).fill(117 + epoch)));
            const previousKey = ok(Bytes.epochKey(new Uint8Array(32).fill(116 + epoch)));
            const tail: readonly CborValue[] = [
              epoch,
              ok(commitEpochKey(f.genesis, epoch, currentKey)).toBytes(),
              ok(sealHistoryPacket({ genesis: f.genesis, epoch, currentKey, previousKey })),
            ];
            const operation: readonly CborValue[] =
              tag === 7 ? [7, ...tail] : [8, f.memberships.get('guest')!.toBytes(), ...tail];
            const record = yield* signLedgerRecord(
              ok(
                prepareLedgerRecord(
                  f.view(),
                  ok(encodeCbor([f.point().head.toBytes(), f.owner.publicKey.toBytes(), operation]))
                )
              ),
              f.owner
            );
            const committed = yield* owner.control.executeOriginal(record);
            expect(committed.outcome).toBe('Committed');
            yield* owner.control.acknowledge(committed);
            expect(f.view().inspectState().epoch).toMatchObject({
              number: epoch,
              rotationRequired: false,
            });
            expect(yield* request(owner.identity.fetch, 'POST', original)).toBe(204);
            expect(originals()).toEqual(Array.from({ length: epoch + 1 }, () => original));
          }
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('owns chunked reply bytes and preserves an absent body and selected headers', async () => {
  const f = history();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 127]));
      controller.enqueue(new Uint8Array([128, 255]));
      controller.close();
    },
  });
  const responses = [
    new Response(body, {
      status: 202,
      headers: { 'content-type': 'application/octet-stream', 'stream-next-offset': '4' },
    }),
    new Response(null, { status: 204 }),
  ];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* makeLabContentGateway({
          genesis: f.anchor,
          resource: 'document-A',
          model: 'loro',
          baseUrl: 'http://127.0.0.1',
          ledger: () => Effect.succeed(f.view),
          fetch: async () => responses.shift()!,
        });
        const request = {
          credential: {
            account: 'synthetic-owner',
            token: '',
            issuedAt: 0,
            expiresAt: 1,
            device: f.owner.publicKey,
            genesis: f.anchor,
          },
          requestGenesis: f.anchor,
          method: 'PUT' as const,
          body: new Uint8Array(),
        };
        const reply = yield* gateway.write(request);
        expect(reply).toMatchObject({
          status: 202,
          body: new Uint8Array([0, 127, 128, 255]),
          headers: [
            ['content-type', 'application/octet-stream'],
            ['stream-next-offset', '4'],
          ],
        });
        expect(body.locked).toBe(false);
        const empty = yield* gateway.write(request);
        expect(empty.status).toBe(204);
        expect(empty.body).toEqual(new Uint8Array());
      })
    )
  );
});

it('awaits rejected overflow cancellation and releases its reader before earlier owners close', async () => {
  const f = history();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let cancelSettled = false,
    earlierClosed = false,
    closedEarly = false;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* Scope.make();
        yield* Scope.addFinalizer(
          child,
          Effect.sync(() => {
            earlierClosed = true;
            closedEarly = !cancelSettled;
          })
        );
        const cancelling = yield* Deferred.make<void>(),
          aborted = yield* Deferred.make<void>();
        const readerBody = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(64 * 1024 + 1));
          },
          async cancel() {
            Deferred.doneUnsafe(cancelling, Effect.void);
            await gate;
            cancelSettled = true;
            throw new Error('synthetic-cancel-failure');
          },
        });
        const gateway = yield* makeLabContentGateway({
          genesis: f.anchor,
          resource: 'document-A',
          model: 'loro',
          baseUrl: 'http://127.0.0.1',
          ledger: () => Effect.succeed(f.view),
          fetch: async (_input, init) => {
            init!.signal!.addEventListener(
              'abort',
              () => {
                Deferred.doneUnsafe(aborted, Effect.void);
              },
              { once: true }
            );
            return new Response(readerBody);
          },
        }).pipe(Effect.provideService(Scope.Scope, child));
        const worker = yield* Effect.forkChild(
          gateway.write({
            credential: {
              account: 'synthetic-owner',
              token: '',
              issuedAt: 0,
              expiresAt: 1,
              device: f.owner.publicKey,
              genesis: f.anchor,
            },
            requestGenesis: f.anchor,
            method: 'PUT',
            body: new Uint8Array(),
          })
        );
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            release();
            yield* Scope.close(child, Exit.void);
          })
        );
        yield* Deferred.await(cancelling);
        const closing = yield* Effect.forkChild(Scope.close(child, Exit.void), {
          startImmediately: true,
        });
        yield* Deferred.await(aborted);
        expect(closing.pollUnsafe()).toBeUndefined();
        expect(readerBody.locked).toBe(true);
        expect(earlierClosed).toBe(false);
        release();
        yield* Fiber.join(closing);
        expect(cancelSettled).toBe(true);
        expect(readerBody.locked).toBe(false);
        expect(earlierClosed).toBe(true);
        expect(closedEarly).toBe(false);
        expect(Exit.isFailure(yield* Fiber.await(worker))).toBe(true);
      })
    )
  );
});
