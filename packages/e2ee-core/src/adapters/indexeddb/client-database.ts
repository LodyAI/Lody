import { Effect, Result, Schema } from 'effect';
import * as Bytes from '../../internal/foundation/bytes';
import { keyId } from '../../internal/foundation/identifiers';
import { bytesEqual } from '../../internal/foundation/cbor';
import type { ClientCustodyBinding, ClientCustodyScope } from '../../services/client-custody';
import { WorkspaceScope } from '../../services/workspace';
import { LocalStoreError } from '../../services/errors';
import { DatabaseOwner, failure, type Transaction } from './database';
import type { IndexedDbStoreOptions } from './index';

export const CLIENT_TABLES = [
  'meta',
  'installation',
  'retired',
  'keys',
  'markers',
  'nonces',
  'data',
  'snapshots',
] as const;
export const safeInt = (n: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(n) && n >= min && n <= max;
export const boundedBytes = (v: unknown, max: number, min = 1): v is Uint8Array =>
  v instanceof Uint8Array && v.length >= min && v.length <= max;
export const scopeRaw = (scope: ClientCustodyScope) => {
  if (
    [scope.accountId, scope.workspaceId].some(
      (x) => typeof x !== 'string' || !x.length || x.length > 1024
    )
  )
    throw failure('ClientStores', 'corrupt');
  return {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    genesis: keyId(Result.getOrThrow(Bytes.genesisHash(scope.genesis.toBytes())).toBytes()),
  };
};
export type RawScope = ReturnType<typeof scopeRaw>;
export const bindingRaw = (binding: ClientCustodyBinding) => {
  if (!/^[0-9a-f]{64}$/.test(binding.installationId)) throw failure('ClientStores', 'corrupt');
  return {
    ...scopeRaw(binding),
    device: keyId(Result.getOrThrow(Bytes.signingPublicKey(binding.device.toBytes())).toBytes()),
    installationId: binding.installationId,
  };
};
export type RawBinding = ReturnType<typeof bindingRaw>;
export const BindingSchema = Schema.Struct({
  accountId: Schema.String,
  workspaceId: Schema.String,
  genesis: Schema.String,
  device: Schema.String,
  installationId: Schema.String,
});
export const publicScope = (raw: RawScope): ClientCustodyScope => ({
  ...raw,
  genesis: Result.getOrThrow(
    Bytes.genesisHash(Uint8Array.from(raw.genesis.match(/../g)!, (h) => parseInt(h, 16)))
  ),
});
export const publicBinding = (raw: RawBinding): ClientCustodyBinding => ({
  ...raw,
  genesis: Result.getOrThrow(
    Bytes.genesisHash(Uint8Array.from(raw.genesis.match(/../g)!, (h) => parseInt(h, 16)))
  ),
  device: Result.getOrThrow(
    Bytes.signingPublicKey(Uint8Array.from(raw.device.match(/../g)!, (h) => parseInt(h, 16)))
  ),
});
export const sameScope = (a: RawScope, b: RawScope) =>
  a.accountId === b.accountId && a.workspaceId === b.workspaceId && a.genesis === b.genesis;
export const sameBinding = (a: RawBinding, b: RawBinding) =>
  sameScope(a, b) && a.device === b.device && a.installationId === b.installationId;
export const bindingId = (b: RawBinding) => JSON.stringify([b.device, b.installationId]);
export function decode<A>(name: string, work: () => A): A {
  try {
    return work();
  } catch (cause) {
    throw cause instanceof LocalStoreError ? cause : failure(name, 'corrupt');
  }
}
export const attempt = <A, E, R>(
  name: string,
  body: () => Effect.Effect<A, E, R>
): Effect.Effect<A, E | LocalStoreError, R> =>
  Effect.suspend((): Effect.Effect<A, E | LocalStoreError, R> => {
    try {
      return body();
    } catch (cause) {
      return Effect.fail(cause instanceof LocalStoreError ? cause : failure(name, 'corrupt'));
    }
  });
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Uint8Array) return b instanceof Uint8Array && bytesEqual(a, b);
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aa = Object.keys(a),
    bb = Object.keys(b);
  return (
    aa.length === bb.length &&
    aa.every(
      (k) =>
        Object.hasOwn(b, k) &&
        equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    )
  );
}
export function writeRow<A>(
  tx: Transaction,
  table: string,
  key: IDBValidKey,
  value: A,
  parse: (v: unknown) => A,
  done: (v: A) => void
) {
  tx.request(tx.store(table).put(value, key), () =>
    tx.request(tx.store(table).get(key), (stored) => {
      const actual = parse(stored);
      if (!equal(actual, value)) throw failure(table, 'corrupt');
      done(actual);
    })
  );
}
export const openClientDatabase = (options: IndexedDbStoreOptions) =>
  Effect.gen(function* () {
    const genesis = (yield* WorkspaceScope).genesis;
    const bound = yield* Effect.try({
      try: () => scopeRaw({ ...options, genesis }),
      catch: () => failure('ClientStores', 'corrupt'),
    });
    if (
      typeof options.databaseName !== 'string' ||
      !options.databaseName.length ||
      options.databaseName.length > 1024 ||
      !['open-existing', 'create-or-open'].includes(options.mode)
    )
      return yield* failure('ClientStores', 'corrupt');
    const owner = new DatabaseOwner(bound, options.databaseName, options.mode, {
      tables: CLIENT_TABLES,
      initialize: (tx) => {
        tx.objectStore('installation').put({ version: 1, current: null }, 0);
        tx.objectStore('meta').put({ version: 1, writable: false }, 'writable-probe');
        const data = tx.objectStore('data');
        data.createIndex('phase', ['owner', 'namespace', 'phase', 'id']);
        data.createIndex('unconsumed', ['owner', 'namespace', 'consumed', 'id']);
        data.createIndex(
          'distribution-slot',
          ['owner', 'namespace', 'value.epoch', 'value.recipient', 'value.revision'],
          { unique: true }
        );
      },
    });
    yield* Effect.addFinalizer(() => owner.close);
    yield* owner.open;
    const Meta = Schema.Struct({
      version: Schema.Literal(1),
      accountId: Schema.String,
      workspaceId: Schema.String,
      genesis: Schema.String,
    });
    const parseMeta = Schema.decodeUnknownSync(Meta, { onExcessProperty: 'error' });
    const check = (value: unknown) =>
      decode('ClientStores', () => {
        if (!sameScope(parseMeta(value), bound)) throw failure('ClientStores', 'corrupt');
      });
    const run = <A>(
      name: string,
      tables: readonly string[],
      mode: IDBTransactionMode,
      work: (tx: Transaction, done: (value: A) => void) => void
    ) => owner.run(name, tables, mode, check, work);
    yield* run<void>('ClientStores', ['data'], 'readonly', (tx, done) => {
      const data = tx.store('data');
      const indexes: readonly (readonly [string, readonly string[], boolean])[] = [
        ['phase', ['owner', 'namespace', 'phase', 'id'], false],
        ['unconsumed', ['owner', 'namespace', 'consumed', 'id'], false],
        [
          'distribution-slot',
          ['owner', 'namespace', 'value.epoch', 'value.recipient', 'value.revision'],
          true,
        ],
      ];
      if (data.indexNames.length !== indexes.length) throw failure('ClientStores', 'corrupt');
      for (const [name, path, unique] of indexes) {
        if (!data.indexNames.contains(name)) throw failure('ClientStores', 'corrupt');
        const index = data.index(name);
        if (!equal(index.keyPath, path) || index.unique !== unique)
          throw failure('ClientStores', 'corrupt');
      }
      tx.request(tx.store('meta').get('writable-probe'), (v) => {
        if (!equal(v, { version: 1, writable: false })) throw failure('ClientStores', 'corrupt');
        done(undefined);
      });
    });
    return { run, bound, close: () => owner.close };
  });
export type ClientDatabase = Effect.Success<ReturnType<typeof openClientDatabase>>;

/** Prove an observable write/readback/restore in one transaction; never replace a key or mutate committed identity. */
export const assertClientWritable = (db: ClientDatabase) =>
  db.run<void>('ClientKeyCustody', ['meta'], 'readwrite', (tx, done) => {
    const reset = { version: 1, writable: false };
    tx.request(tx.store('meta').get('writable-probe'), (before) => {
      if (!equal(before, reset)) throw failure('ClientKeyCustody', 'corrupt');
      writeRow(
        tx,
        'meta',
        'writable-probe',
        { version: 1, writable: true },
        (v) => v,
        () =>
          writeRow(
            tx,
            'meta',
            'writable-probe',
            reset,
            (v) => v,
            () => done(undefined)
          )
      );
    });
  });
