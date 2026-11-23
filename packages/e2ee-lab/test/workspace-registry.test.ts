import { makeAuthenticatedLabMailbox } from './authenticated-mailbox-fixture';
import { makeLabSdkOwner } from '../src/platform/sdk-owner';
import { runOwnedChild } from './native-child';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Result } from 'effect';
import { describe, it, expect } from 'vitest';
import { Bytes } from '@lody/e2ee-core';
import { hashRecordBytes } from '@lody/e2ee-core/protocol';
import { makeLabHttpIdentity } from '../src/platform/http-identity';
import { history } from './ledger-fixture';
import { makeLabWorkspaceRegistry } from '../src/platform/workspace-registry';
const ok = Result.getOrThrow;
describe('public genesis workspace metadata', () => {
  it('verifies real signatures and original signer, owns original bytes, reopens and rejects persisted corruption', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-workspace-')),
      path = join(dir, 'meta.sqlite'),
      f = history();
    const credential = {
      token: 'synthetic',
      account: 'alice',
      device: f.owner.publicKey,
      genesis: null,
      issuedAt: 0,
      expiresAt: 100,
    };
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const owner = yield* makeLabWorkspaceRegistry({ path, mode: 'create' });
            const invalid = new Uint8Array(f.genesis);
            invalid[invalid.length - 1] ^= 1;
            expect(
              Result.isFailure(yield* Effect.result(owner.register(credential, invalid)))
            ).toBe(true);
            expect(yield* owner.get(f.anchor)).toBeUndefined();
            expect(
              Result.isFailure(
                yield* Effect.result(
                  owner.register(
                    {
                      ...credential,
                      device: ok(
                        Bytes.signingPublicKey(
                          new Uint8Array(
                            createPublicKey(
                              createPrivateKey({
                                key: Buffer.concat([
                                  Buffer.from('302e020100300506032b657004220420', 'hex'),
                                  Buffer.alloc(32, 155),
                                ]),
                                format: 'der',
                                type: 'pkcs8',
                              })
                            )
                              .export({ format: 'der', type: 'spki' })
                              .subarray(-32)
                          )
                        )
                      ),
                    },
                    f.genesis
                  )
                )
              )
            ).toBe(true);
            const record = new Uint8Array(f.genesis);
            yield* owner.register(credential, record);
            record.fill(0);
            const saved = yield* owner.get(f.anchor);
            expect(saved?.record).toEqual(f.genesis);
            saved!.record.fill(0);
            expect((yield* owner.get(f.anchor))?.record).toEqual(f.genesis);
            yield* owner.register(credential, f.genesis);
          })
        )
      );
      const reopened = await Effect.runPromise(
        runOwnedChild([
          '--import',
          'tsx',
          'test/workspace-registry-reopen.mts',
          path,
          Buffer.from(f.anchor.toBytes()).toString('hex'),
        ])
      );
      expect(JSON.parse(reopened)).toEqual({
        genesisHex: Buffer.from(f.anchor.toBytes()).toString('hex'),
        recordHex: Buffer.from(f.genesis).toString('hex'),
      });
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const owner = yield* makeLabWorkspaceRegistry({ path, mode: 'open' });
            expect((yield* owner.get(f.anchor))?.record).toEqual(f.genesis);
            const db = new Database(path);
            try {
              db.prepare('UPDATE workspaces SET owner=?').run('tampered');
            } finally {
              db.close();
            }
            expect(Result.isFailure(yield* Effect.result(owner.get(f.anchor)))).toBe(true);
            expect(
              Result.isFailure(yield* Effect.result(owner.register(credential, f.genesis)))
            ).toBe(true);
          })
        )
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('rejects ignored inserts with real readback, preserves unrelated genesis and rejects operations after close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-workspace-')),
      path = join(dir, 'meta.sqlite'),
      f = history();
    const credential = {
      token: 'synthetic',
      account: 'alice',
      device: f.owner.publicKey,
      genesis: null,
      issuedAt: 0,
      expiresAt: 100,
    };
    let late: Effect.Success<ReturnType<typeof makeLabWorkspaceRegistry>> | undefined;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const owner = yield* makeLabWorkspaceRegistry({ path, mode: 'create' });
            late = owner;
            const db = new Database(path);
            try {
              db.exec(
                'CREATE TRIGGER ignore_space BEFORE INSERT ON workspaces BEGIN SELECT RAISE(IGNORE); END;'
              );
              expect(
                Result.isFailure(yield* Effect.result(owner.register(credential, f.genesis)))
              ).toBe(true);
              expect(db.prepare('SELECT count(*) AS n FROM workspaces').get()).toEqual({ n: 0 });
              db.exec('DROP TRIGGER ignore_space');
              yield* owner.register(credential, f.genesis);
              expect(db.prepare('SELECT count(*) AS n FROM workspaces').get()).toEqual({ n: 1 });
              expect(
                yield* owner.get(ok(Bytes.genesisHash(new Uint8Array(32).fill(211))))
              ).toBeUndefined();
            } finally {
              db.close();
            }
          })
        )
      );
      expect(Result.isFailure(await Effect.runPromise(Effect.result(late!.get(f.anchor))))).toBe(
        true
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('serves only reverified original genesis over actual stored-bearer discovery, including unbound joiners; corrupt storage is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-workspace-http-')),
      path = join(dir, 'meta.sqlite'),
      f = history();
    const credential = {
      token: 'synthetic',
      account: 'alice',
      device: f.owner.publicKey,
      genesis: null,
      issuedAt: 0,
      expiresAt: 100,
    };
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const registry = yield* makeLabWorkspaceRegistry({ path, mode: 'create' });
            // This is private harness registration, not a passed HTTP create-space flow.
            yield* registry.register(credential, f.genesis);
            const host = yield* makeAuthenticatedLabMailbox({
              directory: dir,
              mode: 'create',
              genesis: f.anchor,
              ledger: () => Effect.succeed(f.view),
              workspaces: registry,
            });
            const auth = yield* host.authenticate(f.owner, 'unbound');
            const saved = yield* auth.discoverGenesis();
            expect(saved.anchor.equals(f.anchor)).toBe(true);
            expect(saved.record).toEqual(f.genesis);
            saved.record.fill(0);
            expect((yield* auth.discoverGenesis()).record).toEqual(f.genesis);
            // Actual host responses are explicitly replaced only at discovery.
            // This models hostile metadata, without replacing crypto or authority.
            const attacked = (anchor: Bytes.GenesisHash, payload: unknown) =>
              Effect.gen(function* () {
                const client = yield* makeLabHttpIdentity({
                  baseUrl: new URL(host.url).origin,
                  genesis: anchor,
                  fetch: async (request, init) => {
                    const response = await fetch(request, init);
                    const target = request instanceof Request ? request.url : String(request);
                    if (!target.endsWith('/genesis')) return response;
                    await response.body?.cancel();
                    return new Response(JSON.stringify(payload));
                  },
                });
                const unbound = yield* client.authenticate(f.owner, 'unbound');
                return yield* Effect.result(unbound.discoverGenesis());
              });
            expect(Result.isFailure(yield* attacked(f.anchor, { genesis: 'zz' }))).toBe(true);
            const bad = new Uint8Array(f.genesis);
            bad[bad.length - 1] ^= 1;
            const badAnchor = ok(Bytes.genesisHash(hashRecordBytes(bad).toBytes()));
            expect(
              Result.isFailure(
                yield* attacked(badAnchor, { genesis: Buffer.from(bad).toString('hex') })
              )
            ).toBe(true);
            expect(
              Result.isFailure(
                yield* attacked(badAnchor, { genesis: Buffer.from(f.genesis).toString('hex') })
              )
            ).toBe(true);
            const nonGenesis = f.records[1];
            const wrongTypeAnchor = ok(Bytes.genesisHash(hashRecordBytes(nonGenesis).toBytes()));
            expect(
              Result.isFailure(
                yield* attacked(wrongTypeAnchor, {
                  genesis: Buffer.from(nonGenesis).toString('hex'),
                })
              )
            ).toBe(true);
            const url = host.url.replace('/key-mailbox', '/genesis');
            const lease = yield* makeLabSdkOwner(() => ({ close: async () => undefined }));
            const get = (target: string, transport: typeof fetch) =>
              lease.invoke(async () => {
                const response = await transport(target, { signal: lease.signal });
                return { status: response.status, body: await response.json() };
              });
            expect((yield* get(url, fetch)).status).toBe(401);
            expect(yield* get(url, auth.fetch)).toEqual({
              status: 200,
              body: { genesis: Buffer.from(f.genesis).toString('hex') },
            });
            expect((yield* get(url + '?offset=latest', auth.fetch)).status).toBe(404);
            const unknown = url.replace(
              Buffer.from(f.anchor.toBytes()).toString('hex'),
              'ee'.repeat(32)
            );
            expect((yield* get(unknown, auth.fetch)).status).toBe(404);
            const db = new Database(path);
            try {
              db.prepare('UPDATE workspaces SET owner=?').run('bad');
            } finally {
              db.close();
            }
            expect((yield* get(url, auth.fetch)).status).toBe(500);
            expect(Result.isFailure(yield* Effect.result(auth.discoverGenesis()))).toBe(true);
          })
        )
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
