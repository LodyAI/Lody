import { randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Identity } from '@loro-dev/roost';
import { Cause, Context, Data, Effect, Exit, Layer, Option, Schema } from 'effect';

type IdentityCode = 'identityMissing' | 'identityInvalid' | 'identityConflict' | 'identityStorage';

export class RoostIdentityError extends Data.TaggedError('RoostIdentityError')<{
  readonly code: IdentityCode;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const hex32 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const decodeIdentity = Schema.decodeUnknownOption(
  Schema.Struct({ version: Schema.Literal(1), seedHex: hex32, ownerHex: hex32 })
);

/** Host-private metadata; never part of a history stream, RPC or export. */
export const roostIdentityDatabasePath = (dbPath: string): string =>
  `${resolve(dbPath)}.identity.sqlite3`;

const invalid = () =>
  new RoostIdentityError({
    code: 'identityInvalid',
    message:
      'Roost writer identity is missing or damaged; restore its application data before writing history',
  });

const storageError = (cause: unknown): RoostIdentityError =>
  cause instanceof RoostIdentityError
    ? cause
    : new RoostIdentityError({
        code: 'identityStorage',
        message: 'Roost writer identity could not be saved or read from application data',
        cause,
      });

const openIdentityDatabase = (filename: string): Database.Database => {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const descriptor = openSync(
    filename,
    constants.O_CREAT |
      constants.O_RDWR |
      (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    0o600
  );
  try {
    // Set permissions before any private material or SQLite journal is written.
    if (process.platform !== 'win32') fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
  return new Database(filename, { timeout: 5_000 });
};

const restoreIdentity = (raw: unknown, initialSeed?: Uint8Array): Uint8Array => {
  const decoded = decodeIdentity(raw);
  // Do not retain Schema issues: their input can contain the signing seed.
  if (Option.isNone(decoded)) throw invalid();
  const seed = Uint8Array.from(Buffer.from(decoded.value.seedHex, 'hex'));
  const ownerHex = Buffer.from(Identity.fromSeed(seed).owner()).toString('hex');
  if (ownerHex !== decoded.value.ownerHex) throw invalid();
  if (initialSeed && !Buffer.from(seed).equals(initialSeed)) {
    throw new RoostIdentityError({
      code: 'identityConflict',
      message:
        'Roost database already has a different writer identity; identity replacement is refused',
    });
  }
  return seed;
};

const readOrCreate = (db: Database.Database, dbPath: string, initialSeed?: Uint8Array) => {
  db.pragma('synchronous = FULL');
  const read = (expected?: Uint8Array) => {
    const rows = db.prepare('SELECT version, seedHex, ownerHex FROM writer_identity').all();
    if (rows.length !== 1) throw invalid();
    return restoreIdentity(rows[0], expected);
  };
  const selected = db
    .transaction(() => {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'writer_identity'")
        .get();
      if (!table) {
        // A missing identity must never silently take over an existing replica.
        // Nightly keyring identities are deliberately not imported.
        if (statSync(dbPath, { throwIfNoEntry: false })) {
          throw new RoostIdentityError({
            code: 'identityMissing',
            message:
              'Existing Roost database has no application-managed writer identity. Restore its identity data or keep the old database and select a fresh LODY_ROOST_DB_PATH; Nightly keyring migration is not supported',
          });
        }
        const existingTables = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
          )
          .all();
        if (existingTables.length > 0) throw invalid();
        const seed = initialSeed ?? randomBytes(32);
        if (seed.length !== 32) throw invalid();
        db.exec(`CREATE TABLE writer_identity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        seedHex TEXT NOT NULL,
        ownerHex TEXT NOT NULL
      )`);
        db.prepare('INSERT INTO writer_identity VALUES (1, 1, ?, ?)').run(
          Buffer.from(seed).toString('hex'),
          Buffer.from(Identity.fromSeed(seed).owner()).toString('hex')
        );
      }
      return read(initialSeed);
    })
    .immediate();
  // Read again after COMMIT; failed reconciliation preserves the saved identity.
  return read(selected);
};

export class RoostWriterIdentity extends Context.Service<
  RoostWriterIdentity,
  {
    readonly loadOrCreate: (
      dbPath: string,
      initialSeed?: Uint8Array
    ) => Effect.Effect<Uint8Array, RoostIdentityError>;
  }
>()('lody/session/RoostWriterIdentity') {}

/** SQLite's immediate transaction serializes initialization across processes. */
export const RoostWriterIdentityLive = Layer.succeed(RoostWriterIdentity, {
  loadOrCreate: Effect.fn('RoostWriterIdentity.loadOrCreate')(
    (dbPath: string, initialSeed?: Uint8Array) =>
      Effect.acquireUseRelease(
        Effect.try({
          try: () => openIdentityDatabase(roostIdentityDatabasePath(dbPath)),
          catch: storageError,
        }),
        (db) =>
          Effect.try({
            try: () => readOrCreate(db, resolve(dbPath), initialSeed),
            catch: storageError,
          }),
        (db) => Effect.try({ try: () => db.close(), catch: storageError }).pipe(Effect.orDie)
      )
  ),
});

/**
 * @deprecated The Promise-based Roost owner calls this until its resource pool
 * receives RoostWriterIdentity through the daemon's Effect runtime.
 */
export async function loadRoostOwnerSeedLegacy(
  dbPath: string,
  initialSeed?: Uint8Array
): Promise<Uint8Array> {
  const exit = await Effect.runPromiseExit(
    Effect.flatMap(RoostWriterIdentity, (identity) =>
      identity.loadOrCreate(dbPath, initialSeed)
    ).pipe(Effect.provide(RoostWriterIdentityLive))
  );
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  return exit.value;
}
