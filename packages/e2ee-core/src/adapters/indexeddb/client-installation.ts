import { Effect, Layer, Result, Schema } from 'effect';
import {
  ClientInstallationStore,
  CLIENT_KEY_PURPOSES,
  type ClientInstallation,
} from '../../services/client-custody';
import { failure } from './database';
import {
  openClientDatabase,
  BindingSchema,
  attempt,
  bindingRaw,
  publicBinding,
  publicScope,
  sameScope,
  sameBinding,
  equal,
  decode,
  safeInt,
  writeRow,
  CLIENT_TABLES,
} from './client-database';
import type { IndexedDbStoreOptions } from './index';

const Wrapped = Schema.Struct({
  purpose: Schema.Literals(['signing-private-key', 'encryption-private-key', 'device-credential']),
  blob: Schema.Uint8Array,
});
const Installation = Schema.Struct({
  binding: BindingSchema,
  revision: Schema.Int,
  phase: Schema.Literals(['prepared', 'protected', 'ready', 'retired']),
  wrapped: Schema.Array(Wrapped),
});
const Container = Schema.Struct({
  version: Schema.Literal(1),
  current: Schema.NullOr(Installation),
});
const parseContainer = Schema.decodeUnknownSync(Container, { onExcessProperty: 'error' });
const parseArchive = Schema.decodeUnknownSync(Installation, { onExcessProperty: 'error' });
const raw = (row: ClientInstallation): typeof Installation.Type => {
  if (
    !Array.isArray(row.wrapped) ||
    row.wrapped.length > 3 ||
    row.wrapped.some((w) => !(w.blob instanceof Uint8Array) || w.blob.length > 24576)
  )
    throw failure('ClientInstallationStore', 'corrupt');
  return {
    ...row,
    binding: bindingRaw(row.binding),
    wrapped: row.wrapped.map((w) => ({ purpose: w.purpose, blob: new Uint8Array(w.blob) })),
  };
};
const own = (row: typeof Installation.Type): ClientInstallation => ({
  ...row,
  binding: publicBinding(row.binding),
  wrapped: row.wrapped.map((w) => ({ ...w, blob: new Uint8Array(w.blob) })),
});
const complete = (row: typeof Installation.Type) =>
  row.wrapped.length === 3 &&
  CLIENT_KEY_PURPOSES.slice(0, 3).every(
    (p) => row.wrapped.filter((w) => w.purpose === p).length === 1
  );
const valid = (row: typeof Installation.Type) => {
  const b = bindingRaw(publicBinding(row.binding));
  if (
    !equal(b, row.binding) ||
    !safeInt(row.revision) ||
    row.wrapped.length > 3 ||
    new Set(row.wrapped.map((w) => w.purpose)).size !== row.wrapped.length ||
    row.wrapped.some((w) => w.blob.length > 24576) ||
    (row.phase === 'prepared' && row.wrapped.length !== 0) ||
    (['protected', 'ready'].includes(row.phase) && !complete(row))
  )
    throw failure('ClientInstallationStore', 'corrupt');
  return row;
};
/** One stable installation slot and immutable retired archive. No phase grants approval; existing blobs remain verbatim even when they cannot decrypt. */
export const indexedDbClientInstallationStore = (input: IndexedDbStoreOptions) => {
  const options = { ...input };
  return Layer.effect(
    ClientInstallationStore,
    Effect.gen(function* () {
      const db = yield* openClientDatabase(options);
      const parse = (value: unknown) =>
        decode('ClientInstallationStore', () => {
          const r = parseContainer(value);
          if (r.current) {
            valid(r.current);
            if (!sameScope(r.current.binding, db.bound))
              throw failure('ClientInstallationStore', 'corrupt');
          }
          return r;
        });
      const archived = (v: unknown) =>
        decode('ClientInstallationStore', () => {
          const r = valid(parseArchive(v));
          if (r.phase !== 'retired' || !sameScope(r.binding, db.bound))
            throw failure('ClientInstallationStore', 'corrupt');
          return r;
        });
      const scope = Object.freeze(publicScope(db.bound));
      const sameWrapped = (a: typeof Installation.Type, b: typeof Installation.Type) =>
        equal(a.wrapped, b.wrapped);
      const read = (
        tx: Parameters<Parameters<typeof db.run>[3]>[0],
        done: (v: ReturnType<typeof parse>) => void
      ) =>
        tx.request(tx.store('installation').get(0), (v) => {
          const r = parse(v);
          if (r.current !== null) {
            done(r);
            return;
          }
          const tables = CLIENT_TABLES.filter((t) => t !== 'meta' && t !== 'installation');
          const check = (index: number): void => {
            if (index === tables.length) {
              done(r);
              return;
            }
            tx.request(tx.store(tables[index]).count(), (count) => {
              if (count !== 0) throw failure('ClientInstallationStore', 'corrupt');
              check(index + 1);
            });
          };
          check(0);
        });
      return ClientInstallationStore.of({
        scope,
        read: () =>
          db.run('ClientInstallationStore', CLIENT_TABLES, 'readonly', (tx, done) =>
            read(tx, (r) => done(r.current ? own(r.current) : null))
          ),
        readRetired: (binding) =>
          attempt('ClientInstallationStore', () => {
            const b = bindingRaw(binding);
            if (!sameScope(b, db.bound)) throw failure('ClientInstallationStore', 'corrupt');
            return db.run('ClientInstallationStore', ['retired'], 'readonly', (tx, done) =>
              tx.request(tx.store('retired').get(b.installationId), (v) => {
                if (v === undefined) {
                  done(null);
                  return;
                }
                const r = archived(v);
                if (!sameBinding(r.binding, b)) throw failure('ClientInstallationStore', 'corrupt');
                done(own(r));
              })
            );
          }),
        compareAndSet: (expected, next) =>
          attempt('ClientInstallationStore', () => {
            const n = valid(raw(next));
            if (!sameScope(n.binding, db.bound) || (expected !== null && !safeInt(expected)))
              throw failure('ClientInstallationStore', 'corrupt');
            return db.run<void>('ClientInstallationStore', CLIENT_TABLES, 'readwrite', (tx, done) =>
              read(tx, (r) => {
                const current = r.current;
                if (current === null) {
                  if (
                    expected !== null ||
                    n.revision !== 0 ||
                    n.phase !== 'prepared' ||
                    n.wrapped.length
                  )
                    throw failure('ClientInstallationStore', 'conflict');
                } else {
                  if (
                    expected === null ||
                    current.revision !== expected ||
                    n.revision !== expected + 1 ||
                    !sameBinding(current.binding, n.binding) ||
                    current.phase === 'retired'
                  )
                    throw failure('ClientInstallationStore', 'conflict');
                  const allowed =
                    n.phase === 'retired' ||
                    (current.phase === 'prepared' && n.phase === 'protected') ||
                    (current.phase === 'protected' && n.phase === 'ready');
                  if (
                    !allowed ||
                    ((current.phase !== 'prepared' || n.phase === 'retired') &&
                      !sameWrapped(current, n)) ||
                    (n.phase === 'protected' &&
                      (!complete(n) ||
                        n.wrapped.some((w) => w.blob.length < 29 || w.blob[0] !== 1)))
                  )
                    throw failure('ClientInstallationStore', 'conflict');
                }
                writeRow(tx, 'installation', 0, { version: 1 as const, current: n }, parse, () =>
                  done(undefined)
                );
              })
            );
          }),
        replace: (expected, next) =>
          attempt('ClientInstallationStore', () => {
            const n = valid(raw(next)),
              b = bindingRaw(expected.binding);
            if (!sameScope(b, db.bound) || !sameScope(n.binding, db.bound))
              throw failure('ClientInstallationStore', 'corrupt');
            return db.run<void>('ClientInstallationStore', CLIENT_TABLES, 'readwrite', (tx, done) =>
              read(tx, (r) => {
                tx.request(tx.store('retired').get(b.installationId), (prior) => {
                  if (prior !== undefined && r.current && equal(r.current, n)) {
                    const old = archived(prior);
                    const plan = ClientInstallationStore.prepareReplacement(
                      own(old),
                      expected,
                      own(n)
                    );
                    if (Result.isSuccess(plan) && equal(raw(plan.success.retired), old)) {
                      done(undefined);
                      return;
                    }
                    throw failure('ClientInstallationStore', 'conflict');
                  }
                  const plan = ClientInstallationStore.prepareReplacement(
                    r.current ? own(r.current) : null,
                    expected,
                    own(n)
                  );
                  if (Result.isFailure(plan)) throw plan.failure;
                  const old = raw(plan.success.retired);
                  if (prior !== undefined) throw failure('ClientInstallationStore', 'conflict');
                  const cursor = tx.store('retired').openCursor();
                  tx.request(cursor, (item) => {
                    if (item) {
                      const v = archived(item.value);
                      if (
                        v.binding.device === n.binding.device ||
                        v.binding.installationId === n.binding.installationId
                      )
                        throw failure('ClientInstallationStore', 'conflict');
                      item.continue();
                      return;
                    }
                    writeRow(tx, 'retired', old.binding.installationId, old, archived, () =>
                      writeRow(
                        tx,
                        'installation',
                        0,
                        { version: 1 as const, current: n },
                        parse,
                        () => done(undefined)
                      )
                    );
                  });
                });
              })
            );
          }),
      });
    })
  );
};
