import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Data, Effect, Result, type Scope } from 'effect';
import { z } from 'zod';
import {
  LocalE2eePrepareRequestSchema,
  LocalE2eePrepareResponseSchema,
} from '@lody/shared/e2ee-local-pairing';
import {
  Bytes,
  decodeRecord,
  hashRecordBytes,
  prepareDeviceAdmission,
  signDeviceCredentialBinding,
  verifyDeviceCredentialBinding,
  possessionSigningBytes,
  verifySignature,
  verifyLedgerEffect,
  type LedgerView,
} from '@lody/e2ee-core/protocol';
import type { NodeE2eeCustody } from '@lody/e2ee-core/adapters/node-custody';

export class MachinePairingJournalError extends Data.TaggedError('MachinePairingJournalError')<{
  code:
    | 'busy'
    | 'conflict'
    | 'corrupt'
    | 'invalid-input'
    | 'not-admitted'
    | 'storage'
    | 'superseded';
  cause?: unknown;
}> {}
const failure = (code: MachinePairingJournalError['code'], cause?: unknown) =>
  new MachinePairingJournalError({ code, ...(cause === undefined ? {} : { cause }) });
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const raw = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
// Existing INTEGER state; no schema/version migration or original-byte mutation.
const SUPERSEDED_GENERATION = -1;
const ContextSchema = LocalE2eePrepareRequestSchema.omit({ type: true });
export type MachinePairingContext = z.infer<typeof ContextSchema>;
const MaterialSchema = LocalE2eePrepareResponseSchema.omit({
  ok: true,
  type: true,
  machineId: true,
});
export type MachinePairingMaterial = z.infer<typeof MaterialSchema>;
const sql = <A>(work: () => A) =>
  Effect.try({
    try: work,
    catch: (cause) =>
      cause instanceof MachinePairingJournalError ? cause : failure('storage', cause),
  });
const io = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) =>
      cause instanceof MachinePairingJournalError ? cause : failure('storage', cause),
  });
type Row = {
  context: string;
  material: string | null;
  admission: Uint8Array | null;
  creating: number;
};

async function openOwned(path: string) {
  try {
    const file = await open(path, 'wx', 0o600);
    await file.close();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
      throw failure('corrupt');
  } finally {
    await file.close();
  }
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=0');
  } catch (cause) {
    db.close();
    throw cause;
  }
  return db;
}

/** Per-workspace native journal; its separate SQLite mutex protects signing and
 * durable readback, never network I/O. No local operation retires an emitted proof. */
export const openMachinePairingJournal = Effect.fnUntraced(function* (directory: string) {
  const mutex = yield* Effect.acquireRelease(
    io(() => openOwned(join(directory, 'pairing-mutex.sqlite'))),
    (connection) => Effect.sync(() => connection.close())
  );
  yield* Effect.acquireRelease(
    sql(() => {
      try {
        mutex.exec('BEGIN EXCLUSIVE');
      } catch (cause) {
        throw failure('busy', cause);
      }
    }),
    () => sql(() => mutex.exec('ROLLBACK')).pipe(Effect.orDie)
  );
  const db = yield* Effect.acquireRelease(
    io(() => openOwned(join(directory, 'pairings.sqlite'))),
    (connection) => Effect.sync(() => connection.close())
  );
  yield* sql(() => {
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    const id = db.prepare('PRAGMA application_id').get()?.application_id;
    if (version === 0 && id === 0) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get())
        throw failure('corrupt');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(
          'CREATE TABLE pairings(session TEXT PRIMARY KEY,context TEXT NOT NULL,material TEXT,admission BLOB,creating INTEGER NOT NULL DEFAULT 0); CREATE TABLE current_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),session TEXT NOT NULL); PRAGMA user_version=3; PRAGMA application_id=1279602762'
        );
        db.exec('COMMIT');
      } catch (cause) {
        db.exec('ROLLBACK');
        throw cause;
      }
    } else if (version !== 3 || id !== 1279602762) throw failure('corrupt');
  });
  const read = (session: string) =>
    db
      .prepare('SELECT context,material,admission,creating FROM pairings WHERE session=?')
      .get(session) as Row | undefined;
  const context = (input: MachinePairingContext) => {
    const parsed = ContextSchema.safeParse(input);
    if (!parsed.success) throw failure('invalid-input');
    return parsed.data;
  };
  const load = (input: MachinePairingContext) => {
    const expected = context(input),
      row = read(expected.pairingSessionId);
    if (!row || row.context !== JSON.stringify(expected) || !row.material)
      throw failure('conflict');
    const parsed = MaterialSchema.safeParse(JSON.parse(row.material));
    if (!parsed.success || parsed.data.pairingSessionId !== expected.pairingSessionId)
      throw failure('corrupt');
    return { expected, row, material: parsed.data };
  };
  const verifyMaterial = (expected: MachinePairingContext, material: MachinePairingMaterial) => {
    const genesis = Result.getOrThrow(Bytes.genesisHash(raw(expected.genesisHash)));
    const signingPublicKey = Result.getOrThrow(
      Bytes.signingPublicKey(raw(material.signingPublicKey))
    );
    const bound = verifyDeviceCredentialBinding(
      {
        genesis,
        pairingSessionId: raw(expected.pairingSessionId),
        signingPublicKey,
        credentialHash: raw(material.credentialHash),
      },
      raw(material.bindingSignature)
    );
    const possession = Result.getOrThrow(
      possessionSigningBytes({
        genesis,
        targetMembershipId: Result.getOrThrow(Bytes.membershipId(raw(expected.membershipId))),
        signingPublicKey,
        encryptionPublicKey: Result.getOrThrow(
          Bytes.encryptionPublicKey(raw(material.encryptionPublicKey))
        ),
        kind: 'machine',
      })
    );
    if (
      Result.isFailure(bound) ||
      Result.isFailure(
        verifySignature(signingPublicKey.toBytes(), possession, raw(material.possessionSignature))
      )
    )
      throw failure('corrupt');
  };
  return {
    prepare: Effect.fnUntraced(function* (
      input: MachinePairingContext,
      acquireCustody: Effect.Effect<NodeE2eeCustody, unknown, Scope.Scope>
    ) {
      const expected = yield* sql(() => context(input));
      const original = yield* sql(() => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const old = read(expected.pairingSessionId);
          if (old && old.context !== JSON.stringify(expected)) throw failure('conflict');
          if (old?.creating === SUPERSEDED_GENERATION) throw failure('superseded');
          const pending = db
            .prepare(
              'SELECT session,context FROM pairings WHERE creating=1 AND material IS NULL LIMIT 1'
            )
            .get() as { session: string; context: string } | undefined;
          const takeover = pending !== undefined && pending.session !== expected.pairingSessionId;
          if (takeover) {
            if (old && old.material !== null) throw failure('conflict');
            const prior = ContextSchema.safeParse(JSON.parse(pending.context));
            if (!prior.success) throw failure('corrupt');
            if (
              (
                [
                  'accountId',
                  'workspaceId',
                  'machineId',
                  'genesisHash',
                  'genesisRecordHex',
                  'membershipId',
                ] as const
              ).some((key) => prior.data[key] !== expected[key])
            )
              throw failure('conflict');
          }
          const retained = db
            .prepare(
              'SELECT p.material FROM current_identity c JOIN pairings p ON p.session=c.session WHERE c.singleton=1'
            )
            .get();
          const published = db
            .prepare('SELECT 1 FROM pairings WHERE material IS NOT NULL LIMIT 1')
            .get();
          if ((published && !retained) || (retained && typeof retained.material !== 'string'))
            throw failure('corrupt');
          db.prepare('INSERT OR IGNORE INTO pairings(session,context) VALUES(?,?)').run(
            expected.pairingSessionId,
            JSON.stringify(expected)
          );
          if (takeover) {
            // The mutex excludes other owners. Atomically fence the old attempt
            // before this session resumes the same idempotent custody originals.
            db.prepare(
              'UPDATE pairings SET creating=? WHERE session=? AND creating=1 AND material IS NULL'
            ).run(SUPERSEDED_GENERATION, pending.session);
            db.prepare('UPDATE pairings SET creating=1 WHERE session=? AND material IS NULL').run(
              expected.pairingSessionId
            );
            if (
              read(pending.session)?.creating !== SUPERSEDED_GENERATION ||
              read(expected.pairingSessionId)?.creating !== 1
            )
              throw failure('corrupt');
          }
          db.exec('COMMIT');
          return {
            retained,
            sameSession: old?.material !== null && old?.material !== undefined,
            creating: takeover || (old?.creating === 1 && old.material === null),
          };
        } catch (cause) {
          try {
            db.exec('ROLLBACK');
          } catch (cleanup) {
            throw failure(
              'storage',
              new AggregateError([cause, cleanup], 'pairing takeover and rollback failed')
            );
          }
          throw cause;
        }
      });
      const genesis = Result.getOrThrow(Bytes.genesisHash(raw(expected.genesisHash)));
      let missing = false;
      if (original.retained || original.creating) {
        const found = yield* Effect.result(
          io(async () => {
            const file = await open(
              join(directory, 'custody', `${expected.genesisHash}.machine.device`),
              constants.O_RDONLY | constants.O_NOFOLLOW
            );
            await file.close();
          })
        );
        if (Result.isFailure(found)) {
          const cause = found.failure.cause as NodeJS.ErrnoException | undefined;
          if (cause?.code !== 'ENOENT' || original.sameSession) return yield* found.failure;
          missing = true;
        }
      }
      if (missing) {
        // A surviving credential belongs to the missing identity. Never generate
        // a replacement device that cannot reopen that credential's AAD.
        const credential = yield* Effect.result(
          io(async () => {
            const file = await open(
              join(directory, 'custody', `device-credential-${expected.genesisHash}.sealed`),
              constants.O_RDONLY | constants.O_NOFOLLOW
            );
            await file.close();
          })
        );
        if (Result.isSuccess(credential)) return yield* failure('conflict');
        if ((credential.failure.cause as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT')
          return yield* credential.failure;
      }
      const reopen = Boolean(original.retained && !missing && !original.creating);
      if (!reopen) {
        // Persist generation ownership BEFORE custody can publish any replacement
        // original. Retrying this session uses core's idempotent creation, even
        // if the device/credential was retained before material publication failed.
        yield* sql(() => {
          const pending = db
            .prepare('SELECT session FROM pairings WHERE creating=1 AND material IS NULL LIMIT 1')
            .get();
          if (
            read(expected.pairingSessionId)?.creating === SUPERSEDED_GENERATION ||
            (pending && pending.session !== expected.pairingSessionId)
          )
            throw failure('conflict');
          db.prepare('UPDATE pairings SET creating=1 WHERE session=? AND material IS NULL').run(
            expected.pairingSessionId
          );
          const actual = read(expected.pairingSessionId);
          if (!actual || actual.creating !== 1 || actual.context !== JSON.stringify(expected))
            throw failure('corrupt');
        });
      }
      const custody = yield* acquireCustody;
      const device = yield* reopen ? custody.openDevice(genesis) : custody.createDevice(genesis);
      const credential = yield* reopen
        ? custody.deviceCredential(genesis, device.publicKey).pipe(
            Effect.map((value) => ({
              credentialHash: createHash('sha256').update(raw(value)).digest('hex'),
            }))
          )
        : custody.prepareDeviceCredential(genesis, device.publicKey);
      if (reopen) {
        const prior = yield* sql(() =>
          MaterialSchema.parse(JSON.parse(String(original.retained?.material)))
        );
        if (
          prior.signingPublicKey !== hex(device.publicKey.toBytes()) ||
          prior.encryptionPublicKey !== hex(device.enc.toBytes()) ||
          prior.credentialHash !== credential.credentialHash
        )
          return yield* failure('corrupt');
      }
      const existing = yield* sql(() => read(expected.pairingSessionId));
      if (!existing?.material) {
        const admission = yield* prepareDeviceAdmission({
          genesis,
          membershipId: Result.getOrThrow(Bytes.membershipId(raw(expected.membershipId))),
          encryptionPublicKey: device.enc,
          kind: 'machine',
          signer: device,
        });
        const binding = yield* signDeviceCredentialBinding({
          genesis,
          pairingSessionId: raw(expected.pairingSessionId),
          signingPublicKey: device.publicKey,
          credentialHash: raw(credential.credentialHash),
          signer: device,
        });
        const material: MachinePairingMaterial = {
          pairingSessionId: expected.pairingSessionId,
          signingPublicKey: hex(device.publicKey.toBytes()),
          encryptionPublicKey: hex(device.enc.toBytes()),
          credentialHash: credential.credentialHash,
          possessionSignature: hex(admission.possessionSignature.toBytes()),
          bindingSignature: hex(binding.toBytes()),
          protection: custody.protection,
        };
        yield* sql(() => {
          db.exec('BEGIN IMMEDIATE');
          try {
            const pending = db
              .prepare('SELECT session FROM pairings WHERE creating=1 AND material IS NULL LIMIT 1')
              .get();
            if (
              read(expected.pairingSessionId)?.creating === SUPERSEDED_GENERATION ||
              (pending && pending.session !== expected.pairingSessionId)
            )
              throw failure('conflict');
            const encoded = JSON.stringify(material);
            db.prepare('UPDATE pairings SET material=? WHERE session=? AND material IS NULL').run(
              encoded,
              expected.pairingSessionId
            );
            db.prepare(
              'INSERT INTO current_identity(singleton,session) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET session=excluded.session'
            ).run(expected.pairingSessionId);
            const current = db
              .prepare('SELECT session FROM current_identity WHERE singleton=1')
              .get();
            if (
              read(expected.pairingSessionId)?.material !== encoded ||
              current?.session !== expected.pairingSessionId
            )
              throw failure('corrupt');
            db.exec('COMMIT');
          } catch (cause) {
            try {
              db.exec('ROLLBACK');
            } catch (cleanup) {
              throw failure(
                'storage',
                new AggregateError([cause, cleanup], 'pairing publication and rollback failed')
              );
            }
            throw cause;
          }
        });
      }
      return yield* sql(() => {
        const { material } = load(expected);
        verifyMaterial(expected, material);
        if (
          material.signingPublicKey !== hex(device.publicKey.toBytes()) ||
          material.encryptionPublicKey !== hex(device.enc.toBytes()) ||
          material.credentialHash !== credential.credentialHash
        )
          throw failure('corrupt');
        return material;
      });
    }),
    /** Read the current published context pinned by the OS-user socket before
     * any Fleet ownership change. Historical originals remain internal evidence. */
    retained: (sessionId: string) =>
      sql(() => {
        const row = read(sessionId);
        const current = db.prepare('SELECT session FROM current_identity WHERE singleton=1').get();
        if (!row || current?.session !== sessionId) throw failure('conflict');
        return load(context(ContextSchema.parse(JSON.parse(row.context))));
      }),
    /** Core already authenticated these original records. Success additionally
     * requires a retained original admission and the current personal frontend's
     * same-member authority. A later local frontend never replaces the original signer. */
    confirm: Effect.fnUntraced(function* (
      input: MachinePairingContext,
      view: LedgerView,
      records: readonly Uint8Array[]
    ) {
      yield* sql(() => load(input));
      const audited = yield* verifyLedgerEffect({
        anchor: view.genesis,
        records,
        checkpoint: { head: view.head, length: view.length },
      });
      yield* sql(() => {
        const { expected, row, material } = load(input);
        verifyMaterial(expected, material);
        if (hex(view.genesis.toBytes()) !== expected.genesisHash) throw failure('conflict');
        const current = db.prepare('SELECT session FROM current_identity WHERE singleton=1').get();
        if (current?.session !== expected.pairingSessionId) throw failure('conflict');
        const state = audited.inspectState(),
          own = state.devices.get(material.signingPublicKey),
          frontend = state.devices.get(expected.frontendSigningPublicKey);
        if (
          !frontend ||
          frontend.kind !== 'personal' ||
          hex(frontend.membershipId.toBytes()) !== expected.membershipId
        )
          throw failure('not-admitted');
        if (
          !own ||
          own.kind !== 'machine' ||
          hex(own.membershipId.toBytes()) !== expected.membershipId ||
          hex(own.encryptionPublicKey.toBytes()) !== material.encryptionPublicKey ||
          !state.members.has(expected.membershipId)
        )
          throw failure('not-admitted');
        // The same-user socket pins the CURRENT frontend/session. An interrupted
        // first activation may be continued by a different active personal device
        // of the same member, but the original admission must still match a
        // retained preparation from its actual signer, including the credential.
        const preparations = db
          .prepare(
            'SELECT context,material,admission,creating FROM pairings WHERE material IS NOT NULL'
          )
          .all() as Row[];
        const found = records.find((record) => {
          const body = Result.getOrThrow(decodeRecord(record)).body;
          return (
            body.type === 'ordinary' &&
            body.operation.type === 'admitDevice' &&
            body.operation.kind === 'machine' &&
            hex(body.operation.signingPublicKey.toBytes()) === material.signingPublicKey &&
            hex(body.operation.encryptionPublicKey.toBytes()) === material.encryptionPublicKey &&
            hex(body.operation.possessionSignature.toBytes()) === material.possessionSignature &&
            preparations.some((original) => {
              const prior = context(ContextSchema.parse(JSON.parse(original.context)));
              if (
                prior.machineId !== expected.machineId ||
                prior.accountId !== expected.accountId ||
                prior.workspaceId !== expected.workspaceId ||
                prior.genesisHash !== expected.genesisHash ||
                prior.genesisRecordHex !== expected.genesisRecordHex ||
                prior.membershipId !== expected.membershipId ||
                prior.frontendSigningPublicKey !== hex(body.signer.toBytes())
              )
                return false;
              const retained = load(prior);
              verifyMaterial(prior, retained.material);
              if (
                retained.material.signingPublicKey !== material.signingPublicKey ||
                retained.material.encryptionPublicKey !== material.encryptionPublicKey ||
                retained.material.credentialHash !== material.credentialHash ||
                retained.material.possessionSignature !== material.possessionSignature
              )
                return false;
              if (
                retained.row.admission &&
                !hashRecordBytes(retained.row.admission).equals(hashRecordBytes(record))
              )
                throw failure('conflict');
              return true;
            })
          );
        });
        if (!found) throw failure('not-admitted');
        if (row.admission && !hashRecordBytes(row.admission).equals(hashRecordBytes(found)))
          throw failure('conflict');
        db.prepare('UPDATE pairings SET admission=? WHERE session=? AND admission IS NULL').run(
          found,
          expected.pairingSessionId
        );
        const actual = read(expected.pairingSessionId);
        if (!actual?.admission || !Buffer.from(actual.admission).equals(found))
          throw failure('corrupt');
      });
    }),
  };
});
