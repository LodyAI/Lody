import { Effect, Result, Fiber, Exit } from 'effect';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  chmodSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { Bytes } from '@lody/e2ee-core/protocol';
import { NodeE2eeCustodyError } from '@lody/e2ee-core/adapters/node-custody';
import { makeCliE2eeCustody, type MachineKeyring } from '../src/lib/e2ee/custody';
const genesis = Result.getOrThrow(Bytes.genesisHash(new Uint8Array(32).fill(7)));

describe('machine E2EE custody', () => {
  it('selects file protection without a keyring and reopens the same machine identity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'machine-custody-'));
    const keyring: MachineKeyring = async () => {
      throw new Error('synthetic unavailable');
    };
    try {
      const before = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const custody = yield* makeCliE2eeCustody({ directory, keyring });
            expect(custody.protection).toBe('file');
            return (yield* custody.createDevice(genesis)).publicKey.toBytes();
          })
        )
      );
      expect(statSync(join(directory, 'kek.safe-storage')).mode & 0o777).toBe(0o600);
      const after = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const custody = yield* makeCliE2eeCustody({
              directory,
              keyring: async () => {
                throw new Error('must not switch');
              },
            });
            expect(custody.protection).toBe('file');
            return (yield* custody.openDevice(genesis)).publicKey.toBytes();
          })
        )
      );
      expect(after).toEqual(before);
      chmodSync(join(directory, 'kek.safe-storage'), 0o644);
      const result = await Effect.runPromise(
        Effect.scoped(Effect.result(makeCliE2eeCustody({ directory, keyring })))
      );
      expect(Result.isFailure(result)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('finishes ACL initialization for an interrupted empty directory, but never repairs originals', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'machine-acl-interrupted-'));
    let restricted = false;
    const directoryAcl = (_directory: string, initialize: boolean) =>
      Effect.suspend(() => {
        if (initialize) restricted = true;
        return restricted
          ? Effect.void
          : Effect.fail(new NodeE2eeCustodyError({ code: 'unavailable' }));
      });
    const keyring: MachineKeyring = async () => {
      throw new Error('synthetic unavailable');
    };
    try {
      // The process that made this directory exited before it restricted access.
      const identity = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const custody = yield* makeCliE2eeCustody({ directory, keyring, directoryAcl });
            return (yield* custody.createDevice(genesis)).publicKey.toBytes();
          })
        )
      );
      expect(restricted).toBe(true);
      restricted = false;
      const originals = new Map(
        readdirSync(directory).map((name) => [name, readFileSync(join(directory, name))])
      );
      const reopened = await Effect.runPromise(
        Effect.scoped(Effect.result(makeCliE2eeCustody({ directory, keyring, directoryAcl })))
      );
      expect(Result.isFailure(reopened)).toBe(true);
      expect(restricted).toBe(false);
      expect(identity).toHaveLength(32);
      for (const [name, original] of originals)
        expect(readFileSync(join(directory, name))).toEqual(original);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a symlink KEK and never downgrades an existing OS-protected custody', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'machine-keyring-'));
    const secrets = new Map<string, string>();
    let locked = false;
    const keyring: MachineKeyring = async (account) => ({
      getPassword: async () => {
        if (locked) throw new Error('locked');
        return secrets.get(account);
      },
      setPassword: async (value) => {
        if (locked) throw new Error('locked');
        secrets.set(account, value);
      },
      deleteCredential: async () => {
        secrets.delete(account);
      },
    });
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const custody = yield* makeCliE2eeCustody({ directory, keyring });
            expect(custody.protection).toBe('os-keystore');
            yield* custody.createDevice(genesis);
          })
        )
      );
      const original = readFileSync(join(directory, 'kek.safe-storage'));
      locked = true;
      expect(
        Result.isFailure(
          await Effect.runPromise(
            Effect.scoped(Effect.result(makeCliE2eeCustody({ directory, keyring })))
          )
        )
      ).toBe(true);
      expect(readFileSync(join(directory, 'protection'), 'utf8')).toBe('os-keystore');
      expect(readFileSync(join(directory, 'kek.safe-storage'))).toEqual(original);
      locked = false;
      renameSync(join(directory, 'kek.safe-storage'), join(directory, 'original'));
      symlinkSync(join(directory, 'original'), join(directory, 'kek.safe-storage'));
      expect(
        Result.isFailure(
          await Effect.runPromise(
            Effect.scoped(Effect.result(makeCliE2eeCustody({ directory, keyring })))
          )
        )
      ).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('preserves originals when a KEK or selected protection is missing', async () => {
    for (const missing of ['kek.safe-storage', 'protection']) {
      const directory = mkdtempSync(join(tmpdir(), 'machine-loss-'));
      const keyring: MachineKeyring = async () => {
        throw new Error('synthetic unavailable');
      };
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const custody = yield* makeCliE2eeCustody({ directory, keyring });
              yield* custody.createDevice(genesis);
            })
          )
        );
        const originals = new Map(
          readdirSync(directory)
            .filter((name) => name.endsWith('.device'))
            .map((name) => [name, readFileSync(join(directory, name))])
        );
        unlinkSync(join(directory, missing));
        const result = await Effect.runPromise(
          Effect.scoped(Effect.result(makeCliE2eeCustody({ directory, keyring })))
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(existsSync(join(directory, missing))).toBe(false);
        for (const [name, bytes] of originals)
          expect(readFileSync(join(directory, name))).toEqual(bytes);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});

import { it as effectIt } from '@effect/vitest';
import { TestClock } from 'effect/testing';
import { FakeProcessTable } from '@lody/shared/node/process-testing';
import {
  squashProcessFailure,
  ProcessCleanupFailed,
  ProcessReleaseFailed,
} from '@lody/shared/node/process';

effectIt.effect(
  'ends a timed-out keyring process before first creation selects file protection',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'machine-keyring-timeout-'));
    const table = new FakeProcessTable('linux');
    const started = Promise.withResolvers<void>();
    let pid = -1;
    const input: string[] = [];
    const nodeProcess = {
      ...table.api,
      spawn: (...args: Parameters<typeof table.api.spawn>) => {
        const child = table.api.spawn(...args);
        child.stdin!.on('data', (bytes) => input.push(String(bytes)));
        if (pid === -1) {
          pid = child.pid!;
          started.resolve();
        } else
          queueMicrotask(() => {
            child.stdout!.emit('data', Buffer.from('null'));
            table.exitOnItsOwn(child.pid!);
          });
        return child;
      },
    };
    return Effect.gen(function* () {
      const opening = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            const custody = yield* makeCliE2eeCustody({ directory, nodeProcess });
            expect(table.isAlive(pid)).toBe(false);
            expect(custody.protection).toBe('file');
            return (yield* custody.createDevice(genesis)).publicKey.toBytes();
          })
        )
      );
      yield* Effect.promise(() => started.promise);
      yield* TestClock.adjust('10 seconds');
      const identity = yield* Fiber.join(opening);
      expect(input.join('')).toContain('"operation":"set"');
      expect(table.spawned[0]!.args.join(' ')).not.toContain('probe:');
      const reopened = yield* Effect.scoped(
        Effect.gen(function* () {
          const custody = yield* makeCliE2eeCustody({
            directory,
            keyring: async () => {
              throw new Error('must not probe');
            },
          });
          return (yield* custody.openDevice(genesis)).publicKey.toBytes();
        })
      );
      expect(reopened).toEqual(identity);
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true })))
    );
  }
);

effectIt.effect(
  'retains a failed keyring process owner and refuses file fallback when termination fails',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'machine-unreleased-'));
    const table = new FakeProcessTable('linux');
    table.queueSpawn({ ignores: ['SIGTERM', 'SIGKILL'] });
    const started = Promise.withResolvers<void>();
    let pid = -1;
    const nodeProcess = {
      ...table.api,
      spawn: (...args: Parameters<typeof table.api.spawn>) => {
        const child = table.api.spawn(...args);
        pid = child.pid!;
        started.resolve();
        return child;
      },
    };
    return Effect.gen(function* () {
      const operation = yield* Effect.forkChild(
        Effect.exit(Effect.scoped(makeCliE2eeCustody({ directory, nodeProcess })))
      );
      yield* Effect.promise(() => started.promise);
      yield* TestClock.adjust('30 seconds');
      const result = yield* Fiber.join(operation);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const failure = squashProcessFailure(result.cause);
        expect(failure).toBeInstanceOf(ProcessCleanupFailed);
        if (failure instanceof ProcessCleanupFailed)
          expect(failure.releases[0]).toBeInstanceOf(ProcessReleaseFailed);
      }
      expect(existsSync(join(directory, 'protection'))).toBe(false);
      expect(table.isAlive(pid)).toBe(true);
      table.exitOnItsOwn(pid);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          table.exitOnItsOwn(pid);
          rmSync(directory, { recursive: true, force: true });
        })
      )
    );
  }
);

effectIt.effect(
  'queues concurrent opens without blocking the owner awaiting a keyring operation',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'machine-concurrent-'));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const original = DatabaseSync.prototype.exec;
    const observe = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql: string
    ) {
      try {
        return original.call(this, sql);
      } catch (error) {
        if ((error as { errcode?: number }).errcode === 5) waiting.resolve();
        throw error;
      }
    });
    return Effect.gen(function* () {
      const first = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            const custody = yield* makeCliE2eeCustody({
              directory,
              keyring: async () => {
                entered.resolve();
                await release.promise;
                throw new Error('unavailable');
              },
            });
            return custody.protection;
          })
        )
      );
      yield* Effect.promise(() => entered.promise);
      const second = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            const custody = yield* makeCliE2eeCustody({
              directory,
              keyring: async () => {
                throw new Error('must not reselect');
              },
            });
            return custody.protection;
          })
        )
      );
      yield* Effect.promise(() => waiting.promise);
      release.resolve();
      expect(yield* Fiber.join(first)).toBe('file');
      yield* TestClock.adjust('100 millis');
      expect(yield* Fiber.join(second)).toBe('file');
      expect(readFileSync(join(directory, 'protection'), 'utf8')).toBe('file');
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          release.resolve();
          observe.mockRestore();
          rmSync(directory, { recursive: true, force: true });
        })
      )
    );
  }
);

effectIt.effect(
  'an existing OS custody times out without replacing its selector, KEK or device',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'machine-os-timeout-'));
    const secrets = new Map<string, string>();
    const keyring: MachineKeyring = async (account) => ({
      getPassword: async () => secrets.get(account),
      setPassword: async (value) => {
        secrets.set(account, value);
      },
      deleteCredential: async () => {
        secrets.delete(account);
      },
    });
    const table = new FakeProcessTable('linux');
    const started = Promise.withResolvers<void>();
    let pid = -1;
    const nodeProcess = {
      ...table.api,
      spawn: (...args: Parameters<typeof table.api.spawn>) => {
        const child = table.api.spawn(...args);
        pid = child.pid!;
        started.resolve();
        return child;
      },
    };
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const custody = yield* makeCliE2eeCustody({ directory, keyring });
          yield* custody.createDevice(genesis);
        })
      );
      const originals = new Map(
        readdirSync(directory)
          .filter(
            (name) =>
              name === 'protection' || name === 'kek.safe-storage' || name.endsWith('.device')
          )
          .map((name) => [name, readFileSync(join(directory, name))])
      );
      const opening = yield* Effect.forkChild(
        Effect.scoped(Effect.result(makeCliE2eeCustody({ directory, nodeProcess })))
      );
      yield* Effect.promise(() => started.promise);
      yield* TestClock.adjust('10 seconds');
      const result = yield* Fiber.join(opening);
      expect(Result.isFailure(result)).toBe(true);
      expect(table.isAlive(pid)).toBe(false);
      for (const [name, bytes] of originals)
        expect(readFileSync(join(directory, name))).toEqual(bytes);
      expect(readFileSync(join(directory, 'protection'), 'utf8')).toBe('os-keystore');
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true })))
    );
  }
);

effectIt.effect('cancels a pending probe without publishing file protection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'machine-cancel-probe-'));
  const table = new FakeProcessTable('linux');
  const started = Promise.withResolvers<void>();
  let pid = -1;
  const nodeProcess = {
    ...table.api,
    spawn: (...args: Parameters<typeof table.api.spawn>) => {
      const child = table.api.spawn(...args);
      pid = child.pid!;
      started.resolve();
      return child;
    },
  };
  return Effect.gen(function* () {
    const opening = yield* Effect.forkChild(
      Effect.scoped(makeCliE2eeCustody({ directory, nodeProcess }))
    );
    yield* Effect.promise(() => started.promise);
    yield* Fiber.interrupt(opening);
    const result = yield* Fiber.await(opening);
    expect(Exit.isFailure(result)).toBe(true);
    expect(table.isAlive(pid)).toBe(false);
    expect(existsSync(join(directory, 'protection'))).toBe(false);
  }).pipe(Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true }))));
});
