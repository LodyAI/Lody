import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
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

describe('noop process container', () => {
  it.effect('keeps a group whose leader exited until its last member is gone', () => {
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

      const tracked = yield* container.readAccounting;
      expect(tracked.kind === 'process-tree' && tracked.rootPids).toEqual([leader]);

      table.kill(descendant, 'SIGKILL');
      yield* TestClock.adjust(LINGERING_GROUP_PROBE_INTERVAL);

      const after = yield* container.readAccounting;
      expect(after.kind === 'process-tree' && after.rootPids).toEqual([]);
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
});
