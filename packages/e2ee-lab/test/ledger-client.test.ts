import { writeFileSync } from 'node:fs';
import { runOwnedChild } from './native-child';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { Effect, Result } from 'effect';
import { StreamsClient } from '@loro-dev/streams-client';
import { prepareDeviceAdmission, prepareLedgerCommand } from '@lody/e2ee-core/protocol';
import { signLedgerRecord } from '@lody/e2ee-core/protocol';
import { type LedgerView } from '@lody/e2ee-core';
import { hashRecordBytes } from '@lody/e2ee-core/protocol';
import { Bytes } from '@lody/e2ee-core';
import { decodeCbor, encodeCbor, type CborValue } from '@lody/e2ee-core/protocol';
import { frameLedgerRecord } from '@lody/e2ee-core/protocol';
import { describe, expect, it } from 'vitest';
import {
  makeLabSnapshotCache,
  restoreLabLedgerFromCacheOrHistory,
} from '../src/platform/snapshot-cache';
import {
  signLedgerSnapshot,
  prepareLedgerSnapshot,
  encodeSignedSnapshot,
  snapshotSigningBytes,
  headAttestationSigningBytes,
  authenticateLedgerSnapshotEvidence,
  comparisonNote,
  type SnapshotTrust,
} from '@lody/e2ee-core/protocol';
import { makeLabLedgerClient } from '../src/platform/ledger-client';
import { history, fixture, options } from './ledger-fixture';
const ok = Result.getOrThrow;
describe('real Riverrun, released SDK and public ledger feed', () => {
  it('rejects duplicate committed record at a later offset and preserves the durable file after reopen', async () => {
    const f = await fixture();
    try {
      let originalOffset = '';
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* makeLabLedgerClient(options(f, 'create'));
            const accepted = yield* client.read(f.checkpoint);
            originalOffset = accepted.offset;
            expect(accepted.view.head.equals(f.view.head)).toBe(true);
            // Malicious transport can append valid old bytes; the client must not skip hashes.
          })
        )
      );
      expect(
        (
          await f.sdk.append({
            part: {
              contentType: 'application/octet-stream',
              body: ok(frameLedgerRecord(f.rotate)),
            },
          })
        ).ok
      ).toBe(true);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* makeLabLedgerClient(options(f, 'open'));
            const result = yield* Effect.result(client.read(f.checkpoint));
            expect(Result.isFailure(result)).toBe(true);
            const unchanged = yield* client.current();
            expect(unchanged.offset).toBe(originalOffset);
            expect(unchanged.view.length).toBe(2);
            expect(unchanged.view.head.equals(f.view.head)).toBe(true);
          })
        )
      );
      const config = join(f.dir, 'synthetic-child.json');
      writeFileSync(
        config,
        JSON.stringify({
          path: f.path,
          url: `${f.server.baseUrl}/ds/synthetic/control`,
          genesis: Buffer.from(f.genesis).toString('hex'),
          anchor: Buffer.from(f.anchor.toBytes()).toString('hex'),
          head: Buffer.from(f.checkpoint.head.toBytes()).toString('hex'),
          length: 2,
          offset: originalOffset,
        }),
        { mode: 0o600 }
      );
      const stdout = await Effect.runPromise(
        runOwnedChild(['--import', 'tsx', 'test/ledger-reopen.mts', config])
      );
      expect(JSON.parse(stdout)).toEqual({ offset: originalOffset, length: 2, rejected: true });
    } finally {
      await f.close();
    }
  });
  it('rejects a rollback response at the current request position instead of rewinding the saved cursor', async () => {
    const f = await fixture();
    try {
      let originalOffset = '';
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* makeLabLedgerClient(options(f, 'create'));
            originalOffset = (yield* client.read(f.checkpoint)).offset;
          })
        )
      );
      const short = new StreamsClient({
        url: `${f.server.baseUrl}/ds/synthetic/old`,
        retry: { maxAttempts: 1 },
      });
      expect((await short.create({ contentType: 'application/octet-stream' })).ok).toBe(true);
      expect(
        (
          await short.append({
            part: {
              contentType: 'application/octet-stream',
              body: ok(frameLedgerRecord(f.genesis)),
            },
          })
        ).ok
      ).toBe(true);
      // Real SDK reads an actual shorter Riverrun stream. The malicious boundary
      // lies only about which stream served the requested offset, as in the old Lab test.
      const stream = {
        read: async (input: { offset: string; signal: AbortSignal }) => {
          const result = await short.read({ offset: '-1', signal: input.signal });
          return result.ok
            ? { ...result, result: { ...result.result, requestOffset: input.offset } }
            : result;
        },
      };
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* makeLabLedgerClient({ ...options(f, 'open'), stream });
            expect(Result.isFailure(yield* Effect.result(client.read(f.checkpoint)))).toBe(true);
            const current = yield* client.current();
            expect(current.offset).toBe(originalOffset);
            expect(current.view.head.equals(f.view.head)).toBe(true);
          })
        )
      );
    } finally {
      await f.close();
    }
  });
  it('keeps history and cursor unchanged when the real SQLite metadata update is ignored', async () => {
    const f = await fixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* makeLabLedgerClient(options(f, 'create'));
            const db = new Database(f.path);
            try {
              db.exec(
                'CREATE TRIGGER deny_cursor BEFORE UPDATE ON feed_meta BEGIN SELECT RAISE(IGNORE); END'
              );
              expect(Result.isFailure(yield* Effect.result(client.read(f.checkpoint)))).toBe(true);
              expect((yield* client.current()).offset).toBe('-1');
              expect(db.prepare('SELECT count,offset FROM feed_meta').get()).toEqual({
                count: 1,
                offset: '-1',
              });
              expect(db.prepare('SELECT COUNT(*) AS n FROM feed_records').get()).toEqual({
                n: 0,
              });
              db.exec('DROP TRIGGER deny_cursor');
              expect((yield* client.read(f.checkpoint)).view.length).toBe(2);
            } finally {
              db.close();
            }
          })
        )
      );
    } finally {
      await f.close();
    }
  });
  it('collects complete record pages before one durable commit and keeps the initial cursor on a later-page failure', async () => {
    const f = await fixture();
    try {
      const actual = await f.sdk.read({ offset: '-1' });
      if (!actual.ok) throw new Error('real Riverrun history unavailable');
      const firstSize = 4 + f.genesis.length;
      for (const failSecond of [false, true]) {
        const stream = {
          read: async (request: { offset: string; signal: AbortSignal }) => {
            if (request.offset === '-1')
              return {
                ok: true as const,
                result: {
                  ...actual.result,
                  requestOffset: request.offset,
                  nextOffset: 'fixture/partial',
                  upToDate: false,
                  payload: {
                    ...actual.result.payload,
                    body: actual.result.payload.body.slice(0, firstSize),
                  },
                },
              };
            if (failSecond) return { ok: false as const, result: 'injected later-page disruption' };
            return {
              ok: true as const,
              result: {
                ...actual.result,
                requestOffset: request.offset,
                payload: {
                  ...actual.result.payload,
                  body: actual.result.payload.body.slice(firstSize),
                },
              },
            };
          },
        };
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* makeLabLedgerClient({
                ...options(f, 'create'),
                path: join(f.dir, failSecond ? 'failed-page.sqlite' : 'complete-page.sqlite'),
                stream,
              });
              const outcome = yield* Effect.result(client.read(f.checkpoint));
              const current = yield* client.current();
              if (failSecond) {
                expect(Result.isFailure(outcome)).toBe(true);
                expect(current.offset).toBe('-1');
                expect(current.view.length).toBe(1);
              } else {
                expect(Result.isSuccess(outcome)).toBe(true);
                expect(current.offset).toBe(actual.result.nextOffset);
                expect(current.view.head.equals(f.view.head)).toBe(true);
              }
            })
          )
        );
      }
    } finally {
      await f.close();
    }
  });
  it('applies finite read budgets per invocation rather than as a lifetime limit', async () => {
    const f = await fixture();
    try {
      const actual = await f.sdk.read({ offset: '-1' });
      if (!actual.ok) throw new Error('real Riverrun history unavailable');
      // Explicit mock transport boundary after one real SDK response. Real signed
      // history, verifier and SQLite remain; no elapsed-time or scheduler assumption.
      const stream = {
        read: async (request: { offset: string; signal: AbortSignal }) => ({
          ok: true as const,
          result: {
            ...actual.result,
            requestOffset: request.offset,
            payload: {
              ...actual.result.payload,
              body: request.offset === '-1' ? actual.result.payload.body : new Uint8Array(0),
            },
          },
        }),
      };
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* makeLabLedgerClient({ ...options(f, 'create'), stream });
            for (let index = 0; index < 4097; index++) yield* client.read(f.checkpoint);
            const current = yield* client.current();
            expect(current.offset).toBe(actual.result.nextOffset);
            expect(current.view.head.equals(f.view.head)).toBe(true);
          })
        )
      );
    } finally {
      await f.close();
    }
  });
});

function independentTrust(
  f: ReturnType<typeof history>,
  headSignature: SnapshotTrust['headSignature']
): SnapshotTrust {
  // Qualification is obtained from the independently owned full fixture history,
  // not the produced snapshot's role/identity fields or any SQLite row.
  return {
    source: 'external-confirmation',
    genesis: f.anchor,
    head: f.checkpoint.head,
    length: f.checkpoint.length,
    endorser: f.owner.publicKey,
    membershipId: f.membership,
    role: 'owner',
    kind: 'personal',
    headSignature,
    stateDigest: ok(comparisonNote(f.view, f.owner.publicKey)).stateDigest,
  };
}
describe('v1 snapshot byte cache with separate independent trust', () => {
  it('reverifies stored signatures after process reopen, owns bytes and refuses same-key attacker replacement without choosing SQL trust', async () => {
    const f = await fixture(),
      other = history(181),
      path = join(f.dir, 'snapshots.sqlite');
    try {
      const produced = await Effect.runPromise(
        signLedgerSnapshot({ signer: f.owner, ledger: () => Effect.succeed(f.view) })
      );
      const foreign = await Effect.runPromise(
        signLedgerSnapshot({ signer: other.owner, ledger: () => Effect.succeed(other.view) })
      );
      const pin = independentTrust(f, produced.headSignature),
        otherPin = independentTrust(other, foreign.headSignature);
      // Same Org/head and real attacker signatures, but only self-claimed Owner.
      // Small synthetic v1 fixture fits the public bounded CBOR entry; no private
      // parser/verifier or accepted signature hook is imported.
      const proposal = ok(prepareLedgerSnapshot(f.view, f.owner.publicKey));
      const body = ok(decodeCbor(proposal.bodyBytes)) as CborValue[];
      body[4] = other.owner.publicKey.toBytes();
      const state = body[5] as CborValue[];
      const devices = state[2] as CborValue[][];
      devices[0]![0] = other.owner.publicKey.toBytes();
      state[6] = [other.owner.publicKey.toBytes()];
      const selfBody = ok(encodeCbor(body));
      const selfSignature = await Effect.runPromise(
        other.owner.sign(snapshotSigningBytes(selfBody))
      );
      const selfClaimed = ok(encodeSignedSnapshot(selfBody, selfSignature));
      const selfHead = await Effect.runPromise(
        other.owner.sign(headAttestationSigningBytes(f.anchor, f.checkpoint.head))
      );
      const evidence = ok(
        authenticateLedgerSnapshotEvidence(selfClaimed, {
          genesis: f.anchor,
          head: f.checkpoint.head,
          length: 2,
          endorser: other.owner.publicKey,
          headSignature: selfHead,
        })
      );
      expect(evidence.stage).toBe('signature-evidence');
      expect(evidence.claims.role).toBe('owner');

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const cache = yield* makeLabSnapshotCache({ path, mode: 'create' });
            const original = new Uint8Array(produced.snapshot);
            const saved = yield* cache.put({ trust: pin, snapshot: original });
            original.fill(0);
            expect(saved.view.verification).toBe('endorsed-snapshot');
            const cachedRestore = yield* restoreLabLedgerFromCacheOrHistory({
              cache,
              trust: pin,
              expected: f.checkpoint,
              history: () =>
                Effect.fail(new Error('matching cache unexpectedly requested history')),
            });
            expect(cachedRestore.source).toBe('endorsed-cache');
            const borrowed = saved.snapshot();
            borrowed.fill(0);
            expect(saved.snapshot()).toEqual(produced.snapshot);
            expect((yield* cache.get(pin))?.snapshot()).toEqual(produced.snapshot);
            yield* cache.put({ trust: otherPin, snapshot: foreign.snapshot });
            expect(
              Result.isFailure(
                yield* Effect.result(
                  cache.get({ ...pin, kind: 'recovery' } as unknown as SnapshotTrust)
                )
              )
            ).toBe(true);
            expect(
              Result.isFailure(
                yield* Effect.result(cache.put({ trust: pin, snapshot: foreign.snapshot }))
              )
            ).toBe(true);
          })
        )
      );
      const config = join(f.dir, 'snapshot-child.json');
      writeFileSync(
        config,
        JSON.stringify({
          path,
          genesis: Buffer.from(pin.genesis.toBytes()).toString('hex'),
          head: Buffer.from(pin.head.toBytes()).toString('hex'),
          length: pin.length,
          endorser: Buffer.from(pin.endorser.toBytes()).toString('hex'),
          membership: Buffer.from(pin.membershipId.toBytes()).toString('hex'),
          headSignature: Buffer.from(pin.headSignature.toBytes()).toString('hex'),
          digest: Buffer.from(pin.stateDigest!.toBytes()).toString('hex'),
          role: pin.role,
          kind: pin.kind,
        })
      );
      const reopened = await Effect.runPromise(
        runOwnedChild(['--import', 'tsx', 'test/snapshot-cache-reopen.mts', config])
      );
      expect(JSON.parse(reopened)).toEqual({
        length: 2,
        head: Buffer.from(pin.head.toBytes()).toString('hex'),
        verification: 'endorsed-snapshot',
        snapshot: Buffer.from(produced.snapshot).toString('hex'),
      });
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const cache = yield* makeLabSnapshotCache({ path, mode: 'open' });
            const db = new Database(path, { fileMustExist: true });
            try {
              // Same Org and current head, but a valid self-claimed peer cannot
              // replace the independently qualified original endorser after restart.
              db.prepare('UPDATE snapshots SET snapshot=? WHERE genesis=?').run(
                Buffer.from(selfClaimed),
                Buffer.from(pin.genesis.toBytes())
              );
              const after = yield* Effect.result(cache.get(pin));
              expect(Result.isFailure(after)).toBe(true);
              expect(
                Result.isFailure(
                  yield* Effect.result(
                    runOwnedChild(['--import', 'tsx', 'test/snapshot-cache-reopen.mts', config])
                  )
                )
              ).toBe(true);

              const feed = yield* makeLabLedgerClient(options(f, 'create'));
              const restored = yield* restoreLabLedgerFromCacheOrHistory({
                cache,
                trust: pin,
                expected: f.checkpoint,
                history: () => feed.read(f.checkpoint).pipe(Effect.map((saved) => saved.view)),
              });
              expect(restored.source).toBe('full-history');
              expect(restored.view.verification).toBe('full-history');
              const before = yield* feed.current();
              const fabricated = { ...before.view } as unknown as LedgerView;
              expect(
                Result.isFailure(
                  yield* Effect.result(
                    restoreLabLedgerFromCacheOrHistory({
                      cache,
                      trust: pin,
                      expected: f.checkpoint,
                      history: () => Effect.succeed(fabricated),
                    })
                  )
                )
              ).toBe(true);
              const command = yield* prepareDeviceAdmission({
                genesis: f.anchor,
                membershipId: f.membership,
                kind: 'personal',
                signer: other.owner,
                encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(182))),
              });
              const record = yield* signLedgerRecord(
                ok(prepareLedgerCommand(f.view, f.owner.publicKey, command)),
                f.owner
              );
              const appended = yield* Effect.tryPromise({
                try: () =>
                  f.sdk.append({
                    part: {
                      contentType: 'application/octet-stream',
                      body: ok(frameLedgerRecord(record)),
                    },
                  }),
                catch: (e) => e,
              });
              expect(appended.ok).toBe(true);
              const next = { head: hashRecordBytes(record), length: 3 };
              const feedDb = new Database(f.path, { fileMustExist: true });
              try {
                feedDb.exec(
                  'CREATE TRIGGER blocked_meta BEFORE UPDATE ON feed_meta BEGIN SELECT RAISE(IGNORE); END;'
                );
                const blocked = yield* Effect.result(
                  restoreLabLedgerFromCacheOrHistory({
                    cache,
                    trust: pin,
                    expected: next,
                    history: () => feed.read(next).pipe(Effect.map((saved) => saved.view)),
                  })
                );
                expect(Result.isFailure(blocked)).toBe(true);
                const retained = yield* feed.current();
                expect(retained.offset).toBe(before.offset);
                expect(retained.view.head.equals(before.view.head)).toBe(true);
                expect(feedDb.prepare('SELECT count(*) AS n FROM feed_records').get()).toEqual({
                  n: 1,
                });
                feedDb.exec('DROP TRIGGER blocked_meta;');
                const fixed = yield* restoreLabLedgerFromCacheOrHistory({
                  cache,
                  trust: pin,
                  expected: next,
                  history: () => feed.read(next).pipe(Effect.map((saved) => saved.view)),
                });
                expect(fixed.source).toBe('full-history');
                expect(fixed.view.length).toBe(3);
                expect(fixed.view.head.equals(next.head)).toBe(true);
              } finally {
                feedDb.close();
              }
              expect((yield* cache.get(otherPin))?.snapshot()).toEqual(foreign.snapshot);
              expect(
                Result.isFailure(
                  yield* Effect.result(cache.put({ trust: pin, snapshot: produced.snapshot }))
                )
              ).toBe(true);
              expect(
                db
                  .prepare('SELECT snapshot FROM snapshots WHERE genesis=?')
                  .get(Buffer.from(pin.genesis.toBytes()))
              ).toEqual({ snapshot: Buffer.from(selfClaimed) });
            } finally {
              db.close();
            }
          })
        )
      );
    } finally {
      await f.close();
    }
  });
  it('reads back real INSERT/UPDATE triggers and rolls back failed saves, retries the same handle and refuses use after close', async () => {
    const f = await fixture(),
      path = join(f.dir, 'snapshot-save.sqlite');
    let late: Effect.Success<ReturnType<typeof makeLabSnapshotCache>> | undefined;
    try {
      const produced = await Effect.runPromise(
        signLedgerSnapshot({ signer: f.owner, ledger: () => Effect.succeed(f.view) })
      );
      const pin = independentTrust(f, produced.headSignature);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const cache = yield* makeLabSnapshotCache({ path, mode: 'create' });
            late = cache;
            const db = new Database(path, { fileMustExist: true });
            try {
              for (const statement of [
                'CREATE TRIGGER blocked BEFORE INSERT ON snapshots BEGIN SELECT RAISE(IGNORE); END;',
                "CREATE TRIGGER blocked AFTER INSERT ON snapshots BEGIN UPDATE snapshots SET snapshot=X'00'; END;",
              ]) {
                db.exec(statement);
                expect(
                  Result.isFailure(
                    yield* Effect.result(cache.put({ trust: pin, snapshot: produced.snapshot }))
                  )
                ).toBe(true);
                expect(db.prepare('SELECT count(*) AS n FROM snapshots').get()).toEqual({ n: 0 });
                expect(yield* cache.get(pin)).toBeUndefined();
                db.exec('DROP TRIGGER blocked;');
              }
              yield* cache.put({ trust: pin, snapshot: produced.snapshot });
              yield* cache.put({ trust: pin, snapshot: produced.snapshot });
              expect(db.prepare('SELECT count(*) AS n FROM snapshots').get()).toEqual({ n: 1 });
              const bad = new Uint8Array(produced.snapshot);
              bad[bad.length - 1] ^= 1;
              expect(
                Result.isFailure(yield* Effect.result(cache.put({ trust: pin, snapshot: bad })))
              ).toBe(true);
              expect((yield* cache.get(pin))?.snapshot()).toEqual(produced.snapshot);
            } finally {
              db.close();
            }
          })
        )
      );
      expect(Result.isFailure(await Effect.runPromise(Effect.result(late!.get(pin))))).toBe(true);
      expect(
        Result.isFailure(
          await Effect.runPromise(
            Effect.result(
              restoreLabLedgerFromCacheOrHistory({
                cache: late!,
                trust: pin,
                expected: f.checkpoint,
                history: () => Effect.succeed(f.view),
              })
            )
          )
        )
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
});

describe('explicit snapshot-origin ledger consumer', () => {
  it('uses released SDK suffix reads with independent qualification, atomically retries SQL failure and reopens without a genesis replay', async () => {
    const f = await fixture(),
      device = history(183),
      path = join(f.dir, 'snapshot-origin.sqlite');
    try {
      const produced = await Effect.runPromise(
        signLedgerSnapshot({ signer: f.owner, ledger: () => Effect.succeed(f.view) })
      );
      const origin = await f.sdk.read({ offset: '-1' });
      if (!origin.ok) throw new Error('real Riverrun origin unavailable');
      const snapshot = {
        bytes: produced.snapshot,
        trust: independentTrust(f, produced.headSignature),
        offset: origin.result.nextOffset,
      };
      const config = {
        path,
        mode: 'create' as const,
        genesis: f.anchor,
        snapshot,
        expected: f.checkpoint,
        budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
        stream: f.sdk,
      };
      const record = await Effect.runPromise(
        Effect.gen(function* () {
          const command = yield* prepareDeviceAdmission({
            genesis: f.anchor,
            membershipId: f.membership,
            kind: 'personal',
            signer: device.owner,
            encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(184))),
          });
          return yield* signLedgerRecord(
            ok(prepareLedgerCommand(f.view, f.owner.publicKey, command)),
            f.owner
          );
        })
      );
      expect(
        (
          await f.sdk.append({
            part: { contentType: 'application/octet-stream', body: ok(frameLedgerRecord(record)) },
          })
        ).ok
      ).toBe(true);
      const expected = { head: hashRecordBytes(record), length: 3 };
      let savedOffset = '';
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* makeLabLedgerClient(config);
            const initial = yield* client.current();
            expect(initial.view.verification).toBe('endorsed-snapshot');
            expect(initial.offset).toBe(snapshot.offset);
            const db = new Database(path);
            try {
              db.exec(
                'CREATE TRIGGER blocked BEFORE UPDATE ON feed_meta BEGIN SELECT RAISE(IGNORE); END;'
              );
              expect(Result.isFailure(yield* Effect.result(client.read(expected)))).toBe(true);
              expect(db.prepare('SELECT COUNT(*) AS n FROM feed_records').get()).toEqual({
                n: 0,
              });
              expect((yield* client.current()).offset).toBe(initial.offset);
              db.exec('DROP TRIGGER blocked;');
              const accepted = yield* client.read(expected);
              savedOffset = accepted.offset;
              expect(accepted.view.head.equals(expected.head)).toBe(true);
              expect(accepted.view.inspectState().devices.size).toBe(2);
              expect(db.prepare('SELECT record FROM feed_records').all()).toEqual([
                { record: Buffer.from(record) },
              ]);
            } finally {
              db.close();
            }
          })
        )
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* makeLabLedgerClient({ ...config, mode: 'open', expected });
            const reopened = yield* client.current();
            expect(reopened.offset).toBe(savedOffset);
            expect(reopened.view.head.equals(expected.head)).toBe(true);
            expect((yield* client.read(expected)).offset).toBe(savedOffset);
          })
        )
      );
    } finally {
      await f.close();
    }
  });
});
