import { Effect, Result, Deferred, Fiber, Exit, Scope } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { makeSqliteProtectedEpochKeys } from './harness';
import { synthetic } from './protection-fixture';
import { execNativeChild } from '../native-child';
import { fileURLToPath } from 'node:url';
import { makeHostEpochProtection, type NativeEpochProtector } from './harness';
import { makeInstalledEpochHistory } from './harness';
import { Bytes } from '@lody/e2ee-core/protocol';
import { commitEpochKey, sealHistoryPacket } from '../../src/internal/keys/history';
import { contentPermissions } from '@lody/e2ee-core/protocol';
import { envelopeFixture } from './fixture';
const ok = Result.getOrThrow;
const dirs: string[] = [];
const file = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2ee-protected-'));
  dirs.push(dir);
  return path.join(dir, 'keys.sqlite');
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const wiped = (buffers: Uint8Array[]) =>
  expect(buffers.every((b) => b.every((x) => x === 0))).toBe(true);
const config = (f: ReturnType<typeof envelopeFixture>, protector: NativeEpochProtector) => ({
  genesis: f.context.genesis,
  recipient: f.phone.publicKey,
  ledger: f.ledger,
  protector,
});
describe('host-only epoch protection', () => {
  it('round trips an opaque key and wipes callback buffers without exporting through ordinary keys', async () => {
    const f = envelopeFixture(),
      native = synthetic();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeHostEpochProtection(config(f, native.protector));
          const blob = yield* host.seal(0, f.secret);
          wiped(native.plains);
          const key = yield* host.open(0, blob);
          expect(ok(commitEpochKey(f.context.genesis, 0, key))).toEqual(
            ok(commitEpochKey(f.context.genesis, 0, f.secret))
          );
          wiped(native.plains);
          const bad = new Uint8Array(blob);
          bad[bad.length - 1] ^= 1;
          expect(Exit.isFailure(yield* Effect.exit(host.open(0, bad)))).toBe(true);
        })
      )
    );
    wiped(native.plains);
  });
  it('clears native failure and malformed result buffers and exposes only fixed error categories', async () => {
    const f = envelopeFixture(),
      native = synthetic();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let failed: Uint8Array | undefined;
          const broken = yield* makeHostEpochProtection(
            config(f, {
              ...native.protector,
              protect: async (body) => {
                failed = body;
                throw Error('synthetic sensitive native diagnostic');
              },
            })
          );
          const fault = yield* Effect.flip(broken.seal(0, f.secret));
          expect(fault.reason).toBe('native-failed');
          expect(JSON.stringify(fault)).not.toContain('sensitive');
          expect(failed?.every((x) => x === 0)).toBe(true);
          const badSeal = yield* makeHostEpochProtection(
            config(f, { ...native.protector, protect: async () => new Uint8Array(8193) })
          );
          expect((yield* Effect.flip(badSeal.seal(0, f.secret))).reason).toBe('invalid-input');
          const normal = yield* makeHostEpochProtection(config(f, native.protector)),
            blob = yield* normal.seal(0, f.secret);
          const malformed = new Uint8Array(162).fill(87);
          const badOpen = yield* makeHostEpochProtection(
            config(f, { ...native.protector, unprotect: async () => malformed })
          );
          expect((yield* Effect.flip(badOpen.open(0, blob))).reason).toBe('binding-mismatch');
          expect(malformed.every((x) => x === 0)).toBe(true);
        })
      )
    );
    wiped(native.plains);
  });
  it('binds Org, epoch, recipient and purpose independently of a matching epoch-zero commitment', async () => {
    const f = envelopeFixture(),
      native = synthetic();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeHostEpochProtection(config(f, native.protector));
          const blob = yield* host.seal(0, f.secret);
          const wrongRecipient = yield* makeHostEpochProtection({
            ...config(f, native.protector),
            recipient: f.owner.publicKey,
          });
          expect(Exit.isFailure(yield* Effect.exit(wrongRecipient.open(0, blob)))).toBe(true);
          const other = envelopeFixture(0, 101);
          expect(ok(commitEpochKey(other.context.genesis, 0, other.secret))).toEqual(
            ok(commitEpochKey(f.context.genesis, 0, f.secret))
          );
          const wrongOrg = yield* makeHostEpochProtection(config(other, native.protector));
          expect((yield* Effect.flip(wrongOrg.open(0, blob))).reason).toBe('binding-mismatch');
          for (const position of [0, 29, 61, 93, 97, 129]) {
            const body = yield* Effect.promise(() => native.protector.unprotect(blob));
            body[position] ^= 1;
            const changed = yield* Effect.promise(() => native.protector.protect(body));
            body.fill(0);
            expect((yield* Effect.flip(host.open(0, changed))).reason).toBe(
              position === 129 ? 'commitment-mismatch' : 'binding-mismatch'
            );
          }
        })
      )
    );
    wiped(native.plains);
  });
  it('captures native capability once and rejects known recipient revocation', async () => {
    const f = envelopeFixture(),
      native = synthetic();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeHostEpochProtection(config(f, native.protector));
          const blob = yield* host.seal(0, f.secret);
          native.protector.unprotect = async () => {
            throw Error('mutated callback');
          };
          yield* host.open(0, blob);
          f.append([5, f.phone.raw]);
          expect(Exit.isFailure(yield* Effect.exit(host.open(0, blob)))).toBe(true);
        })
      )
    );
    wiped(native.plains);
  });
  it('scope close waits for native completion and clears plaintext before releasing the resource', async () => {
    const f = envelopeFixture(),
      native = synthetic();
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make(),
          closed = yield* Deferred.make<void>();
        let body: Uint8Array | undefined;
        let allow!: () => void, notify!: () => void;
        const wait = new Promise<void>((resolve) => {
            allow = resolve;
          }),
          entered = new Promise<void>((resolve) => {
            notify = resolve;
          });
        const protector: NativeEpochProtector = {
          ...native.protector,
          protect: (bytes) => {
            body = bytes;
            notify();
            return wait.then(() => native.protector.protect(bytes));
          },
        };
        const host = yield* makeHostEpochProtection(config(f, protector)).pipe(
          Effect.provideService(Scope.Scope, scope)
        );
        const worker = yield* Effect.forkChild(host.seal(0, f.secret));
        yield* Effect.promise(() => entered);
        const closer = yield* Effect.forkChild(
          Scope.close(scope, Exit.void).pipe(Effect.andThen(Deferred.succeed(closed, undefined)))
        );
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(closed)).toBe(false);
        allow();
        expect(Exit.isFailure(yield* Fiber.await(worker))).toBe(true);
        yield* Fiber.join(closer);
        expect(body?.every((x) => x === 0)).toBe(true);
        expect(Exit.isFailure(yield* Effect.exit(host.seal(0, f.secret)))).toBe(true);
      })
    );
  });
  it('awaits cancelled native unprotect and wipes its late plaintext before interruption completes', async () => {
    const f = envelopeFixture(),
      native = synthetic();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let allow!: () => void, notify!: () => void;
          const release = new Promise<void>((resolve) => {
              allow = resolve;
            }),
            entered = new Promise<void>((resolve) => {
              notify = resolve;
            });
          let late: Uint8Array | undefined;
          const protector: NativeEpochProtector = {
            ...native.protector,
            unprotect: async (blob) => {
              late = await native.protector.unprotect(blob);
              notify();
              await release;
              return late;
            },
          };
          const host = yield* makeHostEpochProtection(config(f, protector));
          const blob = yield* host.seal(0, f.secret);
          const worker = yield* Effect.forkChild(host.open(0, blob));
          yield* Effect.promise(() => entered);
          const done = yield* Deferred.make<void>();
          const interrupt = yield* Effect.forkChild(
            Fiber.interrupt(worker).pipe(Effect.andThen(Deferred.succeed(done, undefined)))
          );
          yield* Effect.yieldNow;
          expect(yield* Deferred.isDone(done)).toBe(false);
          expect(late?.some((x) => x !== 0)).toBe(true);
          allow();
          yield* Fiber.join(interrupt);
          expect(Exit.isFailure(yield* Fiber.await(worker))).toBe(true);
          expect(late?.every((x) => x === 0)).toBe(true);
        })
      )
    );
  });
  it('saves protected bytes and reopens with fresh decrypt/commitment checks; retains uncertain failed readback', async () => {
    const f = envelopeFixture(),
      native = synthetic(),
      dbPath = file();
    const create = () =>
      makeSqliteProtectedEpochKeys({
        ...config(f, native.protector),
        path: dbPath,
        mode: 'create',
      });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* create();
          yield* store.saveAndReload(0, f.secret);
        })
      )
    );
    const inspect = new Database(dbPath);
    const blob = inspect.prepare('SELECT blob FROM installed_epoch_keys').get() as {
      blob: Uint8Array;
    };
    expect(blob.blob.length).toBeGreaterThan(32);
    inspect.close();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeSqliteProtectedEpochKeys({
            ...config(f, native.protector),
            path: dbPath,
            mode: 'open',
          });
          const key = yield* store.read(0);
          expect(ok(commitEpochKey(f.context.genesis, 0, key))).toEqual(
            ok(commitEpochKey(f.context.genesis, 0, f.secret))
          );
          yield* store.saveAndReload(0, f.secret);
        })
      )
    );
    const child = await execNativeChild(process.execPath, [
      '--import',
      'tsx',
      fileURLToPath(new URL('./protected-reopen.mts', import.meta.url)),
      dbPath,
    ]);
    expect(child.trim()).toBe(
      Buffer.from(ok(commitEpochKey(f.context.genesis, 0, f.secret)).toBytes()).toString('hex')
    );
    f.append([5, f.owner.raw]);
    expect(ok(contentPermissions(f.view(), f.owner.publicKey))).toMatchObject({
      mayWriteDocument: false,
      maySealNewContent: false,
    });
    expect(Result.isFailure(await Effect.runPromise(Effect.result(f.prepare())))).toBe(true);
    const revokedChild = await execNativeChild(process.execPath, [
      '--import',
      'tsx',
      fileURLToPath(new URL('./protected-reopen.mts', import.meta.url)),
      dbPath,
      'sender-revoked',
    ]);
    expect(revokedChild.trim()).toBe(
      Buffer.from(ok(commitEpochKey(f.context.genesis, 0, f.secret)).toBytes()).toString('hex')
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeSqliteProtectedEpochKeys({
            ...config(f, native.protector),
            path: dbPath,
            mode: 'open',
          });
          const restored = yield* store.read(0);
          expect(ok(commitEpochKey(f.context.genesis, 0, restored))).toEqual(
            ok(commitEpochKey(f.context.genesis, 0, f.secret))
          );
        })
      )
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeSqliteProtectedEpochKeys({
            ...config(f, {
              ...native.protector,
              unprotect: async () => {
                throw Error('locked');
              },
            }),
            path: dbPath,
            mode: 'open',
          });
          expect(Exit.isFailure(yield* Effect.exit(store.saveAndReload(0, f.secret)))).toBe(true);
        })
      )
    );
    const after = new Database(dbPath);
    expect(
      (after.prepare('SELECT blob FROM installed_epoch_keys').get() as { blob: Uint8Array }).blob
    ).toEqual(blob.blob);
    after.close();
    wiped(native.plains);
  });
  it('rejects foreign stores before mutation, storage failure before installation and persisted authority rollback', async () => {
    const f = envelopeFixture(),
      native = synthetic(),
      dbPath = file(),
      old = f.view();
    const foreign = new Database(dbPath);
    foreign.exec('CREATE TABLE original(x);PRAGMA application_id=123');
    foreign.close();
    const before = readFileSync(dbPath);
    const bad = await Effect.runPromise(
      Effect.scoped(
        Effect.exit(
          makeSqliteProtectedEpochKeys({
            ...config(f, native.protector),
            path: dbPath,
            mode: 'open',
          })
        )
      )
    );
    expect(Exit.isFailure(bad)).toBe(true);
    expect(readFileSync(dbPath)).toEqual(before);
    const actual = file();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeSqliteProtectedEpochKeys({
            ...config(f, native.protector),
            path: actual,
            mode: 'create',
          });
          const db = new Database(actual);
          db.exec(
            "CREATE TRIGGER reject_key BEFORE INSERT ON installed_epoch_keys BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END"
          );
          db.close();
          expect(Exit.isFailure(yield* Effect.exit(store.saveAndReload(0, f.secret)))).toBe(true);
          const check = new Database(actual);
          expect(check.prepare('SELECT count(*) AS n FROM installed_epoch_keys').get()).toEqual({
            n: 0,
          });
          check.exec('DROP TRIGGER reject_key');
          check.close();
          yield* store.saveAndReload(0, f.secret);
          f.append([5, f.phone.raw]);
          expect(Exit.isFailure(yield* Effect.exit(store.read(0)))).toBe(true);
        })
      )
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeSqliteProtectedEpochKeys({
            ...config(f, native.protector),
            path: actual,
            mode: 'open',
            ledger: () => Effect.succeed(old),
          });
          expect(Exit.isFailure(yield* Effect.exit(store.read(0)))).toBe(true);
        })
      )
    );
    wiped(native.plains);
  });
});

describe('verified host observations and durable authority readback', () => {
  it('does not pin a cloned view and remembers genuine revocation before missing-epoch rejection', async () => {
    const f = envelopeFixture(),
      native = synthetic(),
      old = f.view();
    let current = old;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeHostEpochProtection({
            ...config(f, native.protector),
            ledger: () => Effect.succeed(current),
          });
          const blob = yield* host.seal(0, f.secret);
          current = { ...old } as typeof old;
          expect(Exit.isFailure(yield* Effect.exit(host.open(1, blob)))).toBe(true);
          current = old;
          expect(ok(commitEpochKey(f.context.genesis, 0, yield* host.open(0, blob)))).toEqual(
            ok(commitEpochKey(f.context.genesis, 0, f.secret))
          );
          f.append([5, f.phone.raw]);
          current = f.view();
          expect(Exit.isFailure(yield* Effect.exit(host.open(1, blob)))).toBe(true);
          current = old;
          expect(
            Exit.isFailure(yield* Effect.exit(host.open(0, blob))),
            'known genuine revocation cannot be forgotten due to unavailable epoch'
          ).toBe(true);
        })
      )
    );
  });
});

it('recovers and durably reloads all old keys from only installed latest K, validating the whole chain before writes; failed missing-epoch reads retain observed revocation', async () => {
  const f = envelopeFixture(),
    native = synthetic(),
    pathName = file();
  const key1 = ok(Bytes.epochKey(new Uint8Array(32).fill(176))),
    key2 = ok(Bytes.epochKey(new Uint8Array(32).fill(177)));
  f.append([
    7,
    1,
    ok(commitEpochKey(f.context.genesis, 1, key1)).toBytes(),
    ok(
      sealHistoryPacket({
        genesis: f.context.genesis,
        epoch: 1,
        currentKey: key1,
        previousKey: f.secret,
      })
    ),
  ]);
  f.append([
    7,
    2,
    ok(commitEpochKey(f.context.genesis, 2, key2)).toBytes(),
    ok(
      sealHistoryPacket({
        genesis: f.context.genesis,
        epoch: 2,
        currentKey: key2,
        previousKey: key1,
      })
    ),
  ]);
  let selected = f.view();
  const ledger = () => Effect.succeed(selected);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* makeSqliteProtectedEpochKeys({
          ...config(f, native.protector),
          ledger,
          path: pathName,
          mode: 'create',
        });
        yield* store.saveAndReload(2, key2);
        const history = yield* makeInstalledEpochHistory({
          genesis: f.context.genesis,
          ledger,
          installed: store,
        });
        const restored = yield* history.read(0);
        expect(ok(commitEpochKey(f.context.genesis, 0, restored))).toEqual(
          ok(commitEpochKey(f.context.genesis, 0, f.secret))
        );
        const db = new Database(pathName, { readonly: true, fileMustExist: true });
        try {
          expect(db.prepare('SELECT epoch FROM installed_epoch_keys ORDER BY epoch').all()).toEqual(
            [{ epoch: 0 }, { epoch: 1 }, { epoch: 2 }]
          );
        } finally {
          db.close();
        }
        const prior = selected;
        f.append([5, f.phone.raw]);
        selected = f.view();
        expect(Result.isFailure(yield* Effect.result(history.read(99)))).toBe(true);
        selected = prior;
        expect(Result.isFailure(yield* Effect.result(history.read(2)))).toBe(true);
      })
    )
  );
  wiped(native.plains);
});
it('bad signed history produces no partial older durable keys, and retries after native storage ABORT recover original commitments', async () => {
  for (const corrupt of [true, false]) {
    const f = envelopeFixture(),
      native = synthetic(),
      pathName = file();
    const key1 = ok(Bytes.epochKey(new Uint8Array(32).fill(178))),
      key2 = ok(Bytes.epochKey(new Uint8Array(32).fill(179)));
    const packet = ok(
      sealHistoryPacket({
        genesis: f.context.genesis,
        epoch: 1,
        currentKey: key1,
        previousKey: f.secret,
      })
    );
    if (corrupt) packet[packet.length - 1] = packet.at(-1)! ^ 1;
    f.append([7, 1, ok(commitEpochKey(f.context.genesis, 1, key1)).toBytes(), packet]);
    f.append([
      7,
      2,
      ok(commitEpochKey(f.context.genesis, 2, key2)).toBytes(),
      ok(
        sealHistoryPacket({
          genesis: f.context.genesis,
          epoch: 2,
          currentKey: key2,
          previousKey: key1,
        })
      ),
    ]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeSqliteProtectedEpochKeys({
            ...config(f, native.protector),
            path: pathName,
            mode: 'create',
          });
          yield* store.saveAndReload(2, key2);
          const history = yield* makeInstalledEpochHistory({
            genesis: f.context.genesis,
            ledger: f.ledger,
            installed: store,
          });
          const db = new Database(pathName, { fileMustExist: true });
          try {
            if (!corrupt)
              db.exec(
                "CREATE TRIGGER deny_old BEFORE INSERT ON installed_epoch_keys WHEN NEW.epoch<2 BEGIN SELECT RAISE(ABORT,'synthetic storage fault'); END"
              );
            expect(Result.isFailure(yield* Effect.result(history.recover()))).toBe(true);
            expect(
              db.prepare('SELECT epoch FROM installed_epoch_keys ORDER BY epoch').all()
            ).toEqual([{ epoch: 2 }]);
            if (!corrupt) {
              db.exec('DROP TRIGGER deny_old');
              expect(yield* history.recover()).toEqual([2, 1, 0]);
              const zero = yield* store.read(0);
              expect(ok(commitEpochKey(f.context.genesis, 0, zero))).toEqual(
                ok(commitEpochKey(f.context.genesis, 0, f.secret))
              );
            }
          } finally {
            db.close();
          }
        })
      )
    );
  }
});

it.each([0, 2] as const)(
  'the actual protected store retains kind %s, forged-key/commitment checks, same-length fork rejection and closed ownership after retiring the volatile cache',
  async (kind) => {
    const f = envelopeFixture(kind),
      native = synthetic(),
      dbPath = file();
    const prior = f.view();
    let current = prior;
    let owned: Effect.Success<ReturnType<typeof makeSqliteProtectedEpochKeys>> | undefined;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = (owned = yield* makeSqliteProtectedEpochKeys({
            ...config(f, native.protector),
            path: dbPath,
            mode: 'create',
            ledger: () => Effect.succeed(current),
          }));
          const fake = Object.freeze({}) as Bytes.EpochKey;
          expect(Result.isFailure(yield* Effect.result(store.saveAndReload(0, fake)))).toBe(true);
          expect(
            Result.isFailure(
              yield* Effect.result(
                store.saveAndReload(0, ok(Bytes.epochKey(new Uint8Array(32).fill(77))))
              )
            )
          ).toBe(true);
          current = { ...prior } as typeof prior;
          expect(Result.isFailure(yield* Effect.result(store.saveAndReload(0, f.secret)))).toBe(
            true
          );
          current = prior;
          yield* store.saveAndReload(0, f.secret);
          yield* store.saveAndReload(0, f.secret);
          const read = yield* store.read(0);
          expect(ok(commitEpochKey(f.context.genesis, 0, read))).toEqual(
            ok(commitEpochKey(f.context.genesis, 0, f.secret))
          );
          // Revoke on one valid branch and publish on the other, both at count 3.
          f.append([5, f.phone.raw]);
          current = f.view();
          // Reading an existing blob actually observes the genuine revocation.
          expect(Result.isFailure(yield* Effect.result(store.read(0)))).toBe(true);
          expect(Result.isFailure(yield* Effect.result(store.read(99)))).toBe(true);
          const other = envelopeFixture(kind),
            next = ok(Bytes.epochKey(new Uint8Array(32).fill(8)));
          const packet = ok(
            sealHistoryPacket({
              genesis: other.context.genesis,
              epoch: 1,
              currentKey: next,
              previousKey: other.secret,
            })
          );
          other.append([
            7,
            1,
            ok(commitEpochKey(other.context.genesis, 1, next)).toBytes(),
            packet,
          ]);
          const fork = other.view();
          expect(fork.genesis.equals(current.genesis)).toBe(true);
          expect(fork.length).toBe(current.length);
          expect(fork.head.equals(current.head)).toBe(false);
          current = prior;
          expect(Result.isFailure(yield* Effect.result(store.read(0)))).toBe(true);
          current = fork;
          expect(Result.isFailure(yield* Effect.result(store.read(0)))).toBe(true);
        })
      )
    );
    expect(Result.isFailure(await Effect.runPromise(Effect.result(owned!.read(0))))).toBe(true);
    expect(
      Result.isFailure(await Effect.runPromise(Effect.result(owned!.saveAndReload(0, f.secret))))
    ).toBe(true);
  }
);

describe('protected store repair and read-only authority pins', () => {
  it('replaces only an unreadable blob with a newly protected and independently verified key', async () => {
    const f = envelopeFixture(),
      native = synthetic(),
      dbPath = file();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeSqliteProtectedEpochKeys({
            ...config(f, native.protector),
            path: dbPath,
            mode: 'create',
          });
          yield* store.saveAndReload(0, f.secret);
        })
      )
    );
    const disk = new Database(dbPath);
    const unreadable = new Uint8Array([1, 2, 3]);
    disk.prepare('UPDATE installed_epoch_keys SET blob=? WHERE epoch=0').run(unreadable);
    disk.close();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bad = yield* makeSqliteProtectedEpochKeys({
            ...config(f, { ...native.protector, protect: async () => new Uint8Array([4, 5, 6]) }),
            path: dbPath,
            mode: 'open',
          });
          expect(Result.isFailure(yield* Effect.result(bad.saveAndReload(0, f.secret)))).toBe(true);
        })
      )
    );
    const unchanged = new Database(dbPath);
    expect(
      new Uint8Array(
        (
          unchanged.prepare('SELECT blob FROM installed_epoch_keys WHERE epoch=0').get() as {
            blob: Uint8Array;
          }
        ).blob
      )
    ).toEqual(unreadable);
    unchanged.close();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeSqliteProtectedEpochKeys({
            ...config(f, native.protector),
            path: dbPath,
            mode: 'open',
          });
          expect(Result.isSuccess(yield* Effect.result(store.saveAndReload(0, f.secret)))).toBe(
            true
          );
          const restored = yield* store.read(0);
          expect(ok(commitEpochKey(f.context.genesis, 0, restored))).toEqual(
            ok(commitEpochKey(f.context.genesis, 0, f.secret))
          );
        })
      )
    );
    const repaired = new Database(dbPath);
    expect(
      new Uint8Array(
        (
          repaired.prepare('SELECT blob FROM installed_epoch_keys WHERE epoch=0').get() as {
            blob: Uint8Array;
          }
        ).blob
      )
    ).not.toEqual(unreadable);
    repaired.close();
  });
});
