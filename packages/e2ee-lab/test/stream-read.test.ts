import { join } from 'node:path';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { Bytes } from '@lody/e2ee-core';
import { extendLedger, hashRecordBytes } from '@lody/e2ee-core/protocol';
import { prepareDeviceAdmission, prepareLedgerCommand } from '@lody/e2ee-core/protocol';
import { signLedgerRecord } from '@lody/e2ee-core/protocol';
import { Deferred, Effect, Exit, Fiber, Result, Scope } from 'effect';
import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import Database from 'better-sqlite3';
import { StreamsClient } from '@loro-dev/streams-client';
import { frameLedgerRecord } from '@lody/e2ee-core/protocol';
import { fixture, options } from './ledger-fixture';
import { makeLabStreamReader } from '../src/platform/stream-read';
import { makeAuthenticatedLabMailbox } from './authenticated-mailbox-fixture';
import { makeLabSdkOwner } from '../src/platform/sdk-owner';
import { makeLabLedgerClient } from '../src/platform/ledger-client';
const ok = Result.getOrThrow;
async function readFixture() {
  const f = await fixture(),
    org = Buffer.from(f.anchor.toBytes()).toString('hex');
  const clients: StreamsClient[] = []; // HTTP facades, no native lifecycle dispose; close() is protocol EOF.
  try {
    expect((await fetch(`${f.server.baseUrl}/ds/${org}`, { method: 'PUT' })).ok).toBe(true);
    for (const stream of ['control', 'loro', 'flock']) {
      const sdk = new StreamsClient({
        url: `${f.server.baseUrl}/ds/${org}/${stream}`,
        retry: { maxAttempts: 1 },
      });
      clients.push(sdk);
      expect((await sdk.create({ contentType: 'application/octet-stream' })).ok).toBe(true);
    }
    const control = clients[0]!,
      loro = clients[1]!,
      flock = clients[2]!;
    for (const record of f.records)
      expect(
        (
          await control.append({
            part: { contentType: 'application/octet-stream', body: ok(frameLedgerRecord(record)) },
          })
        ).ok
      ).toBe(true);
    return {
      ...f,
      org,
      control,
      loro,
      flock,
      close: f.close,
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
describe('actual authenticated finite SDK read routes, not snapshot authority', () => {
  it('passes released SDK head/read/bootstrap into the public durable feed and rejects a repeated old record at a new native offset without cursor advance', async () => {
    const f = await readFixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* makeLabStreamReader({
              genesis: f.anchor,
              baseUrl: f.server.baseUrl,
              maxBytes: 1024 * 1024,
              ledger: () => Effect.succeed(f.view),
            });
            const host = yield* makeAuthenticatedLabMailbox({
              directory: f.dir,
              mode: 'create',
              genesis: f.anchor,
              ledger: () => Effect.succeed(f.view),
              streams: reader,
            });
            const auth = yield* host.authenticate(f.owner);
            const url = host.url.replace(`/v1/spaces/${f.org}/key-mailbox`, `/ds/${f.org}/control`);
            const sdk = yield* makeLabSdkOwner(() => ({
              client: new StreamsClient({ url, fetch: auth.fetch, retry: { maxAttempts: 1 } }),
              close: async () => undefined,
            }));
            const head = yield* sdk.invoke(({ client }) => client.head());
            expect(head.ok).toBe(true);
            const bootstrap = yield* sdk.invoke(({ client }) =>
              client.bootstrap({ signal: sdk.signal })
            );
            expect(bootstrap.ok).toBe(true);
            if (bootstrap.ok) expect(bootstrap.result.snapshot).toBeNull();
            const client = yield* makeLabLedgerClient({
              ...options(f, 'create'),
              stream: {
                read: (request) =>
                  Effect.runPromise(
                    sdk.invoke(({ client: source }) =>
                      source.read({
                        ...request,
                        signal: AbortSignal.any([request.signal, sdk.signal]),
                      })
                    )
                  ),
              },
            });
            const first = yield* client.read(f.checkpoint);
            expect(first.view.head.equals(f.view.head)).toBe(true);
            const append = yield* Effect.promise(() =>
              f.control.append({
                part: {
                  contentType: 'application/octet-stream',
                  body: ok(frameLedgerRecord(f.rotate)),
                },
              })
            );
            expect(append.ok).toBe(true);
            expect(Result.isFailure(yield* Effect.result(client.read(f.checkpoint)))).toBe(true);
            const retained = yield* client.current();
            expect(retained.offset).toBe(first.offset);
            expect(retained.view.length).toBe(2);
            expect(retained.view.head.equals(first.view.head)).toBe(true);
          })
        )
      );
    } finally {
      await f.close();
    }
  });
  it('preserves actual latest/specific snapshot and multipart metadata, refuses anonymous/query/write routes, and keeps body limits explicit', async () => {
    const f = await readFixture();
    const snapshot = new Uint8Array([9, 8, 7]);
    try {
      // Opaque unprotected transport fixture only, never a protected snapshot endorsement.
      const nativeHead = await f.loro.head();
      expect(nativeHead.ok).toBe(true);
      if (!nativeHead.ok) throw new Error('synthetic stream head refused');
      // SDK0.9 putSnapshot echoes its input; use the server-returned opaque HEAD token.
      const stored = await f.loro.putSnapshot({
        offset: nativeHead.result.nextOffset,
        part: { contentType: 'application/octet-stream', body: snapshot },
      });
      expect(stored.ok).toBe(true);
      if (!stored.ok) throw new Error('synthetic snapshot fixture refused');
      const snapshotOffset = stored.result.snapshotOffset;
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* makeLabStreamReader({
              genesis: f.anchor,
              baseUrl: f.server.baseUrl,
              maxBytes: 1024 * 1024,
              ledger: () => Effect.succeed(f.view),
            });
            const host = yield* makeAuthenticatedLabMailbox({
              directory: f.dir,
              mode: 'create',
              genesis: f.anchor,
              ledger: () => Effect.succeed(f.view),
              streams: reader,
            });
            const auth = yield* host.authenticate(f.owner);
            const url = host.url.replace(`/v1/spaces/${f.org}/key-mailbox`, `/ds/${f.org}/loro`);
            const sdk = yield* makeLabSdkOwner(() => ({
              client: new StreamsClient({ url, fetch: auth.fetch, retry: { maxAttempts: 1 } }),
              close: async () => undefined,
            }));
            const latest = yield* sdk.invoke(({ client }) =>
              client.readLatestSnapshot({ signal: sdk.signal })
            );
            expect(latest.ok).toBe(true);
            if (latest.ok) {
              expect(latest.result?.snapshotOffset).toBe(snapshotOffset);
              expect(latest.result?.payload.body).toEqual(snapshot);
            }
            const exact = yield* sdk.invoke(({ client }) =>
              client.readSnapshot(snapshotOffset, { signal: sdk.signal })
            );
            expect(exact.ok).toBe(true);
            if (exact.ok) expect(exact.result.payload.body).toEqual(snapshot);
            const bootstrap = yield* sdk.invoke(({ client }) =>
              client.bootstrap({ signal: sdk.signal })
            );
            expect(bootstrap.ok).toBe(true);
            if (bootstrap.ok) {
              expect(bootstrap.result.snapshotOffset).toBe(snapshotOffset);
              expect(bootstrap.result.snapshot?.body).toEqual(snapshot);
            }
            const raw = yield* makeLabSdkOwner(() => ({ close: async () => undefined }));
            const status = (target: string, transport: typeof fetch, method = 'GET') =>
              raw.invoke(async () => {
                const response = await transport(target, { method, signal: raw.signal });
                await response.arrayBuffer();
                return response.status;
              });
            expect(yield* status(url + '?offset=0', fetch)).toBe(401);
            expect(yield* status(url + '?offset=0&offset=1', auth.fetch)).toBe(400);
            expect(yield* status(url, auth.fetch, 'PUT')).toBe(404);
            const bounded = yield* makeLabStreamReader({
              genesis: f.anchor,
              baseUrl: f.server.baseUrl,
              maxBytes: 1,
              ledger: () => Effect.succeed(f.view),
            });
            const failure = yield* Effect.result(
              bounded.read({
                credential: {
                  token: 'synthetic',
                  account: 'fixture',
                  device: f.owner.publicKey,
                  genesis: f.anchor,
                  issuedAt: 0,
                  expiresAt: 100,
                },
                method: 'GET',
                stream: 'loro',
                sub: 'snapshot',
                snapshotOffset,
                query: '',
              })
            );
            expect(Result.isFailure(failure)).toBe(true);
            if (Result.isFailure(failure))
              expect((failure.failure as { status: number }).status).toBe(413);
          })
        )
      );
    } finally {
      await f.close();
    }
  });
  it('refuses snapshot redirects to another origin/Org/stream without touching actual endpoint storage', async () => {
    const f = await readFixture(),
      db = new Database(join(f.dir, 'redirect-audit.sqlite'));
    db.exec('CREATE TABLE visited(path TEXT NOT NULL) STRICT');
    let location = '';
    const target = createServer((request, response) => {
      db.prepare('INSERT INTO visited(path) VALUES(?)').run(request.url ?? '');
      response.writeHead(200, { 'stream-next-offset': '0', 'stream-snapshot-offset': '0' });
      response.end('unexpected');
    });
    const source = createServer((request, response) => {
      if (request.url === `/ds/${f.org}/loro/snapshot`) {
        response.writeHead(307, { location });
        response.end();
      } else {
        db.prepare('INSERT INTO visited(path) VALUES(?)').run(request.url ?? '');
        response.writeHead(200, { 'stream-next-offset': '0', 'stream-snapshot-offset': '0' });
        response.end('unexpected');
      }
    });
    const listen = (server: Server) =>
      new Promise<string>((resolve, reject) => {
        const fail = (error: Error) => reject(error);
        server.once('error', fail);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', fail);
          const address = server.address();
          if (!address || typeof address === 'string')
            return reject(new Error('missing local fixture port'));
          resolve(`http://127.0.0.1:${address.port}`);
        });
      });
    const close = (server: Server) =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    try {
      const targetUrl = await listen(target),
        sourceUrl = await listen(source);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* makeLabStreamReader({
              genesis: f.anchor,
              baseUrl: sourceUrl,
              maxBytes: 1024,
              ledger: () => Effect.succeed(f.view),
            });
            const credential = {
              token: 'synthetic',
              account: 'fixture',
              device: f.owner.publicKey,
              genesis: f.anchor,
              issuedAt: 0,
              expiresAt: 100,
            };
            for (const candidate of [
              `${targetUrl}/ds/${f.org}/loro/snapshot/0`,
              `${sourceUrl}/ds/${'ef'.repeat(32)}/loro/snapshot/0`,
              `${sourceUrl}/ds/${f.org}/flock/snapshot/0`,
              `${sourceUrl}/ds/${f.org}/loro/snapshot/0?offset=1`,
              `${sourceUrl}/ds/${f.org}/loro/snapshot/0#other`,
            ]) {
              location = candidate;
              const result = yield* Effect.result(
                reader.read({
                  credential,
                  method: 'GET',
                  stream: 'loro',
                  sub: 'snapshot',
                  query: '',
                })
              );
              expect(db.prepare('SELECT count(*) AS n FROM visited').get()).toEqual({ n: 0 });
              expect(Result.isFailure(result)).toBe(true);
              if (Result.isFailure(result))
                expect((result.failure as { status: number }).status).toBe(502);
            }
          })
        )
      );
    } finally {
      try {
        await Promise.all([close(source), close(target)]);
      } finally {
        db.close();
        await f.close();
      }
    }
  });
  it('lets a historically known device read and persist its signed revocation while refusing protected content after the body lease', async () => {
    const f = await readFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const key = createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.alloc(32, 121),
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    const machine = {
      publicKey: ok(
        Bytes.signingPublicKey(
          new Uint8Array(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32))
        )
      ),
      sign: (message: Uint8Array) =>
        Effect.sync(() => ok(Bytes.signature(new Uint8Array(sign(null, message, key))))),
    };
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const admit = yield* prepareDeviceAdmission({
              genesis: f.anchor,
              membershipId: f.membership,
              encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(122))),
              kind: 'machine',
              machineId: 'synthetic-machine',
              signer: machine,
            });
            const admission = yield* signLedgerRecord(
              ok(prepareLedgerCommand(f.view, f.owner.publicKey, admit)),
              f.owner
            );
            let current = ok(
              extendLedger(f.view, [admission], { head: hashRecordBytes(admission), length: 3 })
            );
            expect(
              (yield* Effect.promise(() =>
                f.control.append({
                  part: {
                    contentType: 'application/octet-stream',
                    body: ok(frameLedgerRecord(admission)),
                  },
                })
              )).ok
            ).toBe(true);
            const entered = yield* Deferred.make<void>();
            const reader = yield* makeLabStreamReader({
              genesis: f.anchor,
              baseUrl: f.server.baseUrl,
              maxBytes: 1024 * 1024,
              ledger: () => Effect.succeed(current),
              fetch: async (url, init) => {
                const response = await fetch(url, init);
                // A controlled delivery gate over actual HTTP bytes, not a mock SDK/payload.
                const body = await response.arrayBuffer();
                Deferred.doneUnsafe(entered, Exit.void);
                await gate;
                return new Response(body, { status: response.status, headers: response.headers });
              },
            });
            const host = yield* makeAuthenticatedLabMailbox({
              directory: f.dir,
              mode: 'create',
              genesis: f.anchor,
              ledger: () => Effect.succeed(current),
              streams: reader,
            });
            const auth = yield* host.authenticate(machine);
            const url = host.url.replace(`/v1/spaces/${f.org}/key-mailbox`, `/ds/${f.org}/control`);
            const sdk = yield* makeLabSdkOwner(() => ({
              client: new StreamsClient({ url, fetch: auth.fetch, retry: { maxAttempts: 1 } }),
              close: async () => undefined,
            }));
            const client = yield* makeLabLedgerClient({
              ...options(f, 'create'),
              stream: {
                read: (request) =>
                  Effect.runPromise(
                    sdk.invoke(({ client: source }) =>
                      source.read({
                        ...request,
                        signal: AbortSignal.any([request.signal, sdk.signal]),
                      })
                    )
                  ),
              },
            });
            const before = yield* client.current();
            const worker = yield* Effect.result(
              client.read({ head: current.head, length: 3 })
            ).pipe(Effect.forkChild);
            yield* Effect.addFinalizer(() => Effect.sync(release));
            yield* Deferred.await(entered);
            const revoked = yield* signLedgerRecord(
              ok(
                prepareLedgerCommand(current, f.owner.publicKey, {
                  _tag: 'RevokeDevice',
                  target: machine.publicKey,
                })
              ),
              f.owner
            );
            expect(
              (yield* Effect.promise(() =>
                f.control.append({
                  part: {
                    contentType: 'application/octet-stream',
                    body: ok(frameLedgerRecord(revoked)),
                  },
                })
              )).ok
            ).toBe(true);
            current = ok(
              extendLedger(current, [revoked], { head: hashRecordBytes(revoked), length: 4 })
            );
            release();
            const prior = yield* Fiber.join(worker);
            expect(Result.isSuccess(prior)).toBe(true);
            if (Result.isSuccess(prior)) expect(prior.success.view.length).toBe(3);
            const observed = yield* client.read({ head: current.head, length: 4 });
            expect(observed.view.head.equals(current.head)).toBe(true);
            expect(observed.view.length).toBe(4);
            expect(
              observed.view
                .inspectState()
                .devices.has(Buffer.from(machine.publicKey.toBytes()).toString('hex'))
            ).toBe(false);
            expect(observed.offset).not.toBe(before.offset);
            const denied = yield* Effect.promise(() => auth.fetch(url.replace(/control$/, 'loro')));
            expect(denied.status).toBe(403);
            yield* Effect.promise(() => denied.body?.cancel() ?? Promise.resolve());
          })
        )
      );
    } finally {
      release();
      await f.close();
    }
  });
  it('aborts and awaits a leased real HTTP response body before the actual Riverrun owner closes', async () => {
    const f = await readFixture();
    let release!: () => void,
      rawSettled = false,
      closedEarly = false,
      disposed = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled!: () => void;
    const rawDone = new Promise<void>((resolve) => {
      settled = resolve;
    });
    let upstream: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const child = Scope.makeUnsafe(),
              entered = yield* Deferred.make<void>(),
              aborted = yield* Deferred.make<void>();
            yield* Scope.addFinalizer(
              child,
              Effect.promise(async () => {
                closedEarly = !rawSettled;
                disposed = true;
                await f.close();
              })
            );
            const reader = yield* makeLabStreamReader({
              genesis: f.anchor,
              baseUrl: f.server.baseUrl,
              maxBytes: 1024 * 1024,
              ledger: () => Effect.succeed(f.view),
              fetch: async (url, init) => {
                init?.signal?.addEventListener(
                  'abort',
                  () => Deferred.doneUnsafe(aborted, Exit.void),
                  { once: true }
                );
                const response = await fetch(url, init);
                if (!response.body) throw new Error('missing real response body');
                upstream = response.body.getReader();
                const bodyOwner = upstream;
                // Explicit controlled wrapper around actual native HTTP body. The gate
                // deliberately ignores abort; no mock success/SDK or call-count assertion.
                return new Response(
                  new ReadableStream<Uint8Array>({
                    async pull(controller) {
                      Deferred.doneUnsafe(entered, Exit.void);
                      await gate;
                      try {
                        const part = await bodyOwner.read();
                        if (part.done) {
                          controller.close();
                          rawSettled = true;
                          settled();
                        } else controller.enqueue(part.value);
                      } catch (error) {
                        controller.error(error);
                        rawSettled = true;
                        settled();
                      }
                    },
                    async cancel(reason) {
                      try {
                        await bodyOwner.cancel(reason);
                      } finally {
                        rawSettled = true;
                        settled();
                      }
                    },
                  }),
                  { status: response.status, headers: response.headers }
                );
              },
            }).pipe(Effect.provideService(Scope.Scope, child));
            const request = {
              credential: {
                token: 'synthetic',
                account: 'fixture',
                device: f.owner.publicKey,
                genesis: f.anchor,
                issuedAt: 0,
                expiresAt: 100,
              },
              method: 'GET',
              stream: 'control',
              query: 'offset=0',
            };
            const worker = yield* reader.read(request).pipe(Effect.forkChild);
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                release();
                yield* Scope.close(child, Exit.void);
              })
            );
            yield* Deferred.await(entered);
            const closing = yield* Effect.forkChild(Scope.close(child, Exit.void), {
              startImmediately: true,
            });
            yield* Deferred.await(aborted);
            expect(Result.isFailure(yield* Effect.result(reader.read(request)))).toBe(true);
            release();
            yield* Fiber.join(closing);
            expect(closedEarly).toBe(false);
            expect(rawSettled).toBe(true);
            expect(disposed).toBe(true);
            expect(Exit.isFailure(yield* Fiber.await(worker))).toBe(true);
          })
        )
      );
    } finally {
      release();
      if (upstream) {
        await rawDone;
        upstream.releaseLock();
      }
      if (!disposed) await f.close();
    }
  });
});
