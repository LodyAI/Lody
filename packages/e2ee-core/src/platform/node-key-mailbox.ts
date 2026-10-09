import { closeSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Effect, Layer } from 'effect';
import { SqliteTextStore } from '../node-text-store';
import {
  DistributionStore,
  EpochMailboxIndexStore,
  type AtomicDocumentStore,
} from '../ports/key-mailbox';
import { StorageError, ValidationError } from '../pure/errors';
import {
  emptyDistribution,
  decodeDocument,
  encodeDocument,
  validateDistribution,
  validateMailbox,
} from '../pure/key-distribution';
import { emptyMailbox } from '../pure/key-mailbox';
import { storageSync } from './ledger-ports';

/** One SQLite commit contains state and unconsumed results, or ciphertext and its index.
 * Keyring is a separate store: receive journal ordering handles that crash window. */
export function sqliteDocumentService<A>(
  database: SqliteTextStore,
  initial: () => A,
  validate: (x: unknown) => x is A
): AtomicDocumentStore<A> {
  const decode = (text: string | null) =>
    text === null
      ? Effect.succeed(initial())
      : Effect.fromResult(decodeDocument(text, validate)).pipe(
          Effect.mapError(() => new StorageError({ reason: 'corrupt' }))
        );
  return {
    exclusive: (work) =>
      Effect.acquireUseRelease(
        storageSync(() => database.openExclusive()),
        (lease) =>
          Effect.gen(function* () {
            yield* decode(yield* storageSync(() => lease.load()));
            return yield* work({
              load: storageSync(() => lease.load()).pipe(Effect.flatMap(decode)),
              save: (value) =>
                Effect.fromResult(encodeDocument(value, validate)).pipe(
                  Effect.flatMap((text) => storageSync(() => lease.save(text)))
                ),
            });
          }),
        (lease) => Effect.orDie(storageSync(() => lease.close()))
      ),
  };
}
function openStore<A>(
  input: { readonly path: string; readonly mode: 'create' | 'open' },
  appId: number,
  initial: () => A,
  validate: (x: unknown) => x is A
) {
  return Effect.gen(function* () {
    if (!isAbsolute(input.path))
      return yield* Effect.fail(new ValidationError({ code: 'invalid-operation' }));
    if (input.mode === 'create') {
      yield* storageSync(() => closeSync(openSync(input.path, 'wx', 0o600)));
      const created = sqliteDocumentService(
        new SqliteTextStore(input.path, appId, 1, { createFile: false, initializeSchema: true }),
        initial,
        validate
      );
      yield* created.exclusive((tx) => tx.save(initial()));
    }
    const opened = sqliteDocumentService(
      new SqliteTextStore(input.path, appId, 1, { createFile: false, initializeSchema: false }),
      initial,
      validate
    );
    yield* opened.exclusive((tx) => tx.load);
    return opened;
  });
}
export const nodeDistributionStoreLayer = (input: {
  readonly path: string;
  readonly mode: 'create' | 'open';
}) =>
  Layer.effect(
    DistributionStore,
    openStore(input, 0x4c454431, emptyDistribution, validateDistribution)
  );
export const nodeMailboxIndexStoreLayer = (input: {
  readonly path: string;
  readonly mode: 'create' | 'open';
}) =>
  Layer.effect(EpochMailboxIndexStore, openStore(input, 0x4c454d31, emptyMailbox, validateMailbox));
