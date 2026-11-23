import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Context, Effect, Exit, Layer, Tracer, type Scope } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { VerifiedLedger } from '@lody/e2ee-core';
import { LedgerViewSource, LedgerViewSourceError, WorkspaceScope } from '@lody/e2ee-core/services';
import { sqliteLedgerPinStore } from '@lody/e2ee-core/adapters/node-sqlite';
import { envelopeFixture } from '../keys/fixture';

const dirs: string[] = [];
const pinFile = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2ee-pin-'));
  dirs.push(dir);
  return path.join(dir, 'ledger-pin.sqlite');
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit)
    ? (exit.cause.reasons[0] as { error?: { reason?: string } })?.error?.reason
    : 'success';

/** A fresh in-process guard over the durable pin at `file`, as after a restart. */
const open = (
  f: ReturnType<typeof envelopeFixture>,
  file: string,
  current: LedgerViewSource['Service']['current']
): Effect.Effect<VerifiedLedger['Service'], unknown, Scope.Scope> =>
  Effect.map(
    Layer.build(
      VerifiedLedger.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(LedgerViewSource, LedgerViewSource.of({ current })),
            sqliteLedgerPinStore({ path: file, mode: 'create-or-open' })
          )
        ),
        Layer.provide(Layer.succeed(WorkspaceScope, { genesis: f.context.genesis }))
      )
    ),
    (context) => Context.get(context, VerifiedLedger)
  );
const pin = (file: string) => {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare('SELECT genesis,count FROM ledger_pin WHERE id=1').get();
  } finally {
    db.close();
  }
};

describe('VerifiedLedger rollback guard over a durable pin', () => {
  it('pins the newest genuine view and refuses older views in-process and after restart', async () => {
    const f = envelopeFixture(),
      file = pinFile(),
      old = f.view();
    f.append([5, f.owner.raw]);
    const high = f.view();
    let current = old;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* open(f, file, () => Effect.succeed(current));
          expect((yield* ledger.current()).length).toBe(2);
          current = high;
          expect((yield* ledger.current()).length).toBe(3);
          current = old;
          expect(failure(yield* Effect.exit(ledger.current()))).toBe('rollback');
          expect(failure(yield* Effect.exit(ledger.ensureCurrent(old)))).toBe('rollback');
        })
      )
    );
    expect(pin(file)).toEqual({ genesis: hex(f.context.genesis.toBytes()), count: 3 });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const restarted = yield* open(f, file, () => Effect.succeed(current));
          expect(failure(yield* Effect.exit(restarted.current()))).toBe('rollback');
          current = high;
          expect((yield* restarted.current()).length).toBe(3);
        })
      )
    );
  });

  it('refuses a view of another workspace and a fork of the pinned checkpoint', async () => {
    const f = envelopeFixture(),
      other = envelopeFixture(0, 101),
      file = pinFile();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* open(f, file, () => Effect.sync(other.view));
          expect(failure(yield* Effect.exit(ledger.current()))).toBe('rollback');
        })
      )
    );
    const fork = envelopeFixture();
    f.append([5, f.owner.raw]);
    fork.append([5, fork.phone.raw]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(
          open(f, file, () => Effect.sync(f.view)),
          (ledger) => ledger.current()
        )
      )
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* open(f, file, () => Effect.sync(fork.view));
          expect(failure(yield* Effect.exit(ledger.current()))).toBe('rollback');
        })
      )
    );
  });

  it.each(['abort', 'ignore', 'rewrite-head', 'rewrite-genesis'] as const)(
    'a %s pin-write fault fails the read, keeps the durable pin and still remembers the newer view',
    async (fault) => {
      const f = envelopeFixture(),
        file = pinFile(),
        old = f.view();
      let current = old;
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ledger = yield* open(f, file, () => Effect.succeed(current));
            yield* ledger.current();
            const db = new Database(file);
            try {
              db.exec(
                fault === 'abort' || fault === 'ignore'
                  ? `CREATE TRIGGER fail_pin BEFORE UPDATE ON ledger_pin BEGIN SELECT RAISE(${fault === 'abort' ? "ABORT,'fault'" : 'IGNORE'}); END`
                  : `CREATE TRIGGER fail_pin AFTER UPDATE ON ledger_pin BEGIN UPDATE ledger_pin SET ${fault === 'rewrite-head' ? `head=x'${hex(old.head.toBytes())}',count=2` : `genesis='${'00'.repeat(32)}'`} WHERE id=1; END`
              );
              f.append([5, f.owner.raw]);
              const high = f.view();
              current = high;
              const read = yield* Effect.exit(ledger.current());
              expect(failure(read)).toBe(fault === 'abort' ? 'storage' : 'corrupt');
              expect(db.prepare('SELECT genesis,count FROM ledger_pin WHERE id=1').get()).toEqual({
                genesis: hex(f.context.genesis.toBytes()),
                count: 2,
              });
              db.exec('DROP TRIGGER fail_pin');
              // The genuine newer view was observed even though persisting it failed.
              current = old;
              expect(failure(yield* Effect.exit(ledger.current()))).toBe('rollback');
              current = high;
              expect((yield* ledger.current()).length).toBe(3);
              expect(db.prepare('SELECT count FROM ledger_pin WHERE id=1').get()).toEqual({
                count: 3,
              });
            } finally {
              db.close();
            }
          })
        )
      );
    }
  );

  it('preserves the pin on a typed source failure and exposes completed workflow spans', async () => {
    const f = envelopeFixture(),
      file = pinFile();
    const cause = new Error('synthetic source unavailable');
    const sourceError = new LedgerViewSourceError({ cause });
    let unavailable = false;
    const spans: Tracer.Span[] = [];
    const tracer = Tracer.make({
      span(options) {
        const span = Tracer.nativeTracer.span(options);
        spans.push(span);
        return span;
      },
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* open(f, file, () =>
            unavailable ? Effect.fail(sourceError) : Effect.sync(f.view)
          );
          const view = yield* ledger.current();
          const before = pin(file);
          unavailable = true;
          const result = yield* Effect.exit(ledger.current());
          expect(failure(result)).toBe('source');
          if (Exit.isFailure(result)) {
            expect(result.cause.reasons).toEqual([
              expect.objectContaining({
                _tag: 'Fail',
                error: expect.objectContaining({ cause: sourceError }),
              }),
            ]);
          }
          expect(pin(file)).toEqual(before);
          yield* ledger.ensureCurrent(view);
          unavailable = false;
          expect((yield* ledger.current()).head).toEqual(view.head);
        })
      ).pipe(Effect.provideService(Tracer.Tracer, tracer))
    );
    const current = spans.filter((span) => span.name === '@lody/e2ee-core/VerifiedLedger.current');
    expect(
      current.map((span) => (span.status._tag === 'Ended' ? span.status.exit._tag : 'Started'))
    ).toEqual(['Success', 'Failure', 'Success']);
    expect(
      spans.find((span) => span.name === '@lody/e2ee-core/VerifiedLedger.ensureCurrent')?.status
    ).toMatchObject({ _tag: 'Ended', exit: { _tag: 'Success' } });
  });

  it('does not rewrite an unchanged pin on repeated reads', async () => {
    const f = envelopeFixture(),
      file = pinFile();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* open(f, file, () => Effect.sync(f.view));
          yield* ledger.current();
          const db = new Database(file);
          try {
            db.exec(
              "CREATE TRIGGER no_write BEFORE UPDATE ON ledger_pin BEGIN SELECT RAISE(ABORT,'unexpected write'); END"
            );
            expect((yield* ledger.current()).length).toBe(2);
            expect((yield* ledger.current()).length).toBe(2);
          } finally {
            db.close();
          }
        })
      )
    );
  });
});
