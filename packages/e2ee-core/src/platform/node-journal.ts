import { closeSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Effect, Layer } from 'effect';
import { SqliteTextStore } from '../node-text-store';
import { JournalStore, type JournalTransaction } from '../ports/ledger';
import { StorageError, ValidationError } from '../pure/errors';
import { decodeLedgerJournal, encodeLedgerJournal } from '../pure/journal-codec';
import { storageSync } from './ledger-ports';
export { nodeKeyOutboxLayer } from './node-key-outbox';
export { nodeDeviceIdentityLayer } from './node-device-identity';
export { nodeUserIdentityLayer } from './node-user-identity';

function journalService(database: SqliteTextStore): JournalStore['Type'] {
  return JournalStore.of({
    exclusive: (work) =>
      Effect.acquireUseRelease(
        storageSync(() => database.openExclusive()),
        (lease) =>
          Effect.suspend(() => {
            const tx: JournalTransaction = {
              load: storageSync(() => lease.load()).pipe(
                Effect.flatMap((text) =>
                  text === null
                    ? Effect.succeed(null)
                    : Effect.mapError(
                        decodeLedgerJournal(text),
                        (error) =>
                          new StorageError({
                            reason: error.code === 'unknown-version' ? 'foreign' : 'corrupt',
                            code: error.code,
                            position: error.position,
                          })
                      )
                )
              ),
              save: (journal) => {
                // Capture exact bytes before deferred execution.
                const encoded = encodeLedgerJournal(journal);
                return Effect.flatMap(encoded, (text) => storageSync(() => lease.save(text)));
              },
            };
            return work(tx);
          }),
        // A failed close is a resource-cleanup defect, never transaction success.
        (lease) => Effect.orDie(storageSync(() => lease.close()))
      ),
  });
}

/** Direct Effect resource ownership over synchronous SQLite operations.
 * The application owns the directory. Failed creation may leave a file;
 * it is never silently erased or recreated. */
export function nodeJournalStoreLayer(input: {
  readonly path: string;
  readonly mode: 'create' | 'open';
}) {
  const { path, mode } = input;
  return Layer.effect(
    JournalStore,
    Effect.gen(function* () {
      if (!isAbsolute(path))
        return yield* Effect.fail(new ValidationError({ code: 'invalid-operation' }));
      if (mode === 'create') {
        yield* storageSync(() => closeSync(openSync(path, 'wx', 0o600)));
        const initial = journalService(
          new SqliteTextStore(path, 0x4c454c30, 0, {
            createFile: false,
            initializeSchema: true,
          })
        );
        yield* initial.exclusive((tx) => tx.load);
      }
      const service = journalService(
        new SqliteTextStore(path, 0x4c454c30, 0, {
          createFile: false,
          initializeSchema: false,
        })
      );
      yield* service.exclusive((tx) => tx.load);
      return service;
    })
  );
}
export { nodeEpochFilesLayer } from './node-epoch-files';
export type { EpochFileIO } from './node-epoch-files';
export * as EpochKeyringStorage from '../pure/epoch-keyring';
