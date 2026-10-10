import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NodeFileSystem } from '@effect/platform-node-shared';
import { describe, expect, it } from '@effect/vitest';
import { Cause, Clock, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option } from 'effect';
import { systemError } from 'effect/PlatformError';
import { TestClock } from 'effect/testing';
import {
  FileLockHost,
  FileLocksLive,
  LockReleaseFailed,
  LockTimeout,
  cleanupStaleLocks,
  withFileLock,
  fileLocksLegacy,
} from '../src/node/file-lock';
import {
  NodeProcess,
  nodeProcessLive,
  processLayer,
  spawnProcess,
  ProcessCleanupFailed,
} from '../src/node/process';
import { FakeProcessTable } from '../src/node/process-testing';

const fixture = Effect.gen(function* () {
  const baseFs = yield* FileSystem.FileSystem;
  const contended = yield* Deferred.make<void>();
  const filesystem = FileSystem.FileSystem.of({
    ...baseFs,
    link: (from, to) =>
      baseFs.link(from, to).pipe(Effect.tapError(() => Deferred.succeed(contended, undefined))),
  });
  const locksDir = yield* filesystem.makeTempDirectoryScoped({ prefix: 'lody-lock-' });
  const layer = FileLocksLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, filesystem),
        Layer.succeed(NodeProcess, nodeProcessLive),
        Layer.succeed(FileLockHost, { locksDir, pid: process.pid })
      )
    )
  );
  const context = yield* Layer.build(layer);
  return { filesystem, locksDir, context, contended };
}).pipe(Effect.provide(NodeFileSystem.layer));
const errorOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

// Real files, injected clocks and explicit readiness; no sleeps or timer races.
describe('native file locks', () => {
  it.effect('queues FIFO without charging local waiting to the cross-process deadline', () =>
    Effect.gen(function* () {
      const { locksDir, context } = yield* fixture;
      yield* Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const order: string[] = [];
        const holder = yield* withFileLock(
          'fifo',
          Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.andThen(Effect.sync(() => order.push('holder')))
          ),
          { timeout: 0 }
        ).pipe(
          Effect.andThen(
            withFileLock(
              'fifo',
              Effect.sync(() => order.push('newcomer')),
              { timeout: 0 }
            )
          ),
          Effect.forkChild
        );
        yield* Deferred.await(ready);
        const second = yield* withFileLock(
          'fifo',
          Effect.sync(() => order.push('second')),
          { timeout: 0 }
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const third = yield* withFileLock(
          'fifo',
          Effect.sync(() => order.push('third')),
          { timeout: 0 }
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust('1 minute');
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(second);
        yield* Fiber.join(third);
        expect(order).toEqual(['holder', 'second', 'third', 'newcomer']);
        expect(fs.readdirSync(locksDir)).toEqual([]);
      }).pipe(Effect.provideContext(context));
    })
  );

  it.effect(
    'cancels a queued waiter permanently and joins holder cleanup before the successor',
    () =>
      Effect.gen(function* () {
        const { locksDir, context } = yield* fixture;
        yield* Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          let cancelledRan = false;
          const holder = yield* withFileLock(
            'cancel',
            Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never))
          ).pipe(Effect.forkChild);
          yield* Deferred.await(ready);
          const waiter = yield* withFileLock(
            'cancel',
            Effect.sync(() => {
              cancelledRan = true;
            })
          ).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Fiber.interrupt(waiter);
          yield* Fiber.interrupt(holder);
          expect(fs.existsSync(path.join(locksDir, 'cancel.lock'))).toBe(false);
          yield* withFileLock('cancel', Effect.void);
          expect(cancelledRan).toBe(false);
          expect(fs.readdirSync(locksDir)).toEqual([]);
        }).pipe(Effect.provideContext(context));
      })
  );

  it.effect('propagates body failure and immediately admits the next holder', () =>
    Effect.gen(function* () {
      const { locksDir, context } = yield* fixture;
      yield* Effect.gen(function* () {
        const exit = yield* withFileLock('failure', Effect.fail('body failed')).pipe(Effect.exit);
        expect(errorOf(exit)).toBe('body failed');
        expect(yield* withFileLock('failure', Effect.succeed(42))).toBe(42);
        expect(fs.readdirSync(locksDir)).toEqual([]);
      }).pipe(Effect.provideContext(context));
    })
  );

  it.effect(
    'rejects reentry, including sanitized aliases and inherited child context, while allowing different locks',
    () =>
      Effect.gen(function* () {
        const { locksDir, context } = yield* fixture;
        yield* Effect.gen(function* () {
          const exit = yield* withFileLock(
            'same/path',
            withFileLock('same_path', Effect.void).pipe(
              Effect.forkChild,
              Effect.flatMap(Fiber.join)
            )
          ).pipe(Effect.exit);
          expect(errorOf(exit)).toMatchObject({ _tag: 'LockReentrant' });
          expect(yield* withFileLock('outer', withFileLock('inner', Effect.succeed('ok')))).toBe(
            'ok'
          );
          expect(fs.readdirSync(locksDir)).toEqual([]);
        }).pipe(Effect.provideContext(context));
      })
  );

  it.effect('times out only on cross-process contention and leaves the live lock untouched', () =>
    Effect.gen(function* () {
      const { locksDir, context, contended } = yield* fixture;
      const raw = JSON.stringify({ pid: process.pid, timestamp: yield* Clock.currentTimeMillis });
      fs.writeFileSync(path.join(locksDir, 'busy.lock'), raw);
      yield* Effect.gen(function* () {
        const fiber = yield* withFileLock('busy', Effect.fail('must not run'), {
          timeout: 20,
          retryDelay: 50,
          maxRetryDelay: 10,
        }).pipe(Effect.forkChild);
        yield* Deferred.await(contended);
        // The existing policy caps subsequent delays, not the configured first one.
        yield* TestClock.adjust(30);
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(21);
        const exit = yield* Fiber.await(fiber);
        expect(errorOf(exit)).toBeInstanceOf(LockTimeout);
        expect(fs.readFileSync(path.join(locksDir, 'busy.lock'), 'utf8')).toBe(raw);
        expect(fs.readdirSync(locksDir)).toEqual(['busy.lock']);
      }).pipe(Effect.provideContext(context));
    })
  );

  it.effect(
    'timestamps publication after cross-process waiting, preserving the full stale age window',
    () =>
      Effect.gen(function* () {
        const { locksDir, context } = yield* fixture;
        const clock = yield* Clock.Clock;
        const sleeping = yield* Deferred.make<void>();
        const retry = yield* Deferred.make<void>();
        const controlled: Clock.Clock = {
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
          currentTimeMillis: clock.currentTimeMillis,
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          currentTimeNanos: clock.currentTimeNanos,
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          sleep: () =>
            Deferred.succeed(sleeping, undefined).pipe(Effect.andThen(Deferred.await(retry))),
        };
        const start = yield* Clock.currentTimeMillis;
        const lockPath = path.join(locksDir, 'age.lock');
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: start }));
        yield* Effect.gen(function* () {
          const waiter = yield* withFileLock(
            'age',
            Effect.sync(
              () => JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { timestamp: number }
            ),
            { timeout: 120000 }
          ).pipe(Effect.provideService(Clock.Clock, controlled), Effect.forkChild);
          yield* Deferred.await(sleeping);
          yield* TestClock.adjust('1 minute');
          fs.unlinkSync(lockPath);
          yield* Deferred.succeed(retry, undefined);
          expect((yield* Fiber.join(waiter)).timestamp - start).toBeGreaterThanOrEqual(60000);
          expect(fs.readdirSync(locksDir)).toEqual([]);
        }).pipe(Effect.provideContext(context));
      })
  );

  it.effect('cancels cross-process retry without later acquiring when that owner releases', () =>
    Effect.gen(function* () {
      const { locksDir, context, contended } = yield* fixture;
      fs.writeFileSync(
        path.join(locksDir, 'busy.lock'),
        JSON.stringify({ pid: process.pid, timestamp: yield* Clock.currentTimeMillis })
      );
      yield* Effect.gen(function* () {
        let ran = false;
        const fiber = yield* withFileLock(
          'busy',
          Effect.sync(() => {
            ran = true;
          })
        ).pipe(Effect.forkChild);
        yield* Deferred.await(contended);
        yield* TestClock.adjust(100);
        yield* Fiber.interrupt(fiber);
        fs.unlinkSync(path.join(locksDir, 'busy.lock'));
        yield* TestClock.adjust('1 minute');
        yield* withFileLock('busy', Effect.void);
        expect(ran).toBe(false);
        expect(fs.readdirSync(locksDir)).toEqual([]);
      }).pipe(Effect.provideContext(context));
    })
  );

  it.effect(
    'reclaims missing owners, aged and malformed files; cleanup preserves fresh live owners',
    () =>
      Effect.gen(function* () {
        const { locksDir, context } = yield* fixture;
        const now = yield* Clock.currentTimeMillis;
        fs.writeFileSync(
          path.join(locksDir, 'gone.lock'),
          JSON.stringify({ pid: 2147483647, timestamp: now })
        );
        fs.writeFileSync(
          path.join(locksDir, 'old.lock'),
          JSON.stringify({ pid: process.pid, timestamp: now - 31 * 60 * 1000 })
        );
        fs.writeFileSync(path.join(locksDir, 'invalid.lock'), 'not-json');
        fs.writeFileSync(
          path.join(locksDir, 'live.lock'),
          JSON.stringify({ pid: process.pid, timestamp: now })
        );
        yield* Effect.gen(function* () {
          yield* withFileLock('gone', Effect.void);
          yield* withFileLock('old', Effect.void);
          yield* cleanupStaleLocks();
          expect(fs.readdirSync(locksDir)).toEqual(['live.lock']);
        }).pipe(Effect.provideContext(context));
      })
  );

  it.effect(
    'reports release failure, retains ownership and retries cleanup before the next operation',
    () =>
      Effect.gen(function* () {
        const { filesystem, locksDir } = yield* fixture;
        let denyRemoval = true;
        const lockPath = path.join(locksDir, 'release.lock');
        const failingFs = FileSystem.FileSystem.of({
          ...filesystem,
          remove: (file, options) =>
            file === lockPath && denyRemoval
              ? Effect.fail(
                  systemError({ _tag: 'PermissionDenied', module: 'FileSystem', method: 'remove' })
                )
              : filesystem.remove(file, options),
        });
        yield* Effect.gen(function* () {
          const first = yield* withFileLock('release', Effect.succeed('ok')).pipe(Effect.exit);
          expect(errorOf(first)).toBeInstanceOf(LockReleaseFailed);
          expect(fs.existsSync(lockPath)).toBe(true);
          const second = yield* withFileLock('release', Effect.fail('must not run')).pipe(
            Effect.exit
          );
          expect(errorOf(second)).toBeInstanceOf(LockReleaseFailed);
          denyRemoval = false;
          expect(yield* withFileLock('release', Effect.succeed('recovered'))).toBe('recovered');
          expect(fs.readdirSync(locksDir)).toEqual([]);
        }).pipe(
          Effect.provide(
            FileLocksLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(FileSystem.FileSystem, failingFs),
                  Layer.succeed(FileLockHost, { locksDir, pid: process.pid }),
                  Layer.succeed(NodeProcess, nodeProcessLive)
                )
              )
            )
          )
        );
      })
  );

  it.effect('cancels metadata preparation without publishing and joins owned scratch cleanup', () =>
    Effect.gen(function* () {
      const { filesystem, locksDir } = yield* fixture;
      const prepared = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const staged = FileSystem.FileSystem.of({
        ...filesystem,
        writeFileString: (file, data, options) =>
          filesystem.writeFileString(file, data, options).pipe(
            Effect.andThen(Deferred.succeed(prepared, undefined)),
            Effect.andThen(Deferred.await(gate)),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
          ),
      });
      yield* Effect.gen(function* () {
        let ran = false;
        const acquire = yield* withFileLock(
          'prepare',
          Effect.sync(() => {
            ran = true;
          })
        ).pipe(Effect.forkChild);
        yield* Deferred.await(prepared);
        expect(fs.existsSync(path.join(locksDir, 'prepare.lock'))).toBe(false);
        expect(fs.readdirSync(locksDir)).toHaveLength(1);
        yield* Fiber.interrupt(acquire);
        yield* Deferred.await(interrupted);
        yield* Deferred.succeed(gate, undefined);
        expect(ran).toBe(false);
        expect(fs.readdirSync(locksDir)).toEqual([]);
      }).pipe(
        Effect.provide(
          FileLocksLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(FileSystem.FileSystem, staged),
                Layer.succeed(FileLockHost, { locksDir, pid: process.pid }),
                Layer.succeed(NodeProcess, nodeProcessLive)
              )
            )
          )
        )
      );
    })
  );

  it.effect('joins interrupted publication before releasing its newly acquired file', () =>
    Effect.gen(function* () {
      const { filesystem, locksDir } = yield* fixture;
      const published = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const staged = FileSystem.FileSystem.of({
        ...filesystem,
        link: (from, to) =>
          filesystem
            .link(from, to)
            .pipe(
              Effect.andThen(Deferred.succeed(published, undefined)),
              Effect.andThen(Deferred.await(gate))
            ),
      });
      yield* Effect.gen(function* () {
        let ran = false;
        const acquisition = yield* withFileLock(
          'publication',
          Effect.sync(() => {
            ran = true;
          })
        ).pipe(Effect.forkChild);
        yield* Deferred.await(published);
        const lockPath = path.join(locksDir, 'publication.lock');
        expect(fs.existsSync(lockPath)).toBe(true);
        // Request cancellation at this exact filesystem boundary. Joining still
        // waits for publication's result and the registered release.
        acquisition.interruptUnsafe();
        expect(acquisition.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(gate, undefined);
        expect(Exit.isFailure(yield* Fiber.await(acquisition))).toBe(true);
        expect(ran).toBe(false);
        expect(fs.readdirSync(locksDir)).toEqual([]);
        expect(yield* withFileLock('publication', Effect.succeed('next'))).toBe('next');
      }).pipe(
        Effect.provide(
          FileLocksLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(FileSystem.FileSystem, staged),
                Layer.succeed(FileLockHost, { locksDir, pid: process.pid }),
                Layer.succeed(NodeProcess, nodeProcessLive)
              )
            )
          )
        )
      );
    })
  );

  it.effect('retains failed scratch cleanup and retries it before admitting another body', () =>
    Effect.gen(function* () {
      const { filesystem, locksDir } = yield* fixture;
      let denyScratch = true;
      const broken = FileSystem.FileSystem.of({
        ...filesystem,
        remove: (file, options) =>
          path.basename(file).startsWith('.lody-lock-') && denyScratch
            ? Effect.fail(
                systemError({ _tag: 'PermissionDenied', module: 'FileSystem', method: 'remove' })
              )
            : filesystem.remove(file, options),
      });
      yield* Effect.gen(function* () {
        expect(
          errorOf(yield* withFileLock('scratch', Effect.succeed('ok')).pipe(Effect.exit))
        ).toBeInstanceOf(LockReleaseFailed);
        expect(fs.existsSync(path.join(locksDir, 'scratch.lock'))).toBe(false);
        expect(fs.readdirSync(locksDir)).toHaveLength(1);
        expect(
          errorOf(yield* withFileLock('scratch', Effect.fail('must not run')).pipe(Effect.exit))
        ).toBeInstanceOf(LockReleaseFailed);
        denyScratch = false;
        // An external owner can finish cleanup after the failed attempt.
        // Confirmed absence must clear retention rather than strand the queue.
        for (const scratch of fs.readdirSync(locksDir))
          yield* filesystem.remove(path.join(locksDir, scratch), { recursive: true });
        expect(yield* withFileLock('scratch', Effect.succeed('recovered'))).toBe('recovered');
        expect(fs.readdirSync(locksDir)).toEqual([]);
      }).pipe(
        Effect.provide(
          FileLocksLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(FileSystem.FileSystem, broken),
                Layer.succeed(FileLockHost, { locksDir, pid: process.pid }),
                Layer.succeed(NodeProcess, nodeProcessLive)
              )
            )
          )
        )
      );
    })
  );

  it.effect('Layer disposal reports an unresolved release rather than declaring success', () =>
    Effect.gen(function* () {
      const { filesystem, locksDir } = yield* fixture;
      const lockPath = path.join(locksDir, 'dispose.lock');
      const broken = FileSystem.FileSystem.of({
        ...filesystem,
        remove: (file, options) =>
          file === lockPath
            ? Effect.fail(
                systemError({ _tag: 'PermissionDenied', module: 'FileSystem', method: 'remove' })
              )
            : filesystem.remove(file, options),
      });
      const close = yield* withFileLock('dispose', Effect.void).pipe(
        Effect.exit,
        Effect.provide(
          FileLocksLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(FileSystem.FileSystem, broken),
                Layer.succeed(FileLockHost, { locksDir, pid: process.pid }),
                Layer.succeed(NodeProcess, nodeProcessLive)
              )
            )
          )
        ),
        Effect.exit
      );
      expect(Exit.isFailure(close)).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(true);
    })
  );

  it.effect('cleans acquisition scratch after a failed metadata write', () =>
    Effect.gen(function* () {
      const { filesystem, locksDir } = yield* fixture;
      const broken = FileSystem.FileSystem.of({
        ...filesystem,
        writeFileString: () =>
          Effect.fail(systemError({ _tag: 'Unknown', module: 'FileSystem', method: 'write' })),
      });
      yield* Effect.gen(function* () {
        const exit = yield* withFileLock('write-fail', Effect.fail('must not run')).pipe(
          Effect.exit
        );
        expect(errorOf(exit)).toMatchObject({ _tag: 'LockIoError' });
        expect(fs.readdirSync(locksDir)).toEqual([]);
      }).pipe(
        Effect.provide(
          FileLocksLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(FileSystem.FileSystem, broken),
                Layer.succeed(FileLockHost, { locksDir, pid: process.pid }),
                Layer.succeed(NodeProcess, nodeProcessLive)
              )
            )
          )
        )
      );
    })
  );

  it.effect('cannot delete or silently succeed after its lock generation was replaced', () =>
    Effect.gen(function* () {
      const { locksDir, context } = yield* fixture;
      const lockPath = path.join(locksDir, 'replacement.lock');
      yield* Effect.gen(function* () {
        const replacement = JSON.stringify({
          pid: process.pid,
          timestamp: yield* Clock.currentTimeMillis,
          token: 'another-owner',
        });
        const exit = yield* withFileLock(
          'replacement',
          Effect.sync(() => {
            fs.unlinkSync(lockPath);
            fs.writeFileSync(lockPath, replacement);
          })
        ).pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(LockReleaseFailed);
        expect(fs.readFileSync(lockPath, 'utf8')).toBe(replacement);
        expect(
          errorOf(yield* withFileLock('replacement', Effect.fail('must not run')).pipe(Effect.exit))
        ).toBeInstanceOf(LockReleaseFailed);
        fs.unlinkSync(lockPath);
      }).pipe(Effect.provideContext(context));
    })
  );

  it.effect('reclaims a pid now owned by another user through the native process probe', () =>
    Effect.gen(function* () {
      const { filesystem, locksDir } = yield* fixture;
      const foreign = {
        ...nodeProcessLive,
        kill: () => {
          throw Object.assign(new Error('foreign'), { code: 'EPERM' });
        },
      };
      fs.writeFileSync(
        path.join(locksDir, 'foreign.lock'),
        JSON.stringify({ pid: 123, timestamp: yield* Clock.currentTimeMillis })
      );
      yield* withFileLock('foreign', Effect.void).pipe(
        Effect.provide(
          FileLocksLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(FileSystem.FileSystem, filesystem),
                Layer.succeed(FileLockHost, { locksDir, pid: process.pid }),
                Layer.succeed(NodeProcess, foreign)
              )
            )
          )
        )
      );
      expect(fs.readdirSync(locksDir)).toEqual([]);
    })
  );

  it.effect('does not erase an unreadable lock', () =>
    Effect.gen(function* () {
      const { filesystem, locksDir } = yield* fixture;
      const lockPath = path.join(locksDir, 'unreadable.lock');
      const now = yield* Clock.currentTimeMillis;
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: now }));
      const broken = FileSystem.FileSystem.of({
        ...filesystem,
        readFileString: (file, encoding) =>
          file === lockPath
            ? Effect.fail(
                systemError({ _tag: 'PermissionDenied', module: 'FileSystem', method: 'read' })
              )
            : filesystem.readFileString(file, encoding),
      });
      yield* Effect.gen(function* () {
        const exit = yield* withFileLock('unreadable', Effect.void).pipe(Effect.exit);
        expect(errorOf(exit)).toMatchObject({ _tag: 'LockIoError' });
        expect(fs.existsSync(lockPath)).toBe(true);
      }).pipe(
        Effect.provide(
          FileLocksLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(FileSystem.FileSystem, broken),
                Layer.succeed(FileLockHost, { locksDir, pid: process.pid }),
                Layer.succeed(NodeProcess, nodeProcessLive)
              )
            )
          )
        )
      );
    })
  );
});

describe('real cross-process file lock', () => {
  it.live('excludes another OS process in both directions and cleans the native owner', () =>
    Effect.gen(function* () {
      const filesystem = yield* FileSystem.FileSystem;
      const locksDir = yield* filesystem.makeTempDirectoryScoped({ prefix: 'lody-lock-process-' });
      const lockPath = path.join(locksDir, 'cross.lock');
      const ready = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const blocked = yield* Deferred.make<string>();
      const worker = yield* spawnProcess({
        command: process.execPath,
        args: [
          '-e',
          `
        const fs = require('node:fs');
        const lockPath = process.argv[1];
        const raw = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
        fs.writeFileSync(lockPath, raw, { flag: 'wx' });
        process.send('held');
        process.on('message', (message) => {
          if (message === 'release') { fs.unlinkSync(lockPath); process.send('released'); }
          if (message === 'probe') {
            try { fs.writeFileSync(lockPath, raw, { flag: 'wx' }); process.send('overlap'); }
            catch (error) { process.send(error.code === 'EEXIST' ? 'blocked' : 'error'); }
          }
          if (message === 'done') process.exit(0);
        });
      `,
          lockPath,
        ],
        options: { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
        processGroup: true,
        onSpawned: (child) =>
          child.on('message', (message) => {
            if (message === 'held') Deferred.doneUnsafe(ready, Effect.void);
            if (message === 'released') Deferred.doneUnsafe(released, Effect.void);
            if (message === 'blocked' || message === 'overlap' || message === 'error')
              Deferred.doneUnsafe(blocked, Effect.succeed(String(message)));
          }),
      });
      yield* Deferred.await(ready);
      const attempted = yield* Deferred.make<void>();
      const injected = FileSystem.FileSystem.of({
        ...filesystem,
        link: (from, to) =>
          filesystem
            .link(from, to)
            .pipe(Effect.tapError(() => Deferred.succeed(attempted, undefined))),
      });
      yield* Effect.gen(function* () {
        let entered = false;
        const holder = yield* withFileLock(
          'cross',
          Effect.gen(function* () {
            entered = true;
            yield* Effect.sync(() => worker.child.send('probe'));
            expect(yield* Deferred.await(blocked)).toBe('blocked');
          }),
          { retryDelay: 0, maxRetryDelay: 0 }
        ).pipe(Effect.forkChild);
        yield* Deferred.await(attempted);
        expect(entered).toBe(false);
        yield* Effect.sync(() => worker.child.send('release'));
        yield* Deferred.await(released);
        yield* Fiber.join(holder);
        expect(entered).toBe(true);
        expect(fs.readdirSync(locksDir)).toEqual([]);
      }).pipe(
        Effect.provide(
          FileLocksLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(FileSystem.FileSystem, injected),
                Layer.succeed(FileLockHost, { locksDir, pid: process.pid }),
                Layer.succeed(NodeProcess, nodeProcessLive)
              )
            )
          )
        )
      );
      yield* Effect.sync(() => worker.child.send('done'));
      expect((yield* worker.exited).code).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeFileSystem.layer, processLayer({}))))
  );
});

describe('single Legacy facade', () => {
  it('retains unresolved process cleanup alongside a native program failure', async () => {
    const locksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lock-process-'));
    const table = new FakeProcessTable('linux');
    let denied = true;
    const failure = new Error('native operation failed');
    const program = Effect.gen(function* () {
      yield* spawnProcess(
        { command: 'agent', args: [], options: { stdio: 'pipe' }, processGroup: true },
        { graceMs: 0, killWaitMs: 0 }
      );
      return yield* Effect.fail(failure);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        processLayer({
          nodeProcess: {
            ...table.api,
            kill: (target, signal) => {
              if (signal !== 0 && denied)
                throw Object.assign(new Error('denied'), { code: 'EPERM' });
              table.api.kill(target, signal);
            },
          },
        })
      )
    );
    try {
      const rejected = await fileLocksLegacy
        .runPromise(withFileLock('native-process', program, { locksDir }))
        .catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(ProcessCleanupFailed);
      if (!(rejected instanceof ProcessCleanupFailed)) throw new Error('Missing cleanup owner');
      expect(rejected.cause).toBe(failure);
      expect(rejected.releases).toHaveLength(1);
      const owner = rejected.releases[0]!;
      expect(await Effect.runPromise(owner.isAlive)).toBe(true);
      denied = false;
      await Effect.runPromise(owner.retryTermination());
      expect(table.isAlive(1000)).toBe(false);
      expect(await Effect.runPromise(owner.isAlive)).toBe(false);
      await expect(
        fileLocksLegacy.withLock('native-process', async () => 42, { locksDir })
      ).resolves.toBe(42);
      expect(fs.readdirSync(locksDir)).toEqual([]);
    } finally {
      table.exitOnItsOwn(1000);
      fs.rmSync(locksDir, { recursive: true, force: true });
    }
  });

  it('preserves Promise callback errors and async-context reentry without a second kernel', async () => {
    const locksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lock-legacy-'));
    try {
      await expect(
        fileLocksLegacy.withLock(
          'nested',
          async () => fileLocksLegacy.withLock('nested', async () => 'bad', { locksDir }),
          { locksDir }
        )
      ).rejects.toThrow('not reentrant');
      const failure = new Error('body failed');
      await expect(
        fileLocksLegacy.withLock(
          'nested',
          async () => {
            throw failure;
          },
          { locksDir }
        )
      ).rejects.toBe(failure);
      await expect(fileLocksLegacy.withLock('nested', async () => 42, { locksDir })).resolves.toBe(
        42
      );
      expect(fs.readdirSync(locksDir)).toEqual([]);
    } finally {
      fs.rmSync(locksDir, { recursive: true, force: true });
    }
  });

  it('signals and joins a cancelled Promise callback before releasing', async () => {
    const locksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lock-legacy-'));
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let aborted!: () => void;
    const sawAbort = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    try {
      const pending = fileLocksLegacy.withLock(
        'cancel',
        async (signal) => {
          signal.addEventListener('abort', aborted, { once: true });
          started();
          await gate;
        },
        { locksDir, signal: controller.signal }
      );
      // Attach rejection handling before aborting, then observe the held file.
      const exit = pending.then(
        () => 'success',
        () => 'cancelled'
      );
      await ready;
      controller.abort();
      await sawAbort;
      expect(fs.existsSync(path.join(locksDir, 'cancel.lock'))).toBe(true);
      finish();
      expect(await exit).toBe('cancelled');
      expect(fs.readdirSync(locksDir)).toEqual([]);
    } finally {
      finish();
      fs.rmSync(locksDir, { recursive: true, force: true });
    }
  });
});
