import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Deferred, Effect, Exit, Fiber, Result, Scope } from 'effect';
import { describe, expect, it } from 'vitest';
import { Bytes } from '@lody/e2ee-core';
import { prepareJoinRequest } from '@lody/e2ee-core/protocol';
import type { LedgerView } from '@lody/e2ee-core';
import { makeLabJoinMailbox, labJoinWire } from '../src/platform/join-mailbox';
import { makeLabCredentials, labPossessionMessage } from '../src/platform/credentials';
import { history, fixture } from './ledger-fixture';
import { makeLabHttpIdentity } from '../src/platform/http-identity';
import { makeAuthenticatedLabMailbox } from './authenticated-mailbox-fixture';
const ok = Result.getOrThrow;
const signer = (seed: number) => {
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, seed),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  return {
    publicKey: ok(
      Bytes.signingPublicKey(
        new Uint8Array(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32))
      )
    ),
    sign: (message: Uint8Array) =>
      Effect.sync(() => ok(Bytes.signature(new Uint8Array(sign(null, message, key))))),
  };
};
describe('public signed Lab join metadata, synthetic account labels only', () => {
  it('durably stores real signed requests, preserves first-label binding and same-ID signer across reopen, and does not grant membership', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-joins-')),
      path = join(dir, 'joins.sqlite'),
      f = history(),
      outsider = signer(124),
      other = signer(125);
    try {
      const request = await Effect.runPromise(
        prepareJoinRequest({
          genesis: f.anchor,
          requestId: ok(Bytes.requestId(new Uint8Array(16).fill(126))),
          userId: ok(Bytes.userId(new Uint8Array(32).fill(127))),
          encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(128))),
          expiresAt: null,
          signer: outsider,
        })
      );
      const conflict = await Effect.runPromise(
        prepareJoinRequest({ ...request, genesis: f.anchor, signer: other })
      );
      for (const mode of ['create', 'open'] as const)
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const mailbox = yield* makeLabJoinMailbox({
                path,
                mode,
                genesis: f.anchor,
                ledger: () => Effect.succeed(f.view),
              });
              const identity = {
                account: 'synthetic-alice',
                device: outsider.publicKey,
                genesis: null,
              };
              yield* mailbox.put(identity, request);
              yield* mailbox.put(identity, request);
              const owner = {
                account: 'synthetic-owner',
                device: f.owner.publicKey,
                genesis: f.anchor,
              };
              expect(yield* mailbox.list(owner)).toEqual([labJoinWire(request)]);
              expect(Result.isFailure(yield* Effect.result(mailbox.list(identity)))).toBe(true);
              expect(
                Result.isFailure(
                  yield* Effect.result(
                    mailbox.put({ ...identity, account: 'synthetic-bob' }, request)
                  )
                )
              ).toBe(true);
              expect(
                Result.isFailure(
                  yield* Effect.result(
                    mailbox.put(
                      { account: 'synthetic-alice', device: other.publicKey, genesis: null },
                      conflict
                    )
                  )
                )
              ).toBe(true);
              const bad = { ...request, userId: ok(Bytes.userId(new Uint8Array(32).fill(254))) };
              expect(Result.isFailure(yield* Effect.result(mailbox.put(identity, bad)))).toBe(true);
              expect(yield* mailbox.list(owner)).toEqual([labJoinWire(request)]);
              expect(
                f.view
                  .inspectState()
                  .devices.has(Buffer.from(outsider.publicKey.toBytes()).toString('hex'))
              ).toBe(false);
            })
          )
        );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('SQL IGNORE of either request or first binding refuses success and rolls back both rows; retry stores both', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-join-ignore-')),
      path = join(dir, 'joins.sqlite'),
      f = history(),
      outsider = signer(129);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const mailbox = yield* makeLabJoinMailbox({
              path,
              mode: 'create',
              genesis: f.anchor,
              ledger: () => Effect.succeed(f.view),
            });
            const request = yield* prepareJoinRequest({
              genesis: f.anchor,
              requestId: ok(Bytes.requestId(new Uint8Array(16).fill(130))),
              userId: ok(Bytes.userId(new Uint8Array(32).fill(131))),
              encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(132))),
              expiresAt: 1,
              signer: outsider,
            });
            const identity = { account: 'synthetic', device: outsider.publicKey, genesis: null };
            const db = new Database(path, { fileMustExist: true });
            try {
              for (const table of ['join_requests', 'join_users']) {
                db.exec(
                  `CREATE TRIGGER ignore_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END;`
                );
                expect(Result.isFailure(yield* Effect.result(mailbox.put(identity, request)))).toBe(
                  true
                );
                expect(db.prepare('SELECT count(*) AS n FROM join_requests').get()).toEqual({
                  n: 0,
                });
                expect(db.prepare('SELECT count(*) AS n FROM join_users').get()).toEqual({ n: 0 });
                db.exec('DROP TRIGGER ignore_write;');
              }
              yield* mailbox.put(identity, request);
              expect(db.prepare('SELECT count(*) AS n FROM join_requests').get()).toEqual({ n: 1 });
              expect(db.prepare('SELECT count(*) AS n FROM join_users').get()).toEqual({ n: 1 });
              db.exec('DELETE FROM join_users;');
              expect(
                Result.isFailure(
                  yield* Effect.result(
                    mailbox.put({ ...identity, account: 'another-synthetic' }, request)
                  )
                )
              ).toBe(true);
              expect(db.prepare('SELECT count(*) AS n FROM join_users').get()).toEqual({ n: 0 });
            } finally {
              db.close();
            }
          })
        )
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses forged ledger provenance and wrong Org rather than trusting structural state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-join-provenance-')),
      f = history(),
      outsider = signer(133);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fake = {
              genesis: f.anchor,
              inspectState: () => f.view.inspectState(),
            } as unknown as LedgerView;
            const mailbox = yield* makeLabJoinMailbox({
              path: join(dir, 'joins.sqlite'),
              mode: 'create',
              genesis: f.anchor,
              ledger: () => Effect.succeed(fake),
            });
            const request = yield* prepareJoinRequest({
              genesis: f.anchor,
              requestId: ok(Bytes.requestId(new Uint8Array(16).fill(134))),
              userId: ok(Bytes.userId(new Uint8Array(32).fill(135))),
              encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(136))),
              expiresAt: null,
              signer: outsider,
            });
            const identity = { account: 'synthetic', device: outsider.publicKey, genesis: null };
            expect(Result.isFailure(yield* Effect.result(mailbox.put(identity, request)))).toBe(
              true
            );
            expect(
              Result.isFailure(
                yield* Effect.result(
                  mailbox.put(
                    { ...identity, genesis: ok(Bytes.genesisHash(new Uint8Array(32).fill(137))) },
                    request
                  )
                )
              )
            ).toBe(true);
            expect(
              Result.isFailure(
                yield* Effect.result(
                  mailbox.list({
                    account: 'synthetic-owner',
                    device: f.owner.publicKey,
                    genesis: f.anchor,
                  })
                )
              )
            ).toBe(true);
          })
        )
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('uses real possession/bearer HTTP for outsider submit and member-only read, rejects bad proof/Org/signer and preserves actual stored rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-join-http-')),
      f = history(),
      outsider = signer(138),
      other = signer(139);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const mailbox = yield* makeLabJoinMailbox({
              path: join(dir, 'joins.sqlite'),
              mode: 'create',
              genesis: f.anchor,
              ledger: () => Effect.succeed(f.view),
            });
            const http = yield* makeAuthenticatedLabMailbox({
              directory: dir,
              mode: 'create',
              genesis: f.anchor,
              ledger: () => Effect.succeed(f.view),
              joins: mailbox,
            });
            const owner = yield* http.authenticate(f.owner),
              applicant = yield* http.authenticate(outsider, 'unbound');
            const url = http.url.replace('/key-mailbox', '/joins');
            const nonce = yield* Effect.promise(() => fetch(url));
            expect(nonce.status).toBe(401);
            const request = yield* prepareJoinRequest({
              genesis: f.anchor,
              requestId: ok(Bytes.requestId(new Uint8Array(16).fill(140))),
              userId: ok(Bytes.userId(new Uint8Array(32).fill(141))),
              encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(142))),
              expiresAt: null,
              signer: outsider,
            });
            const post = (value: unknown, route = url) =>
              Effect.promise(() =>
                applicant.fetch(route, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(value),
                })
              );
            expect(
              (yield* post({ ...labJoinWire(request), encryptionPublicKey: 'aa'.repeat(32) }))
                .status
            ).toBe(400);
            const wrongSigner = yield* prepareJoinRequest({
              ...request,
              genesis: f.anchor,
              signer: other,
            });
            expect((yield* post(labJoinWire(wrongSigner))).status).toBe(403);
            expect(
              (yield* post(
                labJoinWire(request),
                url.replace(Buffer.from(f.anchor.toBytes()).toString('hex'), 'bb'.repeat(32))
              )).status
            ).toBe(404);
            // Outsider proof mints an explicitly unbound token. Receipt is inert;
            // it grants neither membership nor permission to read the queue.
            expect(yield* applicant.submitJoin(request)).toEqual(request);
            expect(yield* applicant.submitJoin(request)).toEqual(request);
            expect(Result.isFailure(yield* Effect.result(applicant.submitJoin(wrongSigner)))).toBe(
              true
            );
            expect(Result.isFailure(yield* Effect.result(applicant.listJoins()))).toBe(true);
            expect(yield* owner.listJoins()).toEqual([request]);
            // Real HTTP replies are altered only at the explicit native port.
            const altered = (mode: string) =>
              Effect.gen(function* () {
                const identity = yield* makeLabHttpIdentity({
                  baseUrl: new URL(http.url).origin,
                  genesis:
                    mode === 'org' ? ok(Bytes.genesisHash(new Uint8Array(32).fill(219))) : f.anchor,
                  fetch: async (target, init) => {
                    const response = await fetch(target, init);
                    const address = target instanceof Request ? target.url : String(target);
                    if (!address.endsWith('/joins')) return response;
                    await response.body?.cancel();
                    if (mode === 'receipt') return new Response(JSON.stringify({ ok: false }));
                    const wire = labJoinWire(request);
                    if (mode === 'signature') wire.userId = 'aa'.repeat(32);
                    if (mode === 'shape') wire.requestId = 'short';
                    return new Response(
                      JSON.stringify({ requests: mode === 'duplicates' ? [wire, wire] : [wire] })
                    );
                  },
                });
                const identityOwner = yield* identity.authenticate(
                  mode === 'receipt' ? outsider : f.owner,
                  'unbound'
                );
                if (mode === 'receipt')
                  return Result.isFailure(yield* Effect.result(identityOwner.submitJoin(request)));
                return Result.isFailure(yield* Effect.result(identityOwner.listJoins()));
              });
            for (const mode of ['signature', 'shape', 'org', 'duplicates', 'receipt'])
              expect(yield* altered(mode)).toBe(true);
            // The false receipt followed actual persistence; same original retry
            // succeeds, rather than claiming the host never stored the request.
            expect(yield* applicant.submitJoin(request)).toEqual(request);
            expect(yield* owner.listJoins()).toEqual([request]);
            expect(
              f.view
                .inspectState()
                .devices.has(Buffer.from(outsider.publicKey.toBytes()).toString('hex'))
            ).toBe(false);
            expect((yield* Effect.promise(() => applicant.fetch(url))).status).toBe(403);
            const response = yield* Effect.promise(() => owner.fetch(url));
            expect(response.status).toBe(200);
            expect(yield* Effect.promise(() => response.json())).toEqual({
              requests: [labJoinWire(request)],
            });
          })
        )
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each(['join', 'credential'] as const)(
    'aborts admission and waits an abort-ignoring borrowed native read phase before the real Riverrun owner closes (%s)',
    async (kind) => {
      const f = await fixture(),
        outsider = signer(143);
      let release!: () => void,
        rawSettled = false,
        closedEarly = false,
        disposed = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const metadataPath = join(f.dir, 'joins.sqlite');
      const nativeClose = Database.prototype.close;
      let sqliteClosedEarly = false,
        sqliteClosed = false;
      let nativeLease: Promise<LedgerView> | undefined;
      // Observe actual native close/open state; never replace native SQLite behavior
      // with a successful mock or assert a mock call count. Finally restores it.
      Database.prototype.close = function () {
        if (this.name !== metadataPath) return nativeClose.call(this);
        sqliteClosedEarly = !rawSettled;
        const result = nativeClose.call(this);
        sqliteClosed = !this.open;
        return result;
      };
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
              const readLedger = (signal: AbortSignal) =>
                Effect.gen(function* () {
                  signal.addEventListener('abort', () => Deferred.doneUnsafe(aborted, Exit.void), {
                    once: true,
                  });
                  yield* Deferred.succeed(entered, undefined);
                  // Explicit uncancellable lease phase, followed by an actual released SDK
                  // read. It deliberately ignores abort; no claim it started SDK I/O before gate.
                  return yield* Effect.promise(
                    () =>
                      (nativeLease = (async () => {
                        try {
                          await gate;
                          const result = await f.sdk.read({ offset: '0' });
                          if (!result.ok) throw new Error('native read owner already closed');
                          return f.view;
                        } finally {
                          rawSettled = true;
                        }
                      })())
                  );
                });
              let submit: () => Effect.Effect<unknown, unknown>;
              if (kind === 'join') {
                const mailbox = yield* makeLabJoinMailbox({
                  path: metadataPath,
                  mode: 'create',
                  genesis: f.anchor,
                  ledger: readLedger,
                }).pipe(Effect.provideService(Scope.Scope, child));
                const request = yield* prepareJoinRequest({
                  genesis: f.anchor,
                  requestId: ok(Bytes.requestId(new Uint8Array(16).fill(144))),
                  userId: ok(Bytes.userId(new Uint8Array(32).fill(145))),
                  encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(146))),
                  expiresAt: null,
                  signer: outsider,
                });
                const identity = {
                  account: 'synthetic',
                  device: outsider.publicKey,
                  genesis: null,
                };
                submit = () => mailbox.put(identity, request);
              } else {
                const credentials = yield* makeLabCredentials({
                  path: metadataPath,
                  mode: 'create',
                  now: () => 0,
                  ledger: (_anchor, signal) => readLedger(signal),
                }).pipe(Effect.provideService(Scope.Scope, child));
                const account = 'synthetic-owner',
                  nonce = yield* credentials.issueChallenge(account, f.owner.publicKey);
                const proof = yield* f.owner.sign(
                  ok(labPossessionMessage(account, f.owner.publicKey, nonce))
                );
                const credential = yield* credentials.completeChallenge({
                  account,
                  nonce,
                  device: f.owner.publicKey,
                  signature: proof,
                  genesis: null,
                });
                submit = () => credentials.bind(credential.token, f.anchor);
              }
              const worker = yield* submit().pipe(Effect.forkChild);
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
              expect(Result.isFailure(yield* Effect.result(submit()))).toBe(true);
              release();
              yield* Fiber.join(closing);
              // Actual earlier owner's recorded close order, not a timeout/mock call count.
              expect(closedEarly).toBe(false);
              expect(sqliteClosedEarly).toBe(false);
              expect(sqliteClosed).toBe(true);
              expect(rawSettled).toBe(true);
              expect(disposed).toBe(true);
              expect(Exit.isFailure(yield* Fiber.await(worker))).toBe(true);
            })
          )
        );
      } finally {
        release();
        await nativeLease?.catch(() => undefined);
        Database.prototype.close = nativeClose;
        if (!disposed) await f.close();
      }
    }
  );
});
