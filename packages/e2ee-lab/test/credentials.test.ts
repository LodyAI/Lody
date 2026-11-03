import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Effect, Result } from 'effect';
import { describe, expect, it } from 'vitest';
import { Bytes } from '@lody/e2ee-core';

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
});
