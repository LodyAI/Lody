import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Exit } from 'effect';
import { TestClock } from 'effect/testing';
import { ChildProcessSpawner } from 'effect/process';
import { processLayer } from '@lody/shared/node/process';
import { FakeProcessTable } from '@lody/shared/node/process-testing';

import {
  LINGERING_GROUP_PROBE_INTERVAL,
  makeNoopContainer,
} from '../src/platform/sandbox/noop-container';

const FORCED = { graceMs: 0, killWaitMs: 5_000 };

/** Let queued exit/close events fire and the fibers they wake run. */
const settleEvents = Effect.andThen(
  Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve))),
  Effect.yieldNow
);

/** Observe the actual process Scope release without relying on garbage collection. */
const withReleaseSignal = (released: Deferred.Deferred<void>) =>
  Effect.map(ChildProcessSpawner.ChildProcessSpawner, (backend) =>
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
        return yield* backend.spawn(command);
      })
    )
  );

describe('noop process container', () => {
  it.effect('releases each completed command Scope while its container remains reusable', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      let released = yield* Deferred.make<void>();
      const backend = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.suspend(() => {
          const commandReleased = released;
          return Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Deferred.succeed(commandReleased, undefined));
            return yield* backend.spawn(command);
          });
        })
      );
      const container = yield* makeNoopContainer({
        description: 'test',
        configureProcess: () => Effect.void,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      for (let index = 0; index < 2; index++) {
        released = yield* Deferred.make<void>();
        const process = yield* container.spawn({ command: 'command', args: [], options: {} });
        table.exitOnItsOwn(process.child.pid!);
        yield* process.closed;
        yield* Deferred.await(released);
        const accounting = yield* container.readAccounting;
        expect(accounting.kind === 'process-tree' && accounting.rootPids).toEqual([]);
      }
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });

  it.effect('waits for drained stdio and the last descendant before releasing the Scope', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      for (const boundary of ['stdio', 'descendant'] as const) {
        const released = yield* Deferred.make<void>();
        const spawner = yield* withReleaseSignal(released);
        const container = yield* makeNoopContainer({
          description: 'test',
          configureProcess: () => Effect.void,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        let flushClose = () => {};
        const process = yield* container.spawn({
          command: 'command',
          args: [],
          options: {},
          onSpawned: (child) => {
            const emit = child.emit.bind(child);
            child.emit = (event, ...args: unknown[]) => {
              if (event === 'close') {
                flushClose = () => {
                  emit(event, ...args);
                };
                return true;
              }
              return emit(event, ...args);
            };
          },
        });
        const leader = process.child.pid!;
        const descendant = boundary === 'descendant' ? table.addDescendant(leader) : null;
        table.exitOnItsOwn(leader);
        yield* settleEvents;
        const tracked = yield* container.readAccounting;
        expect(tracked.kind === 'process-tree' && tracked.rootPids).toEqual(
          descendant ? [leader] : []
        );
        expect(yield* Deferred.isDone(released)).toBe(false);
        flushClose();
        if (descendant) {
          yield* process.closed;
          yield* settleEvents;
          expect(yield* Deferred.isDone(released)).toBe(false);
          expect(table.isAlive(descendant)).toBe(true);
          table.exitOnItsOwn(descendant);
          yield* TestClock.adjust(LINGERING_GROUP_PROBE_INTERVAL);
        }
        yield* Deferred.await(released);
        const after = yield* container.readAccounting;
        expect(after.kind === 'process-tree' && after.rootPids).toEqual([]);
      }
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });

  it.effect('does not release a fast-exiting command while configuration is pending', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      const configuring = yield* Deferred.make<void>();
      const continueSetup = yield* Deferred.make<void>();
      const spawner = yield* withReleaseSignal(released);
      const container = yield* makeNoopContainer({
        description: 'test',
        configureProcess: () =>
          Deferred.succeed(configuring, undefined).pipe(
            Effect.andThen(Deferred.await(continueSetup))
          ),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const creating = yield* Effect.forkChild(
        container.spawn({ command: 'command', args: [], options: {} })
      );
      yield* Deferred.await(configuring);
      table.exitOnItsOwn(1000);
      yield* settleEvents;
      expect(yield* Deferred.isDone(released)).toBe(false);
      yield* Deferred.succeed(continueSetup, undefined);
      const process = yield* Fiber.join(creating);
      yield* process.closed;
      yield* Deferred.await(released);
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });

  it.effect('terminates a lingering group left by an exited leader', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const container = yield* makeNoopContainer({
        description: 'test',
        configureProcess: () => Effect.void,
      });
      const contained = yield* container.spawn({ command: 'agent', args: [], options: {} });
      const leader = contained.child.pid ?? -1;
      const descendant = table.addDescendant(leader);
      table.exitOnItsOwn(leader);
      yield* settleEvents;

      yield* container.terminateAll(FORCED);

      expect(table.isAlive(descendant)).toBe(false);
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });

  it.effect(
    'closing the owner scope terminates groups even when their leaders exited first',
    () => {
      const table = new FakeProcessTable('linux');
      return Effect.gen(function* () {
        let descendant = 0;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const container = yield* makeNoopContainer({
              description: 'test',
              configureProcess: () => Effect.void,
            });
            const child = yield* container.spawn({ command: 'agent', args: [], options: {} });
            descendant = table.addDescendant(child.child.pid!);
            table.exitOnItsOwn(child.child.pid!);
          })
        );
        expect(table.isAlive(descendant)).toBe(false);
      }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
    }
  );

  it.effect(
    'interrupting process configuration reclaims the acquired process before returning',
    () => {
      const table = new FakeProcessTable('linux');
      return Effect.gen(function* () {
        const configuring = yield* Deferred.make<void>();
        const container = yield* makeNoopContainer({
          description: 'test',
          configureProcess: () =>
            Effect.andThen(Deferred.succeed(configuring, undefined), Effect.never),
        });
        const creating = yield* Effect.forkChild(
          container.spawn({ command: 'agent', args: [], options: {} })
        );
        yield* Deferred.await(configuring);
        yield* Fiber.interrupt(creating);
        expect(table.isAlive(1000)).toBe(false);
      }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
    }
  );
  it.effect('retains survivors after failed cleanup and retries until the group is gone', () => {
    const table = new FakeProcessTable('darwin');
    let denied = true;
    const np = {
      ...table.api,
      kill: (pid: number, signal: NodeJS.Signals | 0) => {
        if (signal !== 0 && denied)
          throw Object.assign(new Error('signal denied'), { code: 'EPERM' });
        table.api.kill(pid, signal);
      },
    };
    return Effect.gen(function* () {
      const container = yield* makeNoopContainer({
        description: 'test',
        configureProcess: () => Effect.void,
      });
      const process = yield* container.spawn({ command: 'agent', args: [], options: {} });
      const pid = process.child.pid!;
      const cleaning = yield* Effect.forkChild(container.cleanup);
      yield* TestClock.adjust('5 seconds');
      yield* Fiber.join(cleaning);
      const accounting = yield* container.readAccounting;
      expect(accounting.kind === 'process-tree' && accounting.rootPids).toEqual([pid]);
      expect(
        Exit.isFailure(yield* Effect.exit(container.terminateAll({ graceMs: 0, killWaitMs: 0 })))
      ).toBe(true);
      expect(table.isAlive(pid)).toBe(true);
      denied = false;
      yield* container.terminateAll(FORCED);
      const after = yield* container.readAccounting;
      expect(after.kind === 'process-tree' && after.rootPids).toEqual([]);
      expect(table.isAlive(pid)).toBe(false);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          denied = false;
          table.exitOnItsOwn(1000);
        })
      ),
      Effect.provide(processLayer({ nodeProcess: np }))
    );
  });
  it.effect('retains a group when its exited-leader liveness probe fails', () => {
    const table = new FakeProcessTable('linux');
    let unavailable = true;
    let descendant = 0;
    const np = {
      ...table.api,
      kill: (pid: number, signal: NodeJS.Signals | 0) => {
        if (signal === 0 && unavailable)
          throw Object.assign(new Error('probe failed'), { code: 'EIO' });
        table.api.kill(pid, signal);
      },
    };
    return Effect.gen(function* () {
      const container = yield* makeNoopContainer({
        description: 'test',
        configureProcess: () => Effect.void,
      });
      const child = yield* container.spawn({ command: 'agent', args: [], options: {} });
      const leader = child.child.pid!;
      descendant = table.addDescendant(leader);
      table.exitOnItsOwn(leader);
      yield* settleEvents;
      const unknown = yield* container.readAccounting;
      expect(unknown.kind === 'process-tree' && unknown.rootPids).toEqual([leader]);
      expect(table.isAlive(descendant)).toBe(true);
      table.kill(descendant, 'SIGKILL');
      unavailable = false;
      yield* TestClock.adjust(LINGERING_GROUP_PROBE_INTERVAL);
      const gone = yield* container.readAccounting;
      expect(gone.kind === 'process-tree' && gone.rootPids).toEqual([]);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          unavailable = false;
          table.exitOnItsOwn(descendant);
        })
      ),
      Effect.provide(processLayer({ nodeProcess: np }))
    );
  });
});
