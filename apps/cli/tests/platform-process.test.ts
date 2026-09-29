import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber, Option, TestClock } from 'effect';
import type { Readable } from 'node:stream';

import {
  CommandFailed,
  CommandOutputTooLarge,
  CommandTimedOut,
  runCommand,
  runCommandOk,
  type CommandSpec,
} from '../src/platform/process/command';
import { SpawnFailed, TerminationFailed } from '../src/platform/process/errors';
import { spawnProcess, spawnScoped, type SpawnSpec } from '../src/platform/process/managed-process';
import { NodeProcess, NodeProcessLive } from '../src/platform/process/node-process';
import { TREE_POLL_INTERVAL } from '../src/platform/process/process-tree';
import {
  LINGERING_GROUP_PROBE_INTERVAL,
  makeNoopContainer,
} from '../src/platform/sandbox/noop-container';
import { FakeProcessTable } from './fake-process-table';

const GRACEFUL = { graceMs: 5_000, killWaitMs: 5_000 };
const FORCED = { graceMs: 0, killWaitMs: 5_000 };
const agentSpec: SpawnSpec = {
  command: 'agent',
  args: [],
  options: { stdio: 'pipe' },
  processGroup: true,
};

/** Let queued exit/close events fire and the fibers they wake run. */
const settleEvents = Effect.zipRight(
  Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve))),
  Effect.yieldNow()
);

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined;

describe('process tree termination (POSIX groups)', () => {
  it.effect('reaches a descendant that outlived its group leader', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const managed = yield* spawnProcess(agentSpec);
      const leader = managed.child.pid ?? -1;
      const descendant = table.addDescendant(leader);
      table.exitOnItsOwn(leader);

      yield* managed.terminate(GRACEFUL);

      expect(table.isAlive(descendant)).toBe(false);
      expect(table.delivered).toEqual([{ target: -leader, signal: 'SIGTERM' }]);
    }).pipe(Effect.provideService(NodeProcess, table.api));
  });

  it.effect('escalates to SIGKILL only after the grace period runs out', () => {
    const table = new FakeProcessTable('linux');
    table.queueSpawn({ ignores: ['SIGTERM'] });
    return Effect.gen(function* () {
      const managed = yield* spawnProcess(agentSpec);
      const leader = managed.child.pid ?? -1;
      const termination = yield* Effect.fork(managed.terminate(GRACEFUL));

      yield* TestClock.adjust('4999 millis');
      expect(table.delivered).toEqual([{ target: -leader, signal: 'SIGTERM' }]);

      yield* TestClock.adjust('1 millis');
      yield* Fiber.join(termination);
      expect(table.delivered).toEqual([
        { target: -leader, signal: 'SIGTERM' },
        { target: -leader, signal: 'SIGKILL' },
      ]);
      expect(table.isAlive(leader)).toBe(false);
    }).pipe(Effect.provideService(NodeProcess, table.api));
  });

  it.effect('fails instead of hanging when the tree survives SIGKILL', () => {
    const table = new FakeProcessTable('linux');
    table.queueSpawn({ ignores: ['SIGTERM', 'SIGKILL'] });
    return Effect.gen(function* () {
      const managed = yield* spawnProcess(agentSpec);
      const termination = yield* Effect.fork(managed.terminate(FORCED));

      yield* TestClock.adjust('5 seconds');
      const failure = failureOf(yield* Fiber.await(termination));

      expect(failure).toBeInstanceOf(TerminationFailed);
      expect(failure?.reason).toBe('still-alive');
    }).pipe(Effect.provideService(NodeProcess, table.api));
  });

  it.effect('sends SIGKILL at once under a forced policy', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const managed = yield* spawnProcess(agentSpec);
      yield* managed.terminate(FORCED);
      expect(table.delivered).toEqual([{ target: -(managed.child.pid ?? -1), signal: 'SIGKILL' }]);
    }).pipe(Effect.provideService(NodeProcess, table.api));
  });

  it.effect('signals nothing when the whole tree already exited', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const managed = yield* spawnProcess(agentSpec);
      table.exitOnItsOwn(managed.child.pid ?? -1);
      yield* managed.terminate(GRACEFUL);
      expect(table.delivered).toEqual([]);
    }).pipe(Effect.provideService(NodeProcess, table.api));
  });

  it.effect('escalates at once when a forced termination joins a graceful one', () => {
    const table = new FakeProcessTable('linux');
    table.queueSpawn({ ignores: ['SIGTERM'] });
    return Effect.gen(function* () {
      const managed = yield* spawnProcess(agentSpec);
      const leader = managed.child.pid ?? -1;
      const graceful = yield* Effect.fork(managed.terminate(GRACEFUL));
      while (table.delivered.length === 0) yield* Effect.yieldNow();

      // Completes with the test clock still at zero: no grace period is waited.
      yield* managed.terminate(FORCED);
      expect(table.isAlive(leader)).toBe(false);
      expect(table.delivered).toEqual([
        { target: -leader, signal: 'SIGTERM' },
        { target: -leader, signal: 'SIGKILL' },
      ]);

      // The graceful call sees the tree gone at its next poll.
      yield* TestClock.adjust(TREE_POLL_INTERVAL);
      yield* Fiber.join(graceful);
    }).pipe(Effect.provideService(NodeProcess, table.api));
  });

  it.effect('terminates a scoped process when its scope closes', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const pid = yield* Effect.scoped(
        Effect.map(spawnScoped(agentSpec, FORCED), (managed) => managed.child.pid ?? -1)
      );
      expect(table.isAlive(pid)).toBe(false);
    }).pipe(Effect.provideService(NodeProcess, table.api));
  });
});

describe('process tree termination (Windows)', () => {
  it.effect('skips the grace period when a graceful taskkill is refused', () => {
    const table = new FakeProcessTable('win32');
    table.queueSpawn({ ignores: ['SIGTERM'] });
    return Effect.gen(function* () {
      const managed = yield* spawnProcess(agentSpec);
      const root = managed.child.pid ?? -1;

      yield* managed.terminate(GRACEFUL);

      expect(table.isAlive(root)).toBe(false);
      expect(table.delivered).toEqual([
        { target: root, signal: 'SIGTERM' },
        { target: root, signal: 'SIGKILL' },
      ]);
      expect(
        table.spawned.filter((call) => call.command === 'taskkill').map((call) => call.args)
      ).toEqual([
        ['/PID', String(root), '/T'],
        ['/PID', String(root), '/T', '/F'],
      ]);
    }).pipe(Effect.provideService(NodeProcess, table.api));
  });

  it.effect('fails the termination when taskkill never finishes', () => {
    const table = new FakeProcessTable('win32');
    return Effect.gen(function* () {
      const managed = yield* spawnProcess(agentSpec);
      table.taskkillHangs = true;
      const termination = yield* Effect.fork(managed.terminate(FORCED));

      yield* TestClock.adjust('10 seconds');
      const failure = failureOf(yield* Fiber.await(termination));

      expect(failure).toBeInstanceOf(TerminationFailed);
      expect(failure?.reason).toBe('signal-failed');
    }).pipe(Effect.provideService(NodeProcess, table.api));
  });

  it.effect('detaches a daemon from its console only when asked, and still ends its tree', () => {
    const table = new FakeProcessTable('win32');
    return Effect.gen(function* () {
      const attached = yield* spawnProcess(agentSpec);
      const daemon = yield* spawnProcess({ ...agentSpec, windowsDetached: true });
      const root = daemon.child.pid ?? -1;

      yield* daemon.terminate(FORCED);

      expect(
        table.spawned
          .filter((call) => call.command !== 'taskkill')
          .map((call) => call.options.detached)
      ).toEqual([false, true]);
      expect(table.isAlive(root)).toBe(false);
      expect(table.isAlive(attached.child.pid ?? -1)).toBe(true);
    }).pipe(Effect.provideService(NodeProcess, table.api));
  });

  it.effect('leaves POSIX detachment to the process group', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      yield* spawnProcess({ ...agentSpec, processGroup: false, windowsDetached: true });
      expect(table.spawned.map((call) => call.options.detached)).toEqual([false]);
    }).pipe(Effect.provideService(NodeProcess, table.api));
  });
});

describe('noop process container', () => {
  it.scoped('keeps a group whose leader exited until its last member is gone', () => {
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
    }).pipe(Effect.provideService(NodeProcess, table.api));
  });

  it.scoped('terminates a lingering group left by an exited leader', () => {
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
    }).pipe(Effect.provideService(NodeProcess, table.api));
  });
});

const readPidLine = (stream: Readable | null) =>
  Effect.async<number, Error>((resume) => {
    if (!stream) {
      resume(Effect.fail(new Error('stdout is not piped')));
      return Effect.void;
    }
    let buffered = '';
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const line = buffered.split('\n')[0];
      if (buffered.includes('\n') && line) resume(Effect.succeed(Number(line.trim())));
    };
    stream.on('data', onData);
    return Effect.sync(() => {
      stream.off('data', onData);
    });
  });

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('process tree termination (real processes)', () => {
  it.live.skipIf(process.platform === 'win32')(
    'kills a real grandchild left running by an exited leader',
    () =>
      Effect.gen(function* () {
        const managed = yield* spawnProcess({
          command: '/bin/sh',
          args: ['-c', 'sleep 30 & echo $!'],
          options: { stdio: ['ignore', 'pipe', 'ignore'] },
          processGroup: true,
        });
        const grandchild = yield* readPidLine(managed.child.stdout);
        yield* managed.exited;
        expect(isRunning(grandchild)).toBe(true);

        yield* managed.terminate(FORCED);

        expect(isRunning(grandchild)).toBe(false);
      }).pipe(Effect.provide(NodeProcessLive))
  );
});

describe('runCommand', () => {
  const node = (script: string, extra: Partial<CommandSpec> = {}): CommandSpec => ({
    command: process.execPath,
    args: ['-e', script],
    ...extra,
  });

  it.live('collects stdout, stderr and the exit status of any outcome', () =>
    Effect.gen(function* () {
      const output = yield* runCommand(
        node('process.stdout.write("out"); process.stderr.write("err"); process.exit(3)')
      );
      expect(output.code).toBe(3);
      expect(output.stdout.toString()).toBe('out');
      expect(output.stderr.toString()).toBe('err');
    }).pipe(Effect.provide(NodeProcessLive))
  );

  it.live('pipes input to stdin', () =>
    Effect.gen(function* () {
      const output = yield* runCommandOk(
        node('process.stdin.pipe(process.stdout)', { input: 'hello' })
      );
      expect(output.stdout.toString()).toBe('hello');
    }).pipe(Effect.provide(NodeProcessLive))
  );

  it.live('fails with CommandFailed carrying stderr on a non-zero exit', () =>
    Effect.gen(function* () {
      const failure = failureOf(
        yield* Effect.exit(runCommandOk(node('process.stderr.write("bad ref"); process.exit(128)')))
      );
      expect(failure).toBeInstanceOf(CommandFailed);
      expect(failure instanceof CommandFailed && failure.stderr).toBe('bad ref');
    }).pipe(Effect.provide(NodeProcessLive))
  );

  it.live('fails with SpawnFailed carrying the OS error for a missing executable', () =>
    Effect.gen(function* () {
      const failure = failureOf(
        yield* Effect.exit(runCommand({ command: 'lody-no-such-binary', args: [] }))
      );
      expect(failure).toBeInstanceOf(SpawnFailed);
      expect((failure as SpawnFailed).cause).toMatchObject({ code: 'ENOENT' });
    }).pipe(Effect.provide(NodeProcessLive))
  );

  it.effect('ends the command tree and fails when it outlives its timeout', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const command = yield* Effect.fork(
        runCommand({ command: 'git', args: ['fetch'], timeout: '30 seconds' })
      );
      yield* TestClock.adjust('30 seconds');
      const failure = failureOf(yield* Fiber.await(command));

      expect(failure).toBeInstanceOf(CommandTimedOut);
      const pid = table.spawned.length === 1 ? 1000 : -1;
      expect(table.isAlive(pid)).toBe(false);
      expect(table.delivered).toEqual([{ target: -pid, signal: 'SIGKILL' }]);
    }).pipe(Effect.provideService(NodeProcess, table.api));
  });
});

describe('runCommand process-tree ownership', () => {
  it.effect('leaves what a finished command deliberately started running', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const command = yield* Effect.fork(runCommand({ command: 'git', args: ['status'] }));
      while (table.spawned.length === 0) yield* Effect.yieldNow();
      const leader = 1000;
      const daemon = table.addDescendant(leader);
      table.exitOnItsOwn(leader);

      yield* Fiber.join(command);

      expect(table.isAlive(daemon)).toBe(true);
      expect(table.delivered).toEqual([]);
    }).pipe(Effect.provideService(NodeProcess, table.api));
  });

  it.effect('fails at once and ends the tree when output exceeds its limit', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const command = yield* Effect.fork(
        runCommand({ command: 'git', args: ['log'], maxOutputBytes: 4 })
      );
      while (table.spawned.length === 0) yield* Effect.yieldNow();
      const leader = 1000;
      const child = table.childOf(leader);
      child?.stdout.emit('data', Buffer.from('more than four bytes'));

      const failure = failureOf(yield* Fiber.await(command));

      expect(failure).toBeInstanceOf(CommandOutputTooLarge);
      expect(table.isAlive(leader)).toBe(false);
    }).pipe(Effect.provideService(NodeProcess, table.api));
  });
});
