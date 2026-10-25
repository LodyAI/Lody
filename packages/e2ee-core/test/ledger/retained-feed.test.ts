import { Context, Effect, Layer, Result } from 'effect';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { LedgerFeed, VerifiedLedger } from '../../src/index';
import {
  Bytes,
  exportVerifiedState,
  hashRecordBytes,
  ledgerStateDigest,
  signLedgerSnapshot,
  verifyLedgerSnapshot,
  restoreVerifiedState,
  verifyLedgerEffect,
  extendLedgerEffect,
} from '../../src/protocol';
import {
  LedgerFeedSource,
  LedgerViewSource,
  LedgerViewSourceError,
  LedgerPinStore,
  LedgerFeedStore,
  LocalStoreError,
  WorkspaceScope,
} from '../../src/services';
import { sqliteLedgerFeedStore, sqliteLedgerPinStore } from '../../src/adapters/node-sqlite';
import { envelopeFixture } from '../keys/fixture';
const ok = Result.getOrThrow;

describe('retained ledger feed', () => {
  it('pins before compacting, reopens without replay, then verifies only the suffix', async () => {
    const f = envelopeFixture();
    const directory = mkdtempSync(join(tmpdir(), 'retained-feed-'));
    const scope = Layer.succeed(WorkspaceScope, { genesis: f.context.genesis });
    const stores = Layer.mergeAll(
      sqliteLedgerFeedStore({ path: join(directory, 'feed.sqlite'), mode: 'create-or-open' }),
      sqliteLedgerPinStore({ path: join(directory, 'pin.sqlite'), mode: 'create-or-open' })
    ).pipe(Layer.provideMerge(scope));
    const budget = { maxRecords: 100, maxBytes: 1_000_000 };
    try {
      const origin = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(stores);
            const feedContext = yield* Layer.build(
              LedgerFeed.layer({
                origin: { kind: 'genesis', record: f.genesisRecord },
                expected: { head: hashRecordBytes(f.genesisRecord), length: 1 },
                budget,
              }).pipe(Layer.provide(stores))
            );
            const feed = Context.get(feedContext, LedgerFeed);
            const view = f.view();
            yield* feed.accept(
              { requestOffset: '-1', nextOffset: 'after:2', records: f.records(), upToDate: true },
              { head: view.head, length: view.length }
            );
            const verifiedContext = yield* Layer.build(
              VerifiedLedger.layer.pipe(
                Layer.provide(stores),
                Layer.provide(
                  Layer.succeed(LedgerViewSource, {
                    current: () =>
                      Effect.map(feed.current(), (state) => state.view).pipe(
                        Effect.mapError((cause) => new LedgerViewSourceError({ cause }))
                      ),
                  })
                )
              )
            );
            const saved = yield* feed.rebase().pipe(Effect.provide(verifiedContext));
            const pin = yield* Context.get(context, LedgerPinStore).read();
            expect(pin?.head.equals(view.head)).toBe(true);
            const disk = new Database(join(directory, 'feed.sqlite'));
            try {
              expect(disk.prepare('SELECT count(*) AS count FROM feed_records').get()).toEqual({
                count: 0,
              });
            } finally {
              disk.close();
            }
            return saved;
          })
        )
      );
      f.append([5, f.phone.raw]);
      const view = f.view();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const feedContext = yield* Layer.build(
              LedgerFeed.layer({
                origin,
                expected: { head: origin.state.head, length: origin.state.length },
                budget,
              }).pipe(Layer.provide(stores))
            );
            const feed = Context.get(feedContext, LedgerFeed);
            const before = yield* feed.current();
            expect(before.offset).toBe('after:2');
            yield* feed.accept(
              {
                requestOffset: 'after:2',
                nextOffset: 'after:3',
                records: f.records().slice(2),
                upToDate: true,
              },
              { head: view.head, length: view.length }
            );
            expect(
              ok(ledgerStateDigest((yield* feed.current()).view)).equals(
                ok(ledgerStateDigest(view))
              )
            ).toBe(true);
          })
        )
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('recovers a pin ahead of the saved origin and rejects an incorrect pinned hash without appending', async () => {
    const f = envelopeFixture();
    const saved = ok(exportVerifiedState(f.view()));
    f.append([5, f.phone.raw]);
    const endpoint = { head: f.view().head, length: f.view().length };
    for (const bad of [false, true]) {
      const directory = mkdtempSync(join(tmpdir(), 'retained-crash-'));
      const scope = Layer.succeed(WorkspaceScope, { genesis: f.context.genesis });
      const store = sqliteLedgerFeedStore({
        path: join(directory, 'feed.sqlite'),
        mode: 'create-or-open',
      }).pipe(Layer.provideMerge(scope));
      try {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.result(
              Effect.gen(function* () {
                const feedContext = yield* Layer.build(
                  LedgerFeed.layer({
                    origin: { kind: 'retained', state: saved, offset: 'after:2' },
                    expected: bad ? { ...endpoint, head: saved.head } : endpoint,
                    budget: { maxRecords: 100, maxBytes: 1_000_000 },
                  }).pipe(
                    Layer.provide(store),
                    Layer.provide(
                      Layer.succeed(LedgerFeedSource, {
                        readAfter: (offset) =>
                          Effect.sync(() => {
                            expect(offset).toBe('after:2');
                            return {
                              requestOffset: offset,
                              nextOffset: 'after:3',
                              records: f.records().slice(2),
                              upToDate: true,
                            };
                          }),
                      })
                    )
                  )
                );
                return yield* Context.get(feedContext, LedgerFeed).current();
              })
            )
          )
        );
        if (bad) {
          expect(
            Result.isFailure(result) &&
              ('code' in result.failure ? result.failure.code : result.failure._tag)
          ).toBe('local-evidence-conflict');
          const disk = new Database(join(directory, 'feed.sqlite'));
          try {
            expect(disk.prepare('SELECT count,offset FROM feed_meta').get()).toEqual({
              count: 2,
              offset: 'after:2',
            });
          } finally {
            disk.close();
          }
        } else
          expect(Result.isSuccess(result) && result.success.view.head.equals(endpoint.head)).toBe(
            true
          );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('returns a rebuildable error for a cache newer than its pin or with corrupt bytes', async () => {
    const f = envelopeFixture();
    const saved = ok(exportVerifiedState(f.view()));
    for (const corrupt of [false, true]) {
      const directory = mkdtempSync(join(tmpdir(), 'retained-invalid-'));
      try {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.result(
              Layer.build(
                LedgerFeed.layer({
                  origin: {
                    kind: 'retained',
                    state: corrupt ? { ...saved, bytes: new Uint8Array([0]) } : saved,
                    offset: 'after:2',
                  },
                  expected: corrupt
                    ? { head: saved.head, length: saved.length }
                    : { head: hashRecordBytes(f.genesisRecord), length: 1 },
                  budget: { maxRecords: 100, maxBytes: 1_000_000 },
                }).pipe(
                  Layer.provide(
                    sqliteLedgerFeedStore({ path: join(directory, 'feed.sqlite'), mode: 'create' })
                  ),
                  Layer.provide(Layer.succeed(WorkspaceScope, { genesis: f.context.genesis }))
                )
              )
            )
          )
        );
        expect(
          Result.isFailure(result) &&
            ('code' in result.failure ? result.failure.code : result.failure._tag)
        ).toBe('retained-cache-invalid');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
  it('preserves endorsed provenance and rejects other-genesis, unknown-format and invalid-suffix state without progress', async () => {
    const f = envelopeFixture();
    const signed = await Effect.runPromise(
      signLedgerSnapshot({ signer: f.owner.signer, ledger: f.ledger })
    );
    const ownerMember = f.view().inspectState().owner;
    const snapshotView = ok(
      verifyLedgerSnapshot({
        snapshot: signed.snapshot,
        trust: {
          source: 'external-confirmation',
          genesis: f.context.genesis,
          endorser: f.owner.publicKey,
          membershipId: ownerMember,
          role: 'owner',
          kind: 'personal',
          head: signed.head,
          length: signed.length,
          headSignature: signed.headSignature,
        },
      })
    );
    const saved = ok(exportVerifiedState(snapshotView));
    const directory = mkdtempSync(join(tmpdir(), 'retained-provenance-'));
    try {
      const workspace = Layer.succeed(WorkspaceScope, { genesis: f.context.genesis });
      const store = sqliteLedgerFeedStore({
        path: join(directory, 'feed.sqlite'),
        mode: 'create-or-open',
      }).pipe(Layer.provideMerge(workspace));
      const options = {
        origin: { kind: 'retained' as const, state: saved, offset: 'after:2' },
        expected: { head: saved.head, length: saved.length },
        budget: { maxRecords: 100, maxBytes: 1_000_000 },
      };
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              LedgerFeed.layer(options).pipe(Layer.provide(store))
            );
            const feed = Context.get(context, LedgerFeed);
            const before = yield* feed.current();
            expect(before.view.verification).toBe(snapshotView.verification);
            f.append([5, f.phone.raw]);
            const record = f.records().at(-1)!;
            record[record.length - 1] ^= 1;
            const result = yield* Effect.result(
              feed.accept(
                {
                  requestOffset: before.offset,
                  nextOffset: 'after:3',
                  upToDate: true,
                  records: [record],
                },
                { head: hashRecordBytes(record), length: 3 }
              )
            );
            expect(Result.isFailure(result)).toBe(true);
            expect((yield* feed.current()).offset).toBe(before.offset);
            expect((yield* feed.current()).view.head.equals(before.view.head)).toBe(true);
          })
        )
      );
      for (const variant of [
        { state: { ...saved, bytes: new Uint8Array([1]) }, genesis: f.context.genesis },
        { state: saved, genesis: ok(Bytes.genesisHash(new Uint8Array(32).fill(42))) },
      ]) {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.result(
              Layer.build(
                LedgerFeed.layer({
                  ...options,
                  origin: { ...options.origin, state: variant.state },
                }).pipe(
                  Layer.provide(
                    sqliteLedgerFeedStore({
                      path: join(
                        directory,
                        `invalid-${variant.genesis === f.context.genesis ? 'version' : 'workspace'}.sqlite`
                      ),
                      mode: 'create',
                    })
                  ),
                  Layer.provide(Layer.succeed(WorkspaceScope, { genesis: variant.genesis }))
                )
              )
            )
          )
        );
        expect(Result.isFailure(result) && 'code' in result.failure && result.failure.code).toBe(
          'retained-cache-invalid'
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps original rows when the pin write fails and rejects stale-tail rebase without mutation', async () => {
    const f = envelopeFixture();
    const directory = mkdtempSync(join(tmpdir(), 'retained-pin-failure-'));
    const workspace = Layer.succeed(WorkspaceScope, { genesis: f.context.genesis });
    const stores = sqliteLedgerFeedStore({
      path: join(directory, 'feed.sqlite'),
      mode: 'create',
    }).pipe(Layer.provideMerge(workspace));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              LedgerFeed.layer({
                origin: { kind: 'genesis', record: f.genesisRecord },
                expected: { head: hashRecordBytes(f.genesisRecord), length: 1 },
                budget: { maxRecords: 100, maxBytes: 1_000_000 },
              }).pipe(Layer.provideMerge(stores))
            );
            const feed = Context.get(context, LedgerFeed);
            const store = Context.get(context, LedgerFeedStore);
            const endpoint = f.view();
            yield* feed.accept(
              { requestOffset: '-1', nextOffset: 'after:2', upToDate: true, records: f.records() },
              { head: endpoint.head, length: endpoint.length }
            );
            const before = (yield* store.load(100))!;
            const verified = VerifiedLedger.layer.pipe(
              Layer.provide(workspace),
              Layer.provide(
                Layer.succeed(LedgerViewSource, { current: () => Effect.succeed(endpoint) })
              ),
              Layer.provide(
                Layer.succeed(LedgerPinStore, {
                  read: () => Effect.succeed(null),
                  write: () =>
                    Effect.fail(
                      new LocalStoreError({ store: 'LedgerPinStore', reason: 'storage' })
                    ),
                })
              )
            );
            expect(
              Result.isFailure(yield* Effect.result(feed.rebase().pipe(Effect.provide(verified))))
            ).toBe(true);
            expect(yield* store.load(100)).toEqual(before);
            const saved = ok(exportVerifiedState(endpoint));
            const next = { ...before.tail, bytes: saved.bytes.length };
            const failed = yield* Effect.result(
              store.rebase(
                { ...before.tail, offset: 'stale-offset' },
                saved.bytes,
                saved.length,
                next
              )
            );
            expect(Result.isFailure(failed) && failed.failure.reason).toBe('conflict');
            expect(yield* store.load(100)).toEqual(before);
          })
        )
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('records 10k-record full replay versus restore plus ten records without a timing threshold', async () => {
    const f = envelopeFixture();
    for (let epoch = 1; epoch <= 10_008; epoch++) {
      const commitment = new Uint8Array(
        createHash('sha256').update(`synthetic-epoch-${epoch}`).digest()
      );
      f.append([7, epoch, commitment, new Uint8Array(72).fill(6)]);
    }
    const records = f.records();
    const prefixLength = 10_000;
    const prefix = await Effect.runPromise(
      verifyLedgerEffect({
        anchor: f.context.genesis,
        records: records.slice(0, prefixLength),
        checkpoint: { head: hashRecordBytes(records[prefixLength - 1]!), length: prefixLength },
      })
    );
    const saved = ok(exportVerifiedState(prefix));
    const checkpoint = { head: hashRecordBytes(records.at(-1)!), length: records.length };
    const start = performance.now();
    const resumed = await Effect.runPromise(
      extendLedgerEffect(ok(restoreVerifiedState(saved)), records.slice(prefixLength), checkpoint)
    );
    const retainedMs = performance.now() - start;
    const fullStart = performance.now();
    const replayed = await Effect.runPromise(
      verifyLedgerEffect({ anchor: f.context.genesis, records, checkpoint })
    );
    const fullMs = performance.now() - fullStart;
    expect(ok(ledgerStateDigest(resumed)).equals(ok(ledgerStateDigest(replayed)))).toBe(true);
    console.info(
      JSON.stringify({
        fixture: 'synthetic-10k-ledger',
        retainedPlusTenMs: retainedMs,
        fullReplayMs: fullMs,
      })
    );
  }, 120_000);
});
