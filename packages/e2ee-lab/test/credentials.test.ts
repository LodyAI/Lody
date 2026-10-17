import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Deferred, Effect, Fiber, Result } from 'effect';
import { describe, expect, it } from 'vitest';
import { Bytes } from '@lody/e2ee-core';
import { sealEpochKeyHpke, openEpochKeyHpke } from '@lody/e2ee-core/protocol';
import { commitEpochKey } from '@lody/e2ee-core/protocol';
import {
  generateDevice,
  exportDevice,
  importDevice,
  deviceHex,
  possessionProof,
  verifyPossession,
} from '../src/platform/device';
import type { LedgerView } from '@lody/e2ee-core';
import { history } from './ledger-fixture';
import { makeLabCredentials, labPossessionMessage } from '../src/platform/credentials';
import { authorizeLabStream } from '../src/platform/gateway';
const ok = Result.getOrThrow;
const directory = () => mkdtempSync(join(tmpdir(), 'lab-credential-'));
describe('synthetic Lab device credentials, not product identity or strict deadline B', () => {
  it('binds real signatures and single-use challenges, durably reopens and invalidates without granting Org membership from JSON', async () => {
    const f = history(),
      dir = directory(),
      path = join(dir, 'host.sqlite');
    let now = 1000,
      token = '';
    const request = (nonce: string) =>
      Effect.gen(function* () {
        return {
          account: 'synthetic-alice',
          device: f.owner.publicKey,
          nonce,
          signature: yield* f.owner.sign(
            ok(labPossessionMessage('synthetic-alice', f.owner.publicKey, nonce))
          ),
          genesis: f.anchor,
        };
      });
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* makeLabCredentials({
              path,
              mode: 'create',
              now: () => now,
              ledger: () => Effect.succeed(f.view),
            });
            const nonce = yield* host.issueChallenge('synthetic-alice', f.owner.publicKey);
            const proof = yield* request(nonce),
              credential = yield* host.completeChallenge(proof);
            token = credential.token;
            expect(credential.device.equals(f.owner.publicKey)).toBe(true);
            expect(credential.genesis?.equals(f.anchor)).toBe(true);
            expect(Result.isFailure(yield* Effect.result(host.completeChallenge(proof)))).toBe(
              true
            );
            const actual = yield* host.authenticate(token);
            expect(actual.token).toBe(token);
            expect(
              ok(
                authorizeLabStream({
                  view: f.view,
                  authenticatedCredential: actual,
                  requestGenesis: f.anchor,
                  stream: 'loro',
                  method: 'GET',
                })
              )
            ).toBeUndefined();
            const wrongOrg = ok(Bytes.genesisHash(new Uint8Array(32).fill(201)));
            const otherNonce = yield* host.issueChallenge('synthetic-alice', f.owner.publicKey);
            expect(
              Result.isFailure(
                yield* Effect.result(
                  host.completeChallenge({ ...(yield* request(otherNonce)), genesis: wrongOrg })
                )
              )
            ).toBe(true);
          })
        )
      );
      now++;
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* makeLabCredentials({
              path,
              mode: 'open',
              now: () => now,
              ledger: () => Effect.succeed(f.view),
            });
            expect((yield* host.authenticate(token)).device.equals(f.owner.publicKey)).toBe(true);
            yield* host.invalidate(token);
            expect(Result.isFailure(yield* Effect.result(host.authenticate(token)))).toBe(true);
          })
        )
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* makeLabCredentials({
              path,
              mode: 'open',
              now: () => now,
              ledger: () => Effect.succeed(f.view),
            });
            expect(Result.isFailure(yield* Effect.result(host.authenticate(token)))).toBe(true);
          })
        )
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses mismatching/expired challenges and counterfeit ledger authority; failures never mint a token', async () => {
    const f = history(),
      dir = directory(),
      path = join(dir, 'host.sqlite');
    let now = 0;
    const fake = {
      genesis: f.anchor,
      inspectState: () => f.view.inspectState(),
    } as unknown as LedgerView;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* makeLabCredentials({
              path,
              mode: 'create',
              now: () => now,
              ledger: () => Effect.succeed(fake),
            });
            const nonce = yield* host.issueChallenge('synthetic-alice', f.owner.publicKey);
            const proof = {
              account: 'synthetic-alice',
              device: f.owner.publicKey,
              nonce,
              signature: yield* f.owner.sign(
                ok(labPossessionMessage('synthetic-alice', f.owner.publicKey, nonce))
              ),
              genesis: f.anchor,
            };
            expect(Result.isFailure(yield* Effect.result(host.completeChallenge(proof)))).toBe(
              true
            );
            const wrong = yield* host.issueChallenge('synthetic-alice', f.owner.publicKey);
            const wrongProof = {
              ...proof,
              nonce: wrong,
              signature: yield* f.owner.sign(
                ok(labPossessionMessage('synthetic-bob', f.owner.publicKey, wrong))
              ),
              genesis: null,
            };
            expect(Result.isFailure(yield* Effect.result(host.completeChallenge(wrongProof)))).toBe(
              true
            );
            expect(
              Result.isFailure(
                yield* Effect.result(
                  host.completeChallenge({
                    ...wrongProof,
                    signature: yield* f.owner.sign(
                      ok(labPossessionMessage('synthetic-alice', f.owner.publicKey, wrong))
                    ),
                  })
                )
              )
            ).toBe(true);
            const expired = yield* host.issueChallenge('synthetic-alice', f.owner.publicKey);
            const expiredProof = {
              ...proof,
              nonce: expired,
              signature: yield* f.owner.sign(
                ok(labPossessionMessage('synthetic-alice', f.owner.publicKey, expired))
              ),
              genesis: null,
            };
            now = 60_000; // Frozen Lab nonce lifetime only; not ordinary JWT leeway/final-write B.
            expect(
              Result.isFailure(yield* Effect.result(host.completeChallenge(expiredProof)))
            ).toBe(true);
          })
        )
      );
      const db = new Database(path);
      try {
        expect(db.prepare('SELECT count(*) AS n FROM credentials').get()).toEqual({ n: 0 });
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('detects real SQL IGNORE and trigger-restored challenges instead of acknowledging phantom tokens or replayable proofs', async () => {
    const f = history(),
      dir = directory(),
      path = join(dir, 'host.sqlite');
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* makeLabCredentials({
              path,
              mode: 'create',
              now: () => 0,
              ledger: () => Effect.succeed(f.view),
            });
            const db = new Database(path);
            try {
              db.exec(
                'CREATE TRIGGER ignore_credentials BEFORE INSERT ON credentials BEGIN SELECT RAISE(IGNORE); END;'
              );
              const nonce = yield* host.issueChallenge('synthetic-alice', f.owner.publicKey);
              const proof = {
                account: 'synthetic-alice',
                device: f.owner.publicKey,
                nonce,
                signature: yield* f.owner.sign(
                  ok(labPossessionMessage('synthetic-alice', f.owner.publicKey, nonce))
                ),
                genesis: f.anchor,
              };
              const result = yield* Effect.result(host.completeChallenge(proof));
              expect(Result.isFailure(result)).toBe(true);
              if (Result.isFailure(result))
                expect((result.failure as { code: string }).code).toBe('storage');
              expect(db.prepare('SELECT count(*) AS n FROM credentials').get()).toEqual({ n: 0 });
              db.exec(
                'DROP TRIGGER ignore_credentials; CREATE TRIGGER restore_challenge AFTER DELETE ON credential_challenges BEGIN INSERT INTO credential_challenges(nonce,account,device_hex,expires_at) VALUES(old.nonce,old.account,old.device_hex,old.expires_at); END;'
              );
              const fresh = yield* host.issueChallenge('synthetic-alice', f.owner.publicKey);
              const freshProof = {
                ...proof,
                nonce: fresh,
                signature: yield* f.owner.sign(
                  ok(labPossessionMessage('synthetic-alice', f.owner.publicKey, fresh))
                ),
              };
              expect(
                Result.isFailure(yield* Effect.result(host.completeChallenge(freshProof)))
              ).toBe(true);
              expect(db.prepare('SELECT count(*) AS n FROM credentials').get()).toEqual({ n: 0 });
              db.exec('DROP TRIGGER restore_challenge;');
              const saved = yield* host.completeChallenge(freshProof);
              expect((yield* host.authenticate(saved.token)).device.equals(f.owner.publicKey)).toBe(
                true
              );
              expect(
                Result.isFailure(yield* Effect.result(host.completeChallenge(freshProof)))
              ).toBe(true);
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
  it('binds once after current genuine membership, detects ignored updates, reopens and never renews its original lease', async () => {
    const f = history(),
      dir = directory(),
      path = join(dir, 'binding.sqlite');
    let now = 0,
      token = '';
    let view: LedgerView = f.view;
    let duringLookup: () => void = () => undefined;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* makeLabCredentials({
              path,
              mode: 'create',
              now: () => now,
              ledger: () =>
                Effect.sync(() => {
                  duringLookup();
                  return view;
                }),
            });
            const nonce = yield* host.issueChallenge('synthetic-alice', f.owner.publicKey);
            const initial = yield* host.completeChallenge({
              account: 'synthetic-alice',
              device: f.owner.publicKey,
              nonce,
              signature: yield* f.owner.sign(
                ok(labPossessionMessage('synthetic-alice', f.owner.publicKey, nonce))
              ),
              genesis: null,
              ttlMs: 100,
            });
            token = initial.token;
            view = {
              genesis: f.anchor,
              inspectState: () => f.view.inspectState(),
            } as unknown as LedgerView;
            expect(Result.isFailure(yield* Effect.result(host.bind(token, f.anchor)))).toBe(true);
            expect((yield* host.authenticate(token)).genesis).toBeNull();
            view = f.view;
            const db = new Database(path);
            try {
              db.exec(
                'CREATE TRIGGER ignore_binding BEFORE UPDATE OF genesis_hex ON credentials BEGIN SELECT RAISE(IGNORE); END;'
              );
              expect(Result.isFailure(yield* Effect.result(host.bind(token, f.anchor)))).toBe(true);
              expect((yield* host.authenticate(token)).genesis).toBeNull();
              expect(db.prepare('SELECT count(*) AS n FROM credentials').get()).toEqual({ n: 1 });
              db.exec('DROP TRIGGER ignore_binding');
              const bound = yield* host.bind(token, f.anchor);
              expect(bound.genesis?.equals(f.anchor)).toBe(true);
              expect(bound.issuedAt).toBe(initial.issuedAt);
              expect(bound.expiresAt).toBe(initial.expiresAt);
              expect(bound.token).toBe(token);
              now = 50;
              expect((yield* host.bind(token, f.anchor)).expiresAt).toBe(100);
              expect(
                Result.isFailure(
                  yield* Effect.result(
                    host.bind(token, ok(Bytes.genesisHash(new Uint8Array(32).fill(211))))
                  )
                )
              ).toBe(true);
              const fresh = () =>
                Effect.gen(function* () {
                  const nextNonce = yield* host.issueChallenge(
                    'synthetic-alice',
                    f.owner.publicKey
                  );
                  return yield* host.completeChallenge({
                    account: 'synthetic-alice',
                    nonce: nextNonce,
                    device: f.owner.publicKey,
                    signature: yield* f.owner.sign(
                      ok(labPossessionMessage('synthetic-alice', f.owner.publicKey, nextNonce))
                    ),
                    genesis: null,
                    ttlMs: 50,
                  });
                });
              const expiring = yield* fresh();
              duringLookup = () => {
                now = 100;
              };
              expect(
                Result.isFailure(yield* Effect.result(host.bind(expiring.token, f.anchor)))
              ).toBe(true);
              expect(
                db
                  .prepare('SELECT genesis_hex,invalidated FROM credentials WHERE token=?')
                  .get(expiring.token)
              ).toEqual({ genesis_hex: null, invalidated: 0 });
              duringLookup = () => undefined;
              now = 50;
              const invalidating = yield* fresh();
              duringLookup = () => {
                db.prepare('UPDATE credentials SET invalidated=1 WHERE token=?').run(
                  invalidating.token
                );
              };
              expect(
                Result.isFailure(yield* Effect.result(host.bind(invalidating.token, f.anchor)))
              ).toBe(true);
              expect(
                db
                  .prepare('SELECT genesis_hex,invalidated FROM credentials WHERE token=?')
                  .get(invalidating.token)
              ).toEqual({ genesis_hex: null, invalidated: 1 });
            } finally {
              duringLookup = () => undefined;
              db.close();
            }
          })
        )
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* makeLabCredentials({
              path,
              mode: 'open',
              now: () => now,
              ledger: () => Effect.succeed(f.view),
            });
            expect((yield* host.authenticate(token)).genesis?.equals(f.anchor)).toBe(true);
            now = 100;
            expect(Result.isFailure(yield* Effect.result(host.bind(token, f.anchor)))).toBe(true);
            expect(Result.isFailure(yield* Effect.result(host.authenticate(token)))).toBe(true);
          })
        )
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('roundtrips original synthetic device fixtures through real public signer/HPKE and durable possession credentials without granting membership', async () => {
    const dir = directory(),
      f = history();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const original = yield* generateDevice();
            const raw = yield* exportDevice(original);
            const imported = yield* importDevice(raw);
            expect(deviceHex(imported)).toBe(deviceHex(original));
            expect(imported.enc.equals(original.enc)).toBe(true);
            const host = yield* makeLabCredentials({
              path: join(dir, 'devices.sqlite'),
              mode: 'create',
              now: () => 500,
              ledger: () => Effect.succeed(f.view),
            });
            const account = 'synthetic-exported-device';
            const nonce = yield* host.issueChallenge(account, original.publicKey);
            const signature = yield* possessionProof(account, imported, nonce);
            expect(yield* verifyPossession(account, original.publicKey, nonce, signature)).toBe(
              true
            );
            expect(
              yield* verifyPossession('different-account', original.publicKey, nonce, signature)
            ).toBe(false);
            expect(
              yield* verifyPossession(
                account,
                original.publicKey,
                (nonce[0] === 'a' ? 'b' : 'a') + nonce.slice(1),
                signature
              )
            ).toBe(false);
            const credential = yield* host.completeChallenge({
              account,
              device: original.publicKey,
              nonce,
              signature,
              genesis: null,
            });
            expect((yield* host.authenticate(credential.token)).genesis).toBeNull();
            expect(
              Result.isFailure(yield* Effect.result(host.bind(credential.token, f.anchor)))
            ).toBe(true);
            expect((yield* host.authenticate(credential.token)).genesis).toBeNull();
            expect(
              Result.isFailure(
                yield* Effect.result(
                  host.completeChallenge({
                    account,
                    device: original.publicKey,
                    nonce,
                    signature,
                    genesis: null,
                  })
                )
              )
            ).toBe(true);
            const key = ok(Bytes.epochKey(new Uint8Array(32).fill(143)));
            const context = {
              genesis: f.anchor,
              epoch: ok(Bytes.epochNumber(0)),
              sender: f.owner.publicKey,
              recipient: imported.publicKey,
            };
            const frame = yield* sealEpochKeyHpke(original.enc, key, context);
            const opened = yield* openEpochKeyHpke(
              imported.encryption,
              imported.enc,
              context,
              frame
            );
            expect(
              ok(commitEpochKey(f.anchor, 0, opened)).equals(ok(commitEpochKey(f.anchor, 0, key)))
            ).toBe(true);
          })
        )
      );
      const db = new Database(join(dir, 'devices.sqlite'), { readonly: true, fileMustExist: true });
      try {
        expect(db.prepare('SELECT genesis_hex, invalidated FROM credentials').all()).toEqual([
          { genesis_hex: null, invalidated: 0 },
        ]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses mismatched Ed/X fixture bindings and malformed imports instead of creating a broken device', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* generateDevice(),
          b = yield* generateDevice();
        const raw = yield* exportDevice(a),
          other = JSON.parse(yield* exportDevice(b));
        const value = JSON.parse(raw);
        for (const fields of [
          { ...value, publicKey: other.publicKey },
          { ...value, enc: other.enc },
          { ...value, signing: other.encryption },
          { ...value, encryption: other.signing },
          { ...value, publicKey: 'AA'.repeat(32) },
          { ...value, unexpected: true },
          { ...value, enc: '00' },
          { ...value, signing: 'ff'.repeat(129) },
        ]) {
          const result = yield* Effect.result(importDevice(JSON.stringify(fields)));
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) expect(result.failure.code).toBe('invalid-fixture');
        }
        for (const malformed of ['null', '[]', '{', 'x'.repeat(4097)]) {
          expect(Result.isFailure(yield* Effect.result(importDevice(malformed)))).toBe(true);
        }
        const nonce = '42'.repeat(32);
        const proof = yield* possessionProof('synthetic-roundtrip', a, nonce);
        expect(yield* verifyPossession('synthetic-roundtrip', a.publicKey, nonce, proof)).toBe(
          true
        );
      })
    );
  });
  it.each(['interrupt', 'reject'] as const)(
    'awaits both instrumented real native generators after %s',
    async (ending) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const created = yield* Deferred.make<void>();
            const secondCreated = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            let completed = false;
            const subtle = new Proxy(crypto.subtle, {
              get(target, field) {
                if (field === 'generateKey')
                  return async (...args: Parameters<SubtleCrypto['generateKey']>) => {
                    const key = await target.generateKey(...args);
                    if (args[0] === 'Ed25519') {
                      Effect.runSync(Deferred.succeed(created, undefined));
                      if (ending === 'reject') throw new Error('synthetic post-native failure');
                    } else {
                      Effect.runSync(Deferred.succeed(secondCreated, undefined));
                      await Effect.runPromise(Deferred.await(release));
                      completed = true;
                    }
                    return key;
                  };
                const value = Reflect.get(target, field, target);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
            // Real native entropy/key generation is unchanged. Only fixture returns and
            // one explicit post-native failure are instrumented, not crypto/custody.
            const worker = yield* Effect.forkScoped(generateDevice(subtle));
            try {
              yield* Deferred.await(created);
              yield* Deferred.await(secondCreated);
              if (ending === 'interrupt') worker.interruptUnsafe();
              expect(worker.pollUnsafe()).toBeUndefined();
              expect(completed).toBe(false);
            } finally {
              yield* Deferred.succeed(release, undefined);
            }
            const result = yield* Fiber.await(worker);
            expect(result._tag).toBe('Failure');
            expect(completed).toBe(true);
          })
        )
      );
    }
  );
});
