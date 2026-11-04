import { execNativeChild } from './native-child';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Effect, Result, type Scope } from 'effect';
import { describe, expect, it } from 'vitest';
import { Bytes } from '@lody/e2ee-core/protocol';
import {
  signLedgerSnapshot,
  snapshotTrustFromView,
  type SnapshotTrust,
} from '@lody/e2ee-core/protocol';
import {
  makeSqliteSnapshotLedgerFeed,
  type SqliteSnapshotLedgerFeedInput,
} from './ledger/feed-fixture';
import { envelopeFixture } from './keys/fixture';

const ok = Result.getOrThrow;
const run = <A, E>(work: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(work));
async function fixture() {
  const f = envelopeFixture(),
    view = f.view();
  const signed = await Effect.runPromise(
    signLedgerSnapshot({ signer: f.owner.signer, ledger: () => Effect.succeed(view) })
  );
  const trust: SnapshotTrust = {
    source: 'external-confirmation',
    genesis: f.context.genesis,
    head: view.head,
    length: view.length,
    endorser: f.owner.publicKey,
    membershipId: ok(Bytes.membershipId(new Uint8Array(16).fill(10))),
    role: 'owner',
    kind: 'personal',
    headSignature: signed.headSignature,
  };
  f.append([5, f.phone.raw]);
  const next = f.view(),
    suffix = f.records().slice(view.length),
    dir = mkdtempSync(join(tmpdir(), 'e2ee-snapshot-feed-'));
  const input = (path = join(dir, 'feed.sqlite')): SqliteSnapshotLedgerFeedInput => ({
    path,
    mode: 'create',
    genesis: f.context.genesis,
    snapshot: { bytes: new Uint8Array(signed.snapshot), trust, offset: 'opaque/origin' },
    expected: { head: view.head, length: view.length },
    budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
  });
  const page = () => ({
    requestOffset: 'opaque/origin',
    nextOffset: 'opaque/suffix',
    records: suffix.map((record) => new Uint8Array(record)),
    upToDate: true,
  });
  const expected = { head: next.head, length: next.length };
  return { f, view, next, signed, trust, suffix, dir, input, page, expected };
}
function rows(db: Database.Database) {
  return {
    meta: db.prepare('SELECT * FROM feed_meta').all(),
    records: db.prepare('SELECT * FROM feed_records ORDER BY position').all(),
  };
}

describe('independently qualified snapshot origin with durable exact suffix', () => {
  it('extends without the genesis prefix, persists originals and reverifies in another OS process', async () => {
    const f = await fixture(),
      config = f.input();
    try {
      await run(
        Effect.gen(function* () {
          const feed = yield* makeSqliteSnapshotLedgerFeed(config);
          const before = yield* feed.current();
          expect(before.view.verification).toBe('endorsed-snapshot');
          expect(before.view.historyStart).toBe(1);
          expect(before.bootstrap).toBe(false);
          const after = yield* feed.accept(f.page(), f.expected);
          expect(after.view.head.equals(f.next.head)).toBe(true);
          expect(after.view.inspectState().devices.size).toBe(1);
          expect(after.offset).toBe('opaque/suffix');
        })
      );
      const db = new Database(config.path);
      expect(db.prepare('SELECT COUNT(*) AS n FROM feed_records').get()).toEqual({ n: 1 });
      expect(
        (db.prepare('SELECT record FROM feed_records').get() as { record: Uint8Array }).record
      ).toEqual(Buffer.from(f.suffix[0]!));
      db.close();
      const childConfig = join(f.dir, 'child.json');
      writeFileSync(
        childConfig,
        JSON.stringify({
          path: config.path,
          genesis: Buffer.from(config.genesis.toBytes()).toString('hex'),
          snapshot: Buffer.from(config.snapshot.bytes).toString('hex'),
          originOffset: config.snapshot.offset,
          trust: {
            head: Buffer.from(f.trust.head.toBytes()).toString('hex'),
            length: f.trust.length,
            endorser: Buffer.from(f.trust.endorser.toBytes()).toString('hex'),
            membershipId: Buffer.from(f.trust.membershipId.toBytes()).toString('hex'),
            headSignature: Buffer.from(f.trust.headSignature.toBytes()).toString('hex'),
          },
          head: Buffer.from(f.next.head.toBytes()).toString('hex'),
          length: f.next.length,
        })
      );
      const output = await execNativeChild(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('./snapshot-feed-reopen.mts', import.meta.url)),
          childConfig,
        ],
        { cwd: fileURLToPath(new URL('..', import.meta.url)) }
      );
      const report = JSON.parse(output);
      expect(report).toEqual({
        pid: expect.any(Number),
        offset: 'opaque/suffix',
        length: 3,
        head: Buffer.from(f.next.head.toBytes()).toString('hex'),
        verification: 'endorsed-snapshot',
      });
      expect(report.pid).not.toBe(process.pid);
      expect(readFileSync(childConfig).length).toBeGreaterThan(0);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('captures owned snapshot/suffix bytes without invoking caller array or byte iterators', async () => {
    const f = await fixture(),
      config = f.input();
    try {
      await run(
        Effect.gen(function* () {
          const feed = yield* makeSqliteSnapshotLedgerFeed(config);
          config.snapshot.bytes.fill(0);
          const page = f.page();
          Object.defineProperty(page.records, 'map', {
            value: () => {
              throw new Error('caller map');
            },
          });
          Object.defineProperty(page.records, Symbol.iterator, {
            value: () => {
              throw new Error('caller iterator');
            },
          });
          Object.defineProperty(page.records[0]!, Symbol.iterator, {
            value: () => {
              throw new Error('byte iterator');
            },
          });
          yield* feed.accept(page, f.expected);
          page.records[0]!.fill(0);
          const current = yield* feed.current();
          expect(current.view.head.equals(f.next.head)).toBe(true);
          const idle = yield* feed.accept(
            {
              requestOffset: current.offset,
              nextOffset: current.offset,
              records: [],
              upToDate: true,
            },
            f.expected
          );
          expect(idle.offset).toBe(current.offset);
        })
      );
      await run(
        makeSqliteSnapshotLedgerFeed({
          ...f.input(config.path),
          mode: 'open',
          expected: f.expected,
        })
      );
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid qualification, forged genuine tokens, changed origin and foreign Org instead of choosing disk authority', async () => {
    const f = await fixture();
    try {
      const token = ok(snapshotTrustFromView(f.view, f.f.owner.publicKey, f.signed.headSignature));
      const config = f.input();
      await run(
        makeSqliteSnapshotLedgerFeed({ ...config, snapshot: { ...config.snapshot, trust: token } })
      );
      const bad = new Uint8Array(f.signed.snapshot);
      bad[bad.length - 1]! ^= 1;
      for (const snapshot of [
        { ...config.snapshot, trust: { ...f.trust, role: 'admin' as const } },
        { ...config.snapshot, trust: { source: 'verified-view' } as typeof token },
        { ...config.snapshot, bytes: bad },
        { ...config.snapshot, offset: 'opaque/different' },
      ]) {
        expect(
          Result.isFailure(
            await run(
              Effect.result(makeSqliteSnapshotLedgerFeed({ ...config, mode: 'open', snapshot }))
            )
          )
        ).toBe(true);
      }
      expect(
        Result.isFailure(
          await run(
            Effect.result(
              makeSqliteSnapshotLedgerFeed({
                ...config,
                mode: 'open',
                genesis: ok(Bytes.genesisHash(new Uint8Array(32).fill(200))),
              })
            )
          )
        )
      ).toBe(true);
      const reopened = await run(
        Effect.gen(function* () {
          return yield* (yield* makeSqliteSnapshotLedgerFeed({
            ...config,
            mode: 'open',
          })).current();
        })
      );
      expect(reopened.view.head.equals(f.view.head)).toBe(true);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('rolls back failed inserts and metadata writes, then retries the same handle', async () => {
    const f = await fixture();
    const faults = [
      'CREATE TRIGGER fault BEFORE INSERT ON feed_records BEGIN SELECT RAISE(IGNORE); END',
      'CREATE TRIGGER fault BEFORE UPDATE ON feed_meta BEGIN SELECT RAISE(IGNORE); END',
      "CREATE TRIGGER fault BEFORE UPDATE ON feed_meta BEGIN SELECT RAISE(ABORT,'injected failure'); END",
    ];
    try {
      for (let index = 0; index < faults.length; index++) {
        const config = f.input(join(f.dir, `fault-${index}.sqlite`));
        await run(
          Effect.gen(function* () {
            const feed = yield* makeSqliteSnapshotLedgerFeed(config);
            const db = new Database(config.path);
            try {
              const original = rows(db);
              db.exec(faults[index]!);
              expect(
                Result.isFailure(yield* Effect.result(feed.accept(f.page(), f.expected)))
              ).toBe(true);
              expect(rows(db)).toEqual(original);
              expect((yield* feed.current()).offset).toBe('opaque/origin');
              db.exec('DROP TRIGGER fault');
              expect((yield* feed.accept(f.page(), f.expected)).view.head.equals(f.next.head)).toBe(
                true
              );
            } finally {
              db.close();
            }
          })
        );
        await run(makeSqliteSnapshotLedgerFeed({ ...config, mode: 'open', expected: f.expected }));
      }
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('rejects stale handles, duplicate history, wrong endpoints, empty cursor jumps and budget exhaustion', async () => {
    const f = await fixture(),
      config = f.input();
    try {
      await run(
        Effect.gen(function* () {
          const feed = yield* makeSqliteSnapshotLedgerFeed(config);
          const stale = yield* makeSqliteSnapshotLedgerFeed({ ...config, mode: 'open' });
          const failures = [
            feed.accept({ ...f.page(), records: [f.f.records()[1]!] }, config.expected),
            feed.accept(f.page(), config.expected),
            feed.accept({ ...f.page(), records: [] }, config.expected),
          ];
          for (const attempt of failures)
            expect(Result.isFailure(yield* Effect.result(attempt))).toBe(true);
          expect((yield* feed.current()).offset).toBe('opaque/origin');
          yield* feed.accept(f.page(), f.expected);
          expect(Result.isFailure(yield* Effect.result(stale.current()))).toBe(true);
          expect(Result.isFailure(yield* Effect.result(stale.accept(f.page(), f.expected)))).toBe(
            true
          );
        })
      );
      const small = f.input(join(f.dir, 'budget.sqlite'));
      await run(
        Effect.gen(function* () {
          const feed = yield* makeSqliteSnapshotLedgerFeed({
            ...small,
            budget: { ...small.budget, maxRecords: 2 },
          });
          expect(Result.isFailure(yield* Effect.result(feed.accept(f.page(), f.expected)))).toBe(
            true
          );
          expect((yield* feed.current()).view.length).toBe(2);
        })
      );
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('rejects a changed array length before writes and continues with a valid suffix', async () => {
    const f = await fixture(),
      config = f.input();
    try {
      await run(
        Effect.gen(function* () {
          const feed = yield* makeSqliteSnapshotLedgerFeed(config);
          const shrinking = f.page(),
            original = shrinking.records[0]!;
          Object.defineProperty(shrinking.records, 0, {
            get: () => {
              shrinking.records.length = 0;
              return original;
            },
          });
          expect(Result.isFailure(yield* Effect.result(feed.accept(shrinking, f.expected)))).toBe(
            true
          );
          expect((yield* feed.current()).view.length).toBe(2);
          yield* feed.accept(f.page(), f.expected);
          f.f.append([7, 1, new Uint8Array(32).fill(91), new Uint8Array(72).fill(92)]);
          const next = f.f.view(),
            checkpoint = { head: next.head, length: next.length },
            page = {
              requestOffset: 'opaque/suffix',
              nextOffset: 'opaque/next',
              records: f.f.records().slice(-1),
              upToDate: true,
            };
          expect((yield* feed.accept(page, checkpoint)).view.head.equals(next.head)).toBe(true);
        })
      );
      const next = f.f.view();
      await run(
        makeSqliteSnapshotLedgerFeed({
          ...config,
          mode: 'open',
          expected: { head: next.head, length: next.length },
        })
      );
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
