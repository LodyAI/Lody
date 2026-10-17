import { runNativeChild } from '../native-child';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { Effect, Result, Deferred, Fiber, Exit } from 'effect';
import { ContentError } from '../../src/internal/foundation/errors';
import { bytesEqual } from '../../src/internal/foundation/cbor';
import * as Envelopes from '@lody/e2ee-core/protocol';
import { DeliveryOutbox, KeyMailbox } from '@lody/e2ee-core/services';
import { deliverEpochEnvelope, epochDeliveryId } from '@lody/e2ee-core/internal';
import { DeliveryRemote, DeliveryRemoteError, deliveryMailbox } from './harness';
import { sqliteDeliveryOutbox } from '@lody/e2ee-core/adapters/node-sqlite';
import { envelopeFixture } from './fixture';
const ok = <A, E>(r: Result.Result<A, E>) => Result.getOrThrow(r);
const directories: string[] = [];
const location = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2ee-outbox-'));
  directories.push(dir);
  return path.join(dir, 'outbox.sqlite');
};
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function host(f: ReturnType<typeof envelopeFixture>, file: string) {
  const db = new Database(file);
  db.exec('CREATE TABLE IF NOT EXISTS envelopes(slot TEXT PRIMARY KEY,frame BLOB NOT NULL)');
  const read = (slot: string) => {
    const row = db.prepare('SELECT frame FROM envelopes WHERE slot=?').get(slot) as
      | { frame: Uint8Array }
      | undefined;
    return row ? new Uint8Array(row.frame) : null;
  };
  let losePut = false,
    loseRead = false;
  const service = DeliveryRemote.of({
    put: (slot, frame) =>
      Effect.gen(function* () {
        yield* Effect.fromResult(Envelopes.authenticateEpochEnvelope(f.view(), f.context, frame));
        if (slot !== ok(epochDeliveryId(f.context)))
          return yield* new ContentError({ code: 'unauthorized' });
        const original = read(slot);
        if (original && !bytesEqual(original, frame))
          return yield* new ContentError({ code: 'conflict' });
        db.prepare(
          'INSERT INTO envelopes(slot,frame) VALUES(?,?) ON CONFLICT(slot) DO NOTHING'
        ).run(slot, frame);
        if (losePut) return yield* new DeliveryRemoteError();
        return undefined;
      }),
    read: (slot) =>
      loseRead ? Effect.fail(new DeliveryRemoteError()) : Effect.sync(() => read(slot)),
  });
  return {
    db,
    read,
    service,
    loseResponses: () => {
      losePut = true;
      loseRead = true;
    },
    restore: () => {
      losePut = false;
      loseRead = false;
    },
  };
}
const run = <A, E>(
  work: Effect.Effect<A, E, DeliveryOutbox | KeyMailbox>,
  file: string,
  mode: 'create' | 'open',
  remote: Parameters<typeof deliveryMailbox>[0]
) =>
  Effect.runPromise(
    work.pipe(
      Effect.provideService(KeyMailbox, deliveryMailbox(remote)),
      Effect.provide(sqliteDeliveryOutbox({ path: file, mode }))
    )
  );
const runResult = <A, E>(
  work: Effect.Effect<A, E, DeliveryOutbox | KeyMailbox>,
  file: string,
  mode: 'create' | 'open',
  remote: Parameters<typeof deliveryMailbox>[0]
) =>
  Effect.runPromise(
    Effect.result(
      work.pipe(
        Effect.provideService(KeyMailbox, deliveryMailbox(remote)),
        Effect.provide(sqliteDeliveryOutbox({ path: file, mode }))
      )
    )
  );
const pending = (slot: string) =>
  Effect.gen(function* () {
    return yield* (yield* DeliveryOutbox).load(slot);
  });
describe('durable exact-byte epoch delivery', () => {
  it.each(['before-send', 'lost-response'])(
    'independent process exit at %s resumes original ciphertext',
    async (phase) => {
      const f = envelopeFixture(),
        file = location(),
        hostPath = file + '.host',
        moduleRequire = createRequire(import.meta.url);
      const execute = (mode: string) =>
        runNativeChild(
          process.execPath,
          [
            '--import',
            moduleRequire.resolve('tsx'),
            path.join(import.meta.dirname, 'reopen.ts'),
            mode,
            file,
            hostPath,
          ],
          { env: { ...process.env, NODE_OPTIONS: '' } }
        );
      const crashed = await execute(phase);
      expect(crashed.signal).toBeNull();
      expect(crashed.status).toBe(phase === 'before-send' ? 81 : 82);
      const original = new Uint8Array(Buffer.from(crashed.stdout, 'hex'));
      expect(
        Result.isSuccess(Envelopes.authenticateEpochEnvelope(f.view(), f.context, original))
      ).toBe(true);
      const resumed = await execute('resume');
      expect(resumed.signal).toBeNull();
      expect(resumed.status).toBe(0);
      expect(resumed.stdout).toBe(crashed.stdout);
      const remote = host(f, hostPath);
      try {
        expect(remote.read(ok(epochDeliveryId(f.context)))).toEqual(original);
        expect(
          await run(pending(ok(epochDeliveryId(f.context))), file, 'open', remote.service)
        ).toEqual(original);
      } finally {
        remote.db.close();
      }
    }
  );
  it('persists before a lost response and resumes after reopening without signer/key', async () => {
    const f = envelopeFixture(),
      file = location(),
      remote = host(f, file + '.host');
    try {
      remote.loseResponses();
      const first = await run(
        deliverEpochEnvelope({
          context: f.context,
          ledger: f.ledger,
          prepare: { key: f.secret, signer: f.owner.signer },
        }),
        file,
        'create',
        remote.service
      );
      expect(first.outcome).toBe('Pending');
      expect(remote.read(first.slot)).toEqual(first.frame);
      expect(await run(pending(first.slot), file, 'open', remote.service)).toEqual(first.frame);
      remote.restore();
      const resumed = await run(
        deliverEpochEnvelope({ context: f.context, ledger: f.ledger }),
        file,
        'open',
        remote.service
      );
      expect(resumed).toEqual({ ...first, outcome: 'Stored' });
      expect(remote.read(first.slot)).toEqual(first.frame);
      resumed.frame.fill(0);
      expect(await run(pending(first.slot), file, 'open', remote.service)).toEqual(first.frame);
    } finally {
      remote.db.close();
    }
  });
  it('keeps the first ciphertext atomically across separate handles and escaped Scope use fails', async () => {
    const file = location(),
      f = envelopeFixture(),
      remote = host(f, file + '.host'),
      slot = ok(epochDeliveryId(f.context));
    let escaped: DeliveryOutbox['Service'] | undefined;
    try {
      const first = await run(
        Effect.gen(function* () {
          const box = yield* DeliveryOutbox;
          escaped = box;
          return yield* box.saveOriginal(slot, new Uint8Array([1, 2, 3]));
        }),
        file,
        'create',
        remote.service
      );
      expect(
        await run(
          Effect.gen(function* () {
            return yield* (yield* DeliveryOutbox).saveOriginal(slot, new Uint8Array([9]));
          }),
          file,
          'open',
          remote.service
        )
      ).toEqual(first);
      const closed = await Effect.runPromise(Effect.result(escaped!.load(slot)));
      expect(Result.isFailure(closed)).toBe(true);
      if (Result.isFailure(closed)) expect(closed.failure.reason).toBe('closed');
    } finally {
      remote.db.close();
    }
  });
  it('4096 earlier retained envelopes do not prevent the next real signed delivery', async () => {
    const f = envelopeFixture(),
      file = location(),
      remote = host(f, file + '.host');
    try {
      await run(Effect.void, file, 'create', remote.service);
      // Populate historical retained rows in one real transaction. This case
      // tests indexed lookup beyond 4096 rows, not 4096 synchronous disk flushes.
      const seed = new Database(file);
      try {
        const insert = seed.prepare('INSERT INTO epoch_delivery(slot,frame) VALUES(?,?)');
        seed
          .transaction(() => {
            for (let i = 0; i < 4096; i++)
              insert.run(i.toString(16).padStart(32, '0'), new Uint8Array(248).fill(i % 256));
          })
          .immediate();
      } finally {
        seed.close();
      }
      const next = await run(
        deliverEpochEnvelope({
          context: f.context,
          ledger: f.ledger,
          prepare: { key: f.secret, signer: f.owner.signer },
        }),
        file,
        'open',
        remote.service
      );
      expect(next.outcome).toBe('Stored');
      expect(remote.read(next.slot)).toEqual(next.frame);
      expect(await run(pending('0'.repeat(32)), file, 'open', remote.service)).toEqual(
        new Uint8Array(248)
      );
      const db = new Database(file, { readonly: true });
      try {
        expect(db.prepare('SELECT COUNT(*) AS n FROM epoch_delivery').get()).toEqual({ n: 4097 });
      } finally {
        db.close();
      }
    } finally {
      remote.db.close();
    }
  });
  it('disk contents and old views cannot bypass current authorization; failure retains original pending', async () => {
    const f = envelopeFixture(),
      file = location(),
      remote = host(f, file + '.host');
    try {
      remote.loseResponses();
      const sent = await run(
        deliverEpochEnvelope({
          context: f.context,
          ledger: f.ledger,
          prepare: { key: f.secret, signer: f.owner.signer },
        }),
        file,
        'create',
        remote.service
      );
      f.append([5, f.phone.raw]);
      remote.restore();
      const failed = await run(
        Effect.result(deliverEpochEnvelope({ context: f.context, ledger: f.ledger })),
        file,
        'open',
        remote.service
      );
      expect(Result.isFailure(failed)).toBe(true);
      expect(await run(pending(sent.slot), file, 'open', remote.service)).toEqual(sent.frame);
      expect(remote.read(sent.slot)).toEqual(sent.frame);
      const forged = () => Effect.succeed({ ...f.view() });
      expect(
        Result.isFailure(
          await run(
            Effect.result(deliverEpochEnvelope({ context: f.context, ledger: forged })),
            file,
            'open',
            remote.service
          )
        )
      ).toBe(true);
    } finally {
      remote.db.close();
    }
  });
  it('refuses rollback from a locally observed revoked view before sending persisted bytes to a malicious host', async () => {
    const f = envelopeFixture(),
      file = location(),
      remote = host(f, file + '.host'),
      slot = ok(epochDeliveryId(f.context)),
      old = f.view(),
      frame = await Effect.runPromise(f.prepare());
    try {
      await run(
        Effect.gen(function* () {
          yield* (yield* DeliveryOutbox).saveOriginal(slot, frame);
        }),
        file,
        'create',
        remote.service
      );
      f.append([5, f.owner.raw]);
      const revoked = f.view();
      let first = true;
      const ledger = () =>
        Effect.sync(() => {
          const selected = first ? revoked : old;
          first = false;
          return selected;
        });
      const malicious = DeliveryRemote.of({
        ...remote.service,
        put: (id, bytes) =>
          Effect.sync(() => {
            remote.db.prepare('INSERT INTO envelopes(slot,frame) VALUES(?,?)').run(id, bytes);
          }),
      });
      const failed = await runResult(
        deliverEpochEnvelope({ context: f.context, ledger }),
        file,
        'open',
        malicious
      );
      expect(Result.isFailure(failed)).toBe(true);
      expect(remote.read(slot)).toBeNull();
      expect(await run(pending(slot), file, 'open', remote.service)).toEqual(frame);
    } finally {
      remote.db.close();
    }
  });
  it('rejects forged saved bytes instead of calling a permissive remote as authorization', async () => {
    const f = envelopeFixture(),
      file = location(),
      slot = ok(epochDeliveryId(f.context));
    const remote = DeliveryRemote.of({
      put: () => Effect.die('should never send'),
      read: () => Effect.die('should never read'),
    });
    await run(
      Effect.gen(function* () {
        yield* (yield* DeliveryOutbox).saveOriginal(slot, new Uint8Array(248));
      }),
      file,
      'create',
      remote
    );
    const failed = await run(
      Effect.result(deliverEpochEnvelope({ context: f.context, ledger: f.ledger })),
      file,
      'open',
      remote
    );
    expect(Result.isFailure(failed)).toBe(true);
    expect(await run(pending(slot), file, 'open', remote)).toEqual(new Uint8Array(248));
  });
  it('interruption propagates rather than becoming Pending, and closing preserves persisted bytes', async () => {
    const f = envelopeFixture(),
      file = location(),
      slot = ok(epochDeliveryId(f.context));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>();
          const remote = DeliveryRemote.of({
            put: () => Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never)),
            read: () => Effect.die('not reached'),
          });
          const worker = yield* Effect.forkChild(
            deliverEpochEnvelope({
              context: f.context,
              ledger: f.ledger,
              prepare: { key: f.secret, signer: f.owner.signer },
            }).pipe(
              Effect.provideService(KeyMailbox, deliveryMailbox(remote)),
              Effect.provide(sqliteDeliveryOutbox({ path: file, mode: 'create' }))
            )
          );
          yield* Deferred.await(reached);
          yield* Fiber.interrupt(worker);
          expect(Exit.isFailure(yield* Fiber.await(worker))).toBe(true);
        })
      )
    );
    const remote = host(f, file + '.host');
    try {
      const persisted = await run(pending(slot), file, 'open', remote.service);
      expect(persisted).not.toBeNull();
      expect(
        Result.isSuccess(Envelopes.authenticateEpochEnvelope(f.view(), f.context, persisted!))
      ).toBe(true);
      const resumed = await run(
        deliverEpochEnvelope({ context: f.context, ledger: f.ledger }),
        file,
        'open',
        remote.service
      );
      expect(resumed.outcome).toBe('Stored');
      expect(resumed.frame).toEqual(persisted);
    } finally {
      remote.db.close();
    }
  });
  it('open refuses a missing or foreign file without replacing it', async () => {
    const f = envelopeFixture(),
      file = location(),
      remote = host(f, file + '.host');
    try {
      expect(
        Result.isFailure(await runResult(pending('0'.repeat(32)), file, 'open', remote.service))
      ).toBe(true);
      const db = new Database(file);
      db.exec("CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES ('keep')");
      db.close();
      expect(
        Result.isFailure(await runResult(pending('0'.repeat(32)), file, 'open', remote.service))
      ).toBe(true);
      const retained = new Database(file, { readonly: true });
      try {
        expect(retained.prepare('SELECT value FROM user_data').get()).toEqual({ value: 'keep' });
      } finally {
        retained.close();
      }
    } finally {
      remote.db.close();
    }
  });
  it('fails on an oversized corrupt row without rewriting it, while another row stays readable', async () => {
    const file = location(),
      f = envelopeFixture(),
      remote = host(f, file + '.host'),
      slot = '0'.repeat(32),
      other = '1'.repeat(32);
    try {
      await run(
        Effect.gen(function* () {
          const box = yield* DeliveryOutbox;
          yield* box.saveOriginal(slot, new Uint8Array([1]));
          yield* box.saveOriginal(other, new Uint8Array([2]));
        }),
        file,
        'create',
        remote.service
      );
      const db = new Database(file);
      try {
        db.pragma('ignore_check_constraints=ON');
        db.prepare('UPDATE epoch_delivery SET frame=? WHERE slot=?').run(new Uint8Array(600), slot);
      } finally {
        db.close();
      }
      const failed = await runResult(pending(slot), file, 'open', remote.service);
      expect(Result.isFailure(failed)).toBe(true);
      if (Result.isFailure(failed)) expect(failed.failure.reason).toBe('corrupt');
      expect(await run(pending(other), file, 'open', remote.service)).toEqual(new Uint8Array([2]));
      const preserved = new Database(file, { readonly: true });
      try {
        expect(
          preserved.prepare('SELECT length(frame) AS n FROM epoch_delivery WHERE slot=?').get(slot)
        ).toEqual({ n: 600 });
      } finally {
        preserved.close();
      }
    } finally {
      remote.db.close();
    }
  });
});
