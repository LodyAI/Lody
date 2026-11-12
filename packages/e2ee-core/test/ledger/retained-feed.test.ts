import { Context, Effect, Layer, Result } from 'effect';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  decodeRetainedCbor,
  decodeSnapshotCbor,
  encodeSnapshotCbor,
  encodeRetainedCbor,
  encodeCbor,
  type CborValue,
} from '../../src/internal/foundation/cbor';
import { describe, expect, it, vi } from 'vitest';
import { LedgerFeed, VerifiedLedger } from '../../src/index';
import {
  Bytes,
  exportVerifiedState,
  restoreVerifiedState,
  hashRecordBytes,
  recordSigningBytes,
  ledgerStateDigest,
  epochPublicationRecord,
  signLedgerSnapshot,
  snapshotSigningBytes,
  verifyLedgerSnapshot,
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
import { setEd25519WasmEnabled } from '../../src/internal/foundation/ed25519-wasm';
const ok = Result.getOrThrow;

describe('retained ledger feed', () => {
  it('keeps the pre-change snapshot bytes, signatures and comparison digest exactly unchanged', async () => {
    const f = envelopeFixture();
    const signed = await Effect.runPromise(
      signLedgerSnapshot({ signer: f.owner.signer, ledger: f.ledger })
    );
    expect(createHash('sha256').update(signed.snapshot).digest('hex')).toBe(
      'd3961feb650acccc069114847733dbd7e29aee3ae1674a2f6b45b83ee128f317'
    );
    expect(Buffer.from(signed.headSignature.toBytes()).toString('hex')).toBe(
      'c1746093ea45c0b4142ca7cd006675df3adc1b0529d45a0073d630d6abe679c140ab22ac9a0c967db1fadbb9d2f058e4601d92d7ea9faa5b7ab8c833eace2a08'
    );
    expect(Buffer.from(ok(ledgerStateDigest(f.view())).toBytes()).toString('hex')).toBe(
      'ccd3d07823fa896270a139215d73a456ab8e8753805147b626a57eb105b43742'
    );
  });

  it('retains at least forty publications through round-trip, rebase and damaged-cache rebuild', async () => {
    const f = envelopeFixture();
    for (let epoch = 1; epoch <= 40; epoch++)
      f.append([7, epoch, new Uint8Array(32).fill(epoch), new Uint8Array(72).fill(epoch)]);
    const full = f.view(),
      saved = ok(exportVerifiedState(full)),
      restored = ok(restoreVerifiedState(saved));
    for (let epoch = 1; epoch <= 40; epoch++)
      expect(ok(epochPublicationRecord(restored, epoch))).toEqual(
        ok(epochPublicationRecord(full, epoch))
      );
    // Lengths, order and inclusion must be checked before accepting a binary table.
    const root = ok(decodeRetainedCbor(saved.bytes)) as CborValue[];
    const table = root[8] as Uint8Array;
    for (const fault of ['truncated', 'length', 'order', 'hash'] as const) {
      const bad = new Uint8Array(
        table.subarray(0, fault === 'truncated' ? table.length - 1 : table.length)
      );
      const fields = new DataView(bad.buffer);
      if (fault === 'length') fields.setUint16(4, 8193);
      if (fault === 'order') fields.setUint32(6 + fields.getUint16(4), 1);
      if (fault === 'hash') bad[6] ^= 1;
      root[8] = bad;
      expect(
        Result.isFailure(restoreVerifiedState({ ...saved, bytes: ok(encodeRetainedCbor(root)) })),
        fault
      ).toBe(true);
    }
    const directory = mkdtempSync(join(tmpdir(), 'feed-forty-'));
    const stores = Layer.mergeAll(
      sqliteLedgerFeedStore({ path: join(directory, 'feed.sqlite'), mode: 'create-or-open' }),
      sqliteLedgerPinStore({ path: join(directory, 'pin.sqlite'), mode: 'create-or-open' })
    ).pipe(Layer.provideMerge(Layer.succeed(WorkspaceScope, { genesis: f.context.genesis })));
    const options = {
      origin: { kind: 'genesis' as const, record: f.genesisRecord },
      expected: { head: hashRecordBytes(f.genesisRecord), length: 1 },
      budget: { maxRecords: 100, maxBytes: 32 * 1024 * 1024 },
    };
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(LedgerFeed.layer(options).pipe(Layer.provide(stores)));
            const feed = Context.get(ctx, LedgerFeed);
            yield* feed.accept(
              { requestOffset: '-1', nextOffset: 'forty', records: f.records(), upToDate: true },
              { head: full.head, length: full.length }
            );
            const verified = VerifiedLedger.layer.pipe(
              Layer.provide(stores),
              Layer.provide(
                Layer.succeed(LedgerViewSource, { current: () => Effect.succeed(full) })
              )
            );
            const origin = yield* feed.rebase().pipe(Effect.provide(verified));
            expect(ok(epochPublicationRecord(ok(restoreVerifiedState(origin.state)), 40))).toEqual(
              f.records().at(-1)
            );
          })
        )
      );
      const disk = new Database(join(directory, 'feed.sqlite'));
      disk.exec("UPDATE feed_meta SET origin=X'00'");
      disk.close();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(
              LedgerFeed.layer({
                ...options,
                expected: { head: full.head, length: full.length },
              }).pipe(
                Layer.provide(stores),
                Layer.provide(
                  Layer.succeed(LedgerFeedSource, {
                    readAfter: (offset) =>
                      Effect.succeed({
                        requestOffset: offset,
                        nextOffset: 'forty',
                        records: f.records(),
                        upToDate: true,
                      }),
                  })
                )
              )
            );
            const rebuilt = (yield* Context.get(ctx, LedgerFeed).current()).view;
            expect(ok(epochPublicationRecord(rebuilt, 40))).toEqual(f.records().at(-1));
            expect(rebuilt.head.equals(full.head)).toBe(true);
          })
        )
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('catches up a nonempty genesis-origin cache at three records to its independent pin at five', async () => {
    const f = envelopeFixture();
    f.append([9, [1]]);
    const prefix = { head: f.view().head, length: 3 };
    f.append([7, 1, new Uint8Array(32).fill(31), new Uint8Array(72)]);
    f.append([7, 2, new Uint8Array(32).fill(32), new Uint8Array(72)]);
    const endpoint = { head: f.view().head, length: 5 },
      directory = mkdtempSync(join(tmpdir(), 'feed-behind-'));
    const stores = Layer.mergeAll(
      sqliteLedgerFeedStore({ path: join(directory, 'feed.sqlite'), mode: 'create-or-open' }),
      sqliteLedgerPinStore({ path: join(directory, 'pin.sqlite'), mode: 'create-or-open' })
    ).pipe(Layer.provideMerge(Layer.succeed(WorkspaceScope, { genesis: f.context.genesis })));
    const options = {
      origin: { kind: 'genesis' as const, record: f.genesisRecord },
      expected: { head: hashRecordBytes(f.genesisRecord), length: 1 },
      budget: { maxRecords: 100, maxBytes: 1_000_000 },
    };
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(
              LedgerFeed.layer(options).pipe(Layer.provideMerge(stores))
            );
            yield* Context.get(ctx, LedgerFeed).accept(
              {
                requestOffset: '-1',
                nextOffset: 'three',
                records: f.records().slice(0, 3),
                upToDate: false,
              },
              prefix
            );
            yield* Context.get(ctx, LedgerPinStore).write(endpoint);
          })
        )
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(
              LedgerFeed.layer({ ...options, expected: prefix }).pipe(
                Layer.provide(stores),
                Layer.provide(
                  Layer.succeed(LedgerFeedSource, {
                    readAfter: (offset) =>
                      Effect.succeed({
                        requestOffset: offset,
                        nextOffset: 'five',
                        records: f.records(),
                        upToDate: true,
                      }),
                  })
                )
              )
            );
            expect(
              (yield* Context.get(ctx, LedgerFeed).current()).view.head.equals(endpoint.head)
            ).toBe(true);
          })
        )
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses invalid or unsupported origins before discovering a local cache or replaying a network source', async () => {
    const f = envelopeFixture(),
      signed = await Effect.runPromise(
        signLedgerSnapshot({ signer: f.owner.signer, ledger: f.ledger })
      );
    const trust = {
      source: 'external-confirmation' as const,
      genesis: f.context.genesis,
      endorser: f.owner.publicKey,
      membershipId: f.view().inspectState().owner,
      role: 'owner' as const,
      kind: 'personal' as const,
      head: signed.head,
      length: signed.length,
      headSignature: signed.headSignature,
    };
    const snapshot = ok(decodeSnapshotCbor(signed.snapshot)) as CborValue[],
      body = snapshot[0] as CborValue[];
    (body[5] as CborValue[])[7] = [2];
    const unsupported = ok(
      encodeSnapshotCbor([
        body,
        f.owner.signBytes(snapshotSigningBytes(ok(encodeSnapshotCbor(body)))),
      ])
    );
    const badGenesis = new Uint8Array(f.genesisRecord);
    badGenesis[badGenesis.length - 1] ^= 1;
    const saved = ok(exportVerifiedState(f.view())),
      root = ok(decodeRetainedCbor(saved.bytes)) as CborValue[];
    (root[4] as CborValue[])[7] = [2];
    const variants = [
      { origin: { kind: 'genesis' as const, record: badGenesis }, code: 'wrong-parent' },
      {
        origin: {
          kind: 'snapshot' as const,
          snapshot: { bytes: new Uint8Array([0]), trust, offset: 'two' },
        },
        code: 'wrong-parent',
      },
      {
        origin: {
          kind: 'snapshot' as const,
          snapshot: { bytes: unsupported, trust, offset: 'two' },
        },
        code: 'upgrade-required',
      },
      {
        origin: {
          kind: 'retained' as const,
          state: { ...saved, bytes: ok(encodeRetainedCbor(root)) },
          offset: 'two',
        },
        code: 'upgrade-required',
      },
    ];
    for (const variant of variants) {
      const directory = mkdtempSync(join(tmpdir(), 'feed-origin-refusal-'));
      const stores = sqliteLedgerFeedStore({
        path: join(directory, 'feed.sqlite'),
        mode: 'create-or-open',
      }).pipe(Layer.provideMerge(Layer.succeed(WorkspaceScope, { genesis: f.context.genesis })));
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const ctx = yield* Layer.build(stores);
              yield* Context.get(ctx, LedgerFeedStore).initialize(saved.bytes, saved.length, {
                head: saved.head.toBytes(),
                count: saved.length,
                bytes: saved.bytes.length,
                offset: 'two',
                bootstrap: false,
              });
              const result = yield* Effect.result(
                Layer.build(
                  LedgerFeed.layer({
                    origin: variant.origin,
                    expected: { head: saved.head, length: saved.length },
                    budget: { maxRecords: 100, maxBytes: 1_000_000 },
                  }).pipe(
                    Layer.provide(stores),
                    Layer.provide(
                      Layer.succeed(LedgerFeedSource, {
                        readAfter: () =>
                          Effect.die('an invalid origin must never access the source'),
                      })
                    )
                  )
                )
              );
              expect(
                Result.isFailure(result) && 'code' in result.failure && result.failure.code
              ).toBe(variant.code);
              expect((yield* Context.get(ctx, LedgerFeedStore).load(100))?.origin).toEqual(
                saved.bytes
              );
            })
          )
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it.each(['upgrade-required', 'native-unavailable'] as const)(
    'preserves %s from stored suffix verification without rebuilding',
    async (failure) => {
      const f = envelopeFixture(0, 218),
        directory = mkdtempSync(join(tmpdir(), 'feed-source-failure-'));
      if (failure === 'upgrade-required') f.append([9, [2]]);
      const records = f.records(),
        endpoint = { head: hashRecordBytes(records.at(-1)!), length: records.length };
      const stores = sqliteLedgerFeedStore({
        path: join(directory, 'feed.sqlite'),
        mode: 'create-or-open',
      }).pipe(Layer.provideMerge(Layer.succeed(WorkspaceScope, { genesis: f.context.genesis })));
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const ctx = yield* Layer.build(stores),
                store = Context.get(ctx, LedgerFeedStore);
              const tail = {
                head: hashRecordBytes(f.genesisRecord).toBytes(),
                count: 1,
                bytes: f.genesisRecord.length,
                offset: '-1',
                bootstrap: true,
              };
              yield* store.initialize(f.genesisRecord, 1, tail);
              yield* store.append(tail, records.slice(1), {
                ...tail,
                head: endpoint.head.toBytes(),
                count: endpoint.length,
                bytes: records.reduce((n, row) => n + row.length, 0),
                offset: 'end',
                bootstrap: false,
              });
              const before = yield* store.load(100);
              const native =
                failure === 'native-unavailable'
                  ? vi
                      .spyOn(globalThis.crypto.subtle, 'verify')
                      .mockRejectedValue(new Error('injected native failure'))
                  : undefined;
              if (native) setEd25519WasmEnabled(false);
              try {
                const result = yield* Effect.result(
                  Layer.build(
                    LedgerFeed.layer({
                      origin: { kind: 'genesis', record: f.genesisRecord },
                      expected: endpoint,
                      budget: { maxRecords: 100, maxBytes: 1_000_000 },
                    }).pipe(
                      Layer.provide(stores),
                      Layer.provide(
                        Layer.succeed(LedgerFeedSource, {
                          readAfter: () =>
                            Effect.die('protocol and environment failures cannot trigger replay'),
                        })
                      )
                    )
                  )
                );
                expect(
                  Result.isFailure(result) && 'code' in result.failure && result.failure.code
                ).toBe(failure);
                if (failure === 'upgrade-required')
                  expect(
                    Result.isFailure(result) &&
                      'position' in result.failure &&
                      result.failure.position
                  ).toBe(2);
                expect(yield* store.load(100)).toEqual(before);
              } finally {
                native?.mockRestore();
                setEd25519WasmEnabled(true);
              }
            })
          )
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it('widens the old SQLite cache limit without changing its originals, then persists origins above sixteen MiB', async () => {
    const f = envelopeFixture(),
      directory = mkdtempSync(join(tmpdir(), 'feed-byte-budget-'));
    const stores = sqliteLedgerFeedStore({
      path: join(directory, 'feed.sqlite'),
      mode: 'create-or-open',
    }).pipe(Layer.provideMerge(Layer.succeed(WorkspaceScope, { genesis: f.context.genesis })));
    const tail = {
      head: f.view().head.toBytes(),
      count: 2,
      bytes: 1,
      offset: 'two',
      bootstrap: false,
    };
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(stores);
            yield* Context.get(ctx, LedgerFeedStore).initialize(Uint8Array.of(7), 2, tail);
          })
        )
      );
      const old = new Database(join(directory, 'feed.sqlite'));
      old.exec(`CREATE TABLE feed_meta_old(id INTEGER PRIMARY KEY CHECK(id=1),genesis BLOB NOT NULL CHECK(length(genesis)=32),origin BLOB CHECK(origin IS NULL OR length(origin) BETWEEN 1 AND 16777216),origin_count INTEGER,head BLOB,count INTEGER,offset TEXT,bootstrap INTEGER,bytes INTEGER);
        INSERT INTO feed_meta_old SELECT * FROM feed_meta; DROP TABLE feed_meta; ALTER TABLE feed_meta_old RENAME TO feed_meta;`);
      old.close();
      const origin = new Uint8Array(17 * 1024 * 1024).fill(7);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(stores),
              store = Context.get(ctx, LedgerFeedStore);
            expect((yield* store.load(100))?.origin).toEqual(Uint8Array.of(7));
            yield* store.rebase(tail, origin, 2, { ...tail, bytes: origin.length });
          })
        )
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(stores),
              saved = yield* Context.get(ctx, LedgerFeedStore).load(100);
            expect(saved?.origin.length).toBe(origin.length);
            expect(saved?.origin.at(-1)).toBe(7);
            expect(saved?.tail.count).toBe(2);
          })
        )
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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

  it('reopens the committed origin after a crash before the caller saves its rebase result', async () => {
    const f = envelopeFixture(),
      directory = mkdtempSync(join(tmpdir(), 'feed-origin-crash-'));
    const original = { kind: 'genesis' as const, record: f.genesisRecord };
    const options = {
      origin: original,
      expected: { head: hashRecordBytes(f.genesisRecord), length: 1 },
      budget: { maxRecords: 100, maxBytes: 1_000_000 },
    };
    const stores = Layer.mergeAll(
      sqliteLedgerFeedStore({ path: join(directory, 'feed.sqlite'), mode: 'create-or-open' }),
      sqliteLedgerPinStore({ path: join(directory, 'pin.sqlite'), mode: 'create-or-open' })
    ).pipe(Layer.provideMerge(Layer.succeed(WorkspaceScope, { genesis: f.context.genesis })));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(
              LedgerFeed.layer(options).pipe(Layer.provideMerge(stores))
            );
            const feed = Context.get(ctx, LedgerFeed),
              endpoint = f.view();
            yield* feed.accept(
              { requestOffset: '-1', nextOffset: 'after:2', records: f.records(), upToDate: true },
              { head: endpoint.head, length: endpoint.length }
            );
            const verified = VerifiedLedger.layer.pipe(
              Layer.provide(stores),
              Layer.provide(
                Layer.succeed(LedgerViewSource, { current: () => Effect.succeed(endpoint) })
              )
            );
            // Abort after writing the origin, before deleting the covered suffix.
            const disk = new Database(join(directory, 'feed.sqlite'));
            disk.exec(
              "CREATE TRIGGER crash BEFORE DELETE ON feed_records BEGIN SELECT RAISE(ABORT, 'injected crash'); END"
            );
            const before = yield* Context.get(ctx, LedgerFeedStore).load(100);
            expect(
              Result.isFailure(yield* Effect.result(feed.rebase().pipe(Effect.provide(verified))))
            ).toBe(true);
            expect(yield* Context.get(ctx, LedgerFeedStore).load(100)).toEqual(before);
            expect((yield* Context.get(ctx, LedgerPinStore).read())?.length).toBe(endpoint.length);
            disk.exec('DROP TRIGGER crash');
            disk.close();
            yield* feed.rebase().pipe(Effect.provide(verified)); // returned origin deliberately lost
          })
        )
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(
              LedgerFeed.layer({
                ...options,
                expected: { head: f.view().head, length: f.view().length },
              }).pipe(Layer.provideMerge(stores))
            );
            const feed = Context.get(ctx, LedgerFeed);
            expect((yield* feed.current()).view.head.equals(f.view().head)).toBe(true);
            f.append([5, f.phone.raw]);
            yield* feed.accept(
              {
                requestOffset: 'after:2',
                nextOffset: 'after:3',
                records: f.records().slice(2),
                upToDate: true,
              },
              { head: f.view().head, length: f.view().length }
            );
            expect((yield* feed.current()).view.length).toBe(3);
          })
        )
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rebuilds torn cache bytes from genesis without losing its highest pin, and rejects rollback or fork', async () => {
    for (const damage of ['origin', 'suffix', 'legacy'] as const)
      for (const response of ['valid', 'rollback', 'fork'] as const) {
        const f = envelopeFixture(),
          directory = mkdtempSync(join(tmpdir(), 'feed-rebuild-'));
        const endpoint = { head: f.view().head, length: f.view().length };
        const store = sqliteLedgerFeedStore({
          path: join(directory, 'feed.sqlite'),
          mode: 'create-or-open',
        });
        const stores = Layer.mergeAll(
          store,
          sqliteLedgerPinStore({ path: join(directory, 'pin.sqlite'), mode: 'create-or-open' })
        ).pipe(Layer.provideMerge(Layer.succeed(WorkspaceScope, { genesis: f.context.genesis })));
        const options = {
          origin: { kind: 'genesis' as const, record: f.genesisRecord },
          expected: { head: hashRecordBytes(f.genesisRecord), length: 1 },
          budget: { maxRecords: 100, maxBytes: 1_000_000 },
        };
        try {
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const ctx = yield* Layer.build(
                  LedgerFeed.layer(options).pipe(Layer.provideMerge(stores))
                );
                yield* Context.get(ctx, LedgerFeed).accept(
                  {
                    requestOffset: '-1',
                    nextOffset: 'after:2',
                    records: f.records(),
                    upToDate: true,
                  },
                  endpoint
                );
                yield* Context.get(ctx, LedgerPinStore).write(endpoint);
              })
            )
          );
          const disk = new Database(join(directory, 'feed.sqlite'));
          if (damage === 'origin') disk.exec("UPDATE feed_meta SET origin=X'00'");
          else if (damage === 'suffix')
            disk.exec("UPDATE feed_records SET record=X'00' WHERE position=2");
          else {
            const root = ok(
              decodeRetainedCbor(ok(exportVerifiedState(f.view())).bytes)
            ) as CborValue[];
            root[0] = 4;
            const legacy = ok(encodeRetainedCbor(root.slice(0, 6)));
            disk
              .prepare('UPDATE feed_meta SET origin=?,origin_count=2,bytes=?')
              .run(legacy, legacy.length);
            disk.exec('DELETE FROM feed_records');
          }
          disk.close();
          const originals = f.records();
          if (response === 'fork') {
            const body = [
              hashRecordBytes(f.genesisRecord).toBytes(),
              f.owner.raw,
              [9, [1]],
            ] as CborValue[];
            originals[1] = ok(
              encodeCbor([body, f.owner.signBytes(recordSigningBytes(ok(encodeCbor(body))))])
            );
          }
          const source = Layer.succeed(LedgerFeedSource, {
            readAfter: (offset: string) =>
              Effect.succeed({
                requestOffset: offset,
                nextOffset: 'after:2',
                upToDate: true,
                records: response === 'rollback' ? originals.slice(0, 1) : originals,
              }),
          });
          const result = await Effect.runPromise(
            Effect.scoped(
              Effect.result(
                Layer.build(
                  LedgerFeed.layer({ ...options, expected: endpoint }).pipe(
                    Layer.provide(stores),
                    Layer.provide(source)
                  )
                )
              )
            )
          );
          expect(Result.isSuccess(result), damage + ':' + response).toBe(response === 'valid');
          const pin = await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const ctx = yield* Layer.build(stores);
                return yield* Context.get(ctx, LedgerPinStore).read();
              })
            )
          );
          expect(pin?.length).toBe(endpoint.length);
          expect(pin?.head.equals(endpoint.head)).toBe(true);
          if (response === 'valid')
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function* () {
                  const ctx = yield* Layer.build(
                    LedgerFeed.layer({ ...options, expected: endpoint }).pipe(Layer.provide(stores))
                  );
                  expect(
                    (yield* Context.get(ctx, LedgerFeed).current()).view.head.equals(endpoint.head)
                  ).toBe(true);
                })
              )
            );
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
  });

  it('rebuilds a missing feed cache while retaining and enforcing the independent pin', async () => {
    const f = envelopeFixture(),
      directory = mkdtempSync(join(tmpdir(), 'feed-missing-'));
    const endpoint = { head: f.view().head, length: f.view().length };
    const stores = Layer.mergeAll(
      sqliteLedgerFeedStore({ path: join(directory, 'feed.sqlite'), mode: 'create-or-open' }),
      sqliteLedgerPinStore({ path: join(directory, 'pin.sqlite'), mode: 'create-or-open' })
    ).pipe(Layer.provideMerge(Layer.succeed(WorkspaceScope, { genesis: f.context.genesis })));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(stores);
            const pins = Context.get(ctx, LedgerPinStore);
            yield* pins.write(endpoint);
            const feedCtx = yield* Layer.build(
              LedgerFeed.layer({
                origin: { kind: 'genesis', record: f.genesisRecord },
                expected: { head: hashRecordBytes(f.genesisRecord), length: 1 },
                budget: { maxRecords: 100, maxBytes: 1_000_000 },
              }).pipe(
                Layer.provide(stores),
                Layer.provide(
                  Layer.succeed(LedgerFeedSource, {
                    readAfter: (offset) =>
                      Effect.succeed({
                        requestOffset: offset,
                        nextOffset: 'after:2',
                        upToDate: true,
                        records: f.records(),
                      }),
                  })
                )
              )
            );
            expect(
              (yield* Context.get(feedCtx, LedgerFeed).current()).view.head.equals(endpoint.head)
            ).toBe(true);
            expect((yield* pins.read())?.head.equals(endpoint.head)).toBe(true);
            const lower = yield* Effect.result(
              pins.write({ head: hashRecordBytes(f.genesisRecord), length: 1 })
            );
            expect(Result.isFailure(lower) && lower.failure.reason).toBe('conflict');
            expect((yield* pins.read())?.length).toBe(endpoint.length);
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

  it('proves an earlier pin from retained hashes and refuses corrupt bytes without a recovery source', async () => {
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
        if (corrupt)
          expect(Result.isFailure(result) && 'code' in result.failure && result.failure.code).toBe(
            'retained-cache-invalid'
          );
        else expect(Result.isSuccess(result)).toBe(true);
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
});
