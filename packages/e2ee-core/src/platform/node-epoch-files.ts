import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Effect, Layer } from 'effect';
import { SqliteTextStore } from '../node-text-store';
import { EpochCandidateStore, EpochKeyring } from '../ports/epoch-rotation';
import { epochKey, type GenesisHash } from '../pure/bytes';
import { copyEpochKeyBytes } from '../pure/epoch-key';
import { decodeEpochCandidate } from '../pure/epoch-candidate';
import { decodeEpochKeyring, installEpochKey } from '../pure/epoch-keyring';
import { StorageError } from '../pure/errors';
import { storageSync } from './ledger-ports';

const io = <A>(work: () => A): Effect.Effect<A, StorageError> =>
  storageSync(work).pipe(
    Effect.mapError((error) =>
      error._tag === 'StorageError'
        ? error
        : new StorageError({ reason: 'corrupt', code: error.code })
    )
  );
const corrupt = () => new StorageError({ reason: 'corrupt' });

/** Trusted platform I/O; tests may inject deterministic failures. Writes must be durable. */
export interface EpochFileIO {
  readonly read: (path: string) => Effect.Effect<string, StorageError>;
  readonly replace: (path: string, text: string) => Effect.Effect<void, StorageError>;
  readonly remove: (path: string) => Effect.Effect<void, StorageError>;
}
const nativeFiles: EpochFileIO = {
  read: (path) => io(() => readFileSync(path, 'utf8')),
  replace: (path, text) => io(() => replaceText(path, text)),
  remove: (path) =>
    io(() => {
      unlinkSync(path);
      syncDirectory(path);
    }),
};

/** Sync file/rename/directory-fsync boundary. Only the uniquely owned temp file is removed. */
function replaceText(path: string, text: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  let renamed = false;
  try {
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    renamed = true;
    syncDirectory(path);
  } finally {
    if (!renamed) unlinkSync(temporary);
  }
}
function syncDirectory(path: string): void {
  const fd = openSync(dirname(path), 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function lock(path: string) {
  // Operational metadata only: never stores keys or substitutes for missing key data.
  const database = new SqliteTextStore(`${path}.lock.sqlite`, 0x4c454b32, 0);
  return <A, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      io(() => database.openExclusive()),
      () => work,
      (lease) => io(() => lease.close()).pipe(Effect.orDie)
    );
}

/** Local/Lab plaintext file compatibility only; NOT OS-protected product key storage.
 * Opens an existing epochs.json. Missing or corrupt key data is never reinitialized.
 * Separate SQLite sidecars provide process-death-safe locks, not a new key format.
 */
export function nodeEpochFilesLayer(input: {
  readonly genesis: GenesisHash;
  readonly candidatePath: string;
  readonly keyringPath: string;
  readonly files?: EpochFileIO;
}) {
  const { genesis, candidatePath, keyringPath } = input;
  const files = input.files ?? nativeFiles;
  const scoped = (actual: GenesisHash) =>
    actual.equals(genesis) ? Effect.void : Effect.fail(new StorageError({ reason: 'foreign' }));
  const candidateLock = lock(candidatePath);
  const keyringLock = lock(keyringPath);
  const readKeys = Effect.suspend(() => files.read(keyringPath));
  const readCandidate = Effect.suspend(() => files.read(candidatePath)).pipe(
    Effect.catchIf(
      (error) => error.reason === 'missing',
      () => Effect.succeed(null)
    )
  );
  const validatePaths = Effect.gen(function* () {
    const paths = [
      candidatePath,
      keyringPath,
      `${candidatePath}.lock.sqlite`,
      `${keyringPath}.lock.sqlite`,
    ].map((path) => resolve(path));
    if (
      !isAbsolute(candidatePath) ||
      !isAbsolute(keyringPath) ||
      new Set(paths).size !== paths.length
    )
      return yield* Effect.fail(new StorageError({ reason: 'foreign' }));
    return undefined;
  });
  return Layer.merge(
    Layer.effect(
      EpochCandidateStore,
      Effect.gen(function* () {
        yield* validatePaths;
        return EpochCandidateStore.of({
          exclusive: (actual, work) =>
            Effect.zipRight(
              scoped(actual),
              candidateLock(
                Effect.suspend(() => {
                  let active = true;
                  const access = <A, E>(operation: Effect.Effect<A, E>) =>
                    Effect.suspend(
                      (): Effect.Effect<A, E | StorageError> =>
                        active ? operation : Effect.fail(new StorageError({ reason: 'closed' }))
                    );
                  return Effect.suspend(() =>
                    work({
                      load: access(readCandidate),
                      save: (text) =>
                        access(
                          Effect.gen(function* () {
                            const decoded = yield* Effect.mapError(
                              decodeEpochCandidate(text),
                              corrupt
                            );
                            if (
                              !genesis
                                .toBytes()
                                .every((byte, index) => byte === decoded.genesis[index])
                            )
                              return yield* Effect.fail(new StorageError({ reason: 'foreign' }));
                            const old = yield* readCandidate;
                            if (old !== null && old !== text)
                              return yield* Effect.fail(new StorageError({ reason: 'exists' }));
                            if (old === null) yield* files.replace(candidatePath, text);
                            return undefined;
                          })
                        ),
                      clear: access(
                        Effect.gen(function* () {
                          if ((yield* readCandidate) !== null) yield* files.remove(candidatePath);
                        })
                      ),
                    })
                  ).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        active = false;
                      })
                    )
                  );
                })
              )
            ),
        });
      })
    ),
    Layer.effect(
      EpochKeyring,
      Effect.gen(function* () {
        yield* validatePaths;
        yield* keyringLock(
          Effect.flatMap(readKeys, (text) => Effect.mapError(decodeEpochKeyring(text), corrupt))
        );
        return EpochKeyring.of({
          get: (actual, epoch) =>
            Effect.zipRight(
              scoped(actual),
              keyringLock(
                Effect.gen(function* () {
                  const keys = yield* Effect.mapError(decodeEpochKeyring(yield* readKeys), corrupt);
                  const key = keys.get(epoch);
                  return key === undefined ? null : yield* Effect.mapError(epochKey(key), corrupt);
                })
              )
            ),
          put: (actual, epoch, key) =>
            Effect.zipRight(
              scoped(actual),
              keyringLock(
                Effect.gen(function* () {
                  const secret = copyEpochKeyBytes(key);
                  return yield* Effect.gen(function* () {
                    const before = yield* readKeys;
                    const after = yield* Effect.mapError(
                      installEpochKey(before, epoch, secret),
                      corrupt
                    );
                    if (after !== before) yield* files.replace(keyringPath, after);
                  }).pipe(Effect.ensuring(Effect.sync(() => secret.fill(0))));
                })
              )
            ),
        });
      })
    )
  );
}
