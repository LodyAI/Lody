import { closeSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Effect, Layer } from 'effect';
import { SqliteTextStore } from '../node-text-store';
import { KeyOutbox } from '../ports/key-delivery';
import { StorageError, ValidationError } from '../pure/errors';
import { decodeKeyOutbox, saveOutboxFrame } from '../pure/key-outbox-codec';
import { checkDeliveryId } from '../pure/key-delivery';
import { storageSync } from './ledger-ports';

const readFrames = (text: string | null) =>
  text === null
    ? Effect.succeed(new Map<string, Uint8Array>())
    : Effect.mapError(
        decodeKeyOutbox(text),
        (error) =>
          new StorageError({
            reason: error.code === 'unknown-version' ? 'foreign' : 'corrupt',
            code: error.code,
          })
      );

function outboxService(database: SqliteTextStore): KeyOutbox['Type'] {
  return KeyOutbox.of({
    exclusive: (work) =>
      Effect.acquireUseRelease(
        storageSync(() => database.openExclusive()),
        (lease) =>
          Effect.gen(function* () {
            // Validate persisted data before giving any operation a transaction.
            yield* readFrames(yield* storageSync(() => lease.load()));
            return yield* Effect.suspend(() =>
              work({
                load: (id) =>
                  Effect.gen(function* () {
                    yield* checkDeliveryId(id);
                    const frames = yield* readFrames(yield* storageSync(() => lease.load()));
                    const saved = frames.get(id);
                    return saved === undefined ? null : new Uint8Array(saved);
                  }),
                save: (id, bytes) => {
                  const owned = new Uint8Array(bytes);
                  return Effect.gen(function* () {
                    const text = yield* storageSync(() => lease.load());
                    const next = yield* saveOutboxFrame(text, id, owned);
                    yield* storageSync(() => lease.save(next));
                  });
                },
              })
            );
          }),
        (lease) => Effect.orDie(storageSync(() => lease.close()))
      ),
  });
}

/** Explicit lifecycle; open never creates a missing file or initializes foreign data. */
export function nodeKeyOutboxLayer(input: {
  readonly path: string;
  readonly mode: 'create' | 'open';
}) {
  const { path, mode } = input;
  return Layer.effect(
    KeyOutbox,
    Effect.gen(function* () {
      if (!isAbsolute(path))
        return yield* Effect.fail(new ValidationError({ code: 'invalid-operation' }));
      if (mode === 'create') {
        yield* storageSync(() => closeSync(openSync(path, 'wx', 0o600)));
        const initial = outboxService(
          new SqliteTextStore(path, 0x4c454b30, 0, {
            createFile: false,
            initializeSchema: true,
          })
        );
        yield* initial.exclusive(() => Effect.void);
      }
      const service = outboxService(
        new SqliteTextStore(path, 0x4c454b30, 0, {
          createFile: false,
          initializeSchema: false,
        })
      );
      yield* service.exclusive(() => Effect.void);
      return service;
    })
  );
}
