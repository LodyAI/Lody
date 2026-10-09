import { describe, expect, it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber, Option } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { TestClock } from 'effect/testing';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  CommandFailed,
  CommandOutputTooLarge,
  CommandTimedOut,
  runCommand,
  runCommandOk,
  type CommandSpec,
  runCommandText,
  startProcess,
} from '../src/node/process';
import { signalChildTreeNow, SpawnFailed, TerminationFailed } from '../src/node/process';
import { spawnProcess as acquireProcess, type SpawnSpec } from '../src/node/process';
import { processLayer, isPidAliveSync } from '../src/node/process';
import {
  READ_ONLY_ABANDON_POLICY,
  resolveWindowsCommand,
  TREE_POLL_INTERVAL,
} from '../src/node/process';
import { FakeProcessTable } from '../src/node/process-testing';

const spawnProcess = (spec: SpawnSpec) => acquireProcess(spec, { graceMs: 0, killWaitMs: 0 });

const GRACEFUL = { graceMs: 5_000, killWaitMs: 5_000 };
const FORCED = { graceMs: 0, killWaitMs: 5_000 };
const agentSpec: SpawnSpec = {
  command: 'agent',
  args: [],
  options: { stdio: 'pipe' },
  processGroup: true,
};

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

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
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });

  it.effect('escalates to SIGKILL only after the grace period runs out', () => {
    const table = new FakeProcessTable('linux');
    table.queueSpawn({ ignores: ['SIGTERM'] });
    return Effect.gen(function* () {
      const managed = yield* spawnProcess(agentSpec);
      const leader = managed.child.pid ?? -1;
      const termination = yield* Effect.forkChild(managed.terminate(GRACEFUL));

      yield* TestClock.adjust('4999 millis');
      expect(table.delivered).toEqual([{ target: -leader, signal: 'SIGTERM' }]);

      yield* TestClock.adjust('1 millis');
      yield* Fiber.join(termination);
      expect(table.delivered).toEqual([
        { target: -leader, signal: 'SIGTERM' },
        { target: -leader, signal: 'SIGKILL' },
      ]);
      expect(table.isAlive(leader)).toBe(false);
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });

  it.effect('fails instead of hanging when the tree survives SIGKILL', () => {
    const table = new FakeProcessTable('linux');
    table.queueSpawn({ ignores: ['SIGTERM', 'SIGKILL'] });
    return Effect.gen(function* () {
      const managed = yield* spawnProcess(agentSpec);
      const termination = yield* Effect.forkChild(managed.terminate(FORCED));

      yield* TestClock.adjust('5 seconds');
      const failure = failureOf(yield* Fiber.await(termination));

      expect(failure).toBeInstanceOf(TerminationFailed);
      expect(failure?.reason).toBe('still-alive');
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });

  it.effect('signals nothing when the whole tree already exited', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const managed = yield* spawnProcess(agentSpec);
      table.exitOnItsOwn(managed.child.pid ?? -1);
      yield* managed.terminate(GRACEFUL);
      expect(table.delivered).toEqual([]);
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });

  it.effect('escalates at once when a forced termination joins a graceful one', () => {
    const table = new FakeProcessTable('linux');
    table.queueSpawn({ ignores: ['SIGTERM'] });
    return Effect.gen(function* () {
      const managed = yield* spawnProcess(agentSpec);
      const leader = managed.child.pid ?? -1;
      const graceful = yield* Effect.forkChild(managed.terminate(GRACEFUL));
      while (table.delivered.length === 0) yield* Effect.yieldNow;

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
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });

  // macOS: kill(-pgid) fails with EPERM while the group's only member is an
  // exited leader Node has not reaped yet; the reap happens during the wait.
  it.effect('waits for an exited, unreaped leader instead of failing on EPERM', () => {
    const table = new FakeProcessTable('darwin');
    return Effect.gen(function* () {
      const managed = yield* spawnProcess(agentSpec);
      const leader = managed.child.pid ?? -1;
      table.exitUnreaped(leader);
      const termination = yield* Effect.forkChild(managed.terminate(GRACEFUL));
      while (table.refused.length === 0) yield* Effect.yieldNow;
      expect(table.refused).toEqual([{ target: -leader, signal: 'SIGTERM' }]);

      table.reap(leader);
      yield* TestClock.adjust(TREE_POLL_INTERVAL);

      expect(Exit.isSuccess(yield* Fiber.await(termination))).toBe(true);
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });

  it.effect('terminates a scoped process when its scope closes', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const pid = yield* Effect.scoped(
        Effect.map(acquireProcess(agentSpec, FORCED), (managed) => managed.child.pid ?? -1)
      );
      expect(table.isAlive(pid)).toBe(false);
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
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
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });

  it.effect('fails the termination when taskkill never finishes', () => {
    const table = new FakeProcessTable('win32');
    return Effect.gen(function* () {
      const managed = yield* spawnProcess(agentSpec);
      table.taskkillHangs = true;
      const termination = yield* Effect.forkChild(managed.terminate(FORCED));

      yield* TestClock.adjust('10 seconds');
      const failure = failureOf(yield* Fiber.await(termination));

      expect(failure).toBeInstanceOf(TerminationFailed);
      expect(failure?.reason).toBe('signal-failed');
      table.taskkillHangs = false;
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
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
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });

  // Windows reuses pids quickly; an exit handler must not taskkill whatever
  // process now holds the exited child's pid.
  it('never runs taskkill for a root that has already exited', () => {
    const table = new FakeProcessTable('win32');
    const child = table.api.spawn('cli', [], {});
    table.exitOnItsOwn(child.pid ?? -1);

    signalChildTreeNow(child, 'SIGKILL', { processGroup: false }, { nodeProcess: table.api });

    expect(table.spawned.filter((call) => call.command === 'taskkill')).toEqual([]);
  });

  it.effect('leaves POSIX detachment to the process group', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      yield* spawnProcess({ ...agentSpec, processGroup: false, windowsDetached: true });
      expect(table.spawned.map((call) => call.options.detached)).toEqual([false]);
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });
});

const readPidLine = (stream: Readable | null) =>
  Effect.callback<number, Error>((resume) => {
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
        expect(isPidAliveSync(grandchild)).toBe(true);

        yield* managed.terminate(FORCED);

        expect(isPidAliveSync(grandchild)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(processLayer({})))
  );

  it.live.skipIf(process.platform === 'win32')(
    'lets a launcher exit while an unrefed child remains alive',
    () =>
      Effect.gen(function* () {
        const managed = yield* acquireProcess(
          {
            command: process.execPath,
            args: [
              '--experimental-strip-types',
              '--no-warnings',
              fileURLToPath(new URL('./fixtures/unref-process.mjs', import.meta.url)),
              fileURLToPath(new URL('../src/node/process.ts', import.meta.url)),
            ],
            options: { stdio: ['ignore', 'pipe', 'ignore'] },
            processGroup: true,
          },
          FORCED
        );
        const childPid = yield* readPidLine(managed.child.stdout);
        const exit = yield* managed.exited.pipe(Effect.timeout('5 seconds'));
        expect(exit.code).toBe(0);
        expect(isPidAliveSync(childPid)).toBe(true);
        yield* managed.terminate(FORCED);
        expect(isPidAliveSync(childPid)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(processLayer({})))
  );

  // Until Node reports a failed spawn, `child.kill()` reaches pid 0: the
  // caller's own process group (the daemon, or Electron main with it).
  it.live.skipIf(process.platform === 'win32')(
    'never signals its own process group when terminating a child that failed to spawn',
    () =>
      Effect.gen(function* () {
        const output = yield* runCommand({
          command: process.execPath,
          args: [
            '--experimental-strip-types',
            '--no-warnings',
            fileURLToPath(new URL('./fixtures/terminate-failed-spawn.mjs', import.meta.url)),
            fileURLToPath(new URL('../src/node/process.ts', import.meta.url)),
          ],
          timeout: '20 seconds',
        });
        expect(output.stdout.toString('utf8').trim()).toBe('survived');
        expect(output.code).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(processLayer({})))
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
      let pid: number | undefined;
      const output = yield* runCommand(
        node('process.stdout.write("out"); process.stderr.write("err"); process.exit(3)', {
          onSpawned: (child) => {
            pid = child.pid;
          },
        })
      );
      expect(pid).toBeGreaterThan(0);
      expect(output.code).toBe(3);
      expect(output.stdout.toString()).toBe('out');
      expect(output.stderr.toString()).toBe('err');
    }).pipe(Effect.scoped, Effect.provide(processLayer({})))
  );

  it.live('pipes input to stdin', () =>
    Effect.gen(function* () {
      const output = yield* runCommandOk(
        node('process.stdin.pipe(process.stdout)', { input: 'hello' })
      );
      expect(output.stdout.toString()).toBe('hello');
    }).pipe(Effect.scoped, Effect.provide(processLayer({})))
  );

  it.live('fails with CommandFailed carrying stderr on a non-zero exit', () =>
    Effect.gen(function* () {
      const failure = failureOf(
        yield* Effect.exit(runCommandOk(node('process.stderr.write("bad ref"); process.exit(128)')))
      );
      expect(failure).toBeInstanceOf(CommandFailed);
      expect(failure instanceof CommandFailed && failure.stderr).toBe('bad ref');
    }).pipe(Effect.scoped, Effect.provide(processLayer({})))
  );

  it.live('fails with SpawnFailed carrying the OS error for a missing executable', () =>
    Effect.gen(function* () {
      const failure = failureOf(
        yield* Effect.exit(runCommand({ command: 'lody-no-such-binary', args: [] }))
      );
      expect(failure).toBeInstanceOf(SpawnFailed);
      expect((failure as SpawnFailed).cause).toMatchObject({ code: 'ENOENT' });
    }).pipe(Effect.scoped, Effect.provide(processLayer({})))
  );

  it.effect('ends the command tree and fails when it outlives its timeout', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const command = yield* Effect.forkChild(
        runCommand({ command: 'git', args: ['fetch'], timeout: '30 seconds' })
      );
      yield* TestClock.adjust('30 seconds');
      const failure = failureOf(yield* Fiber.await(command));

      expect(failure).toBeInstanceOf(CommandTimedOut);
      const pid = table.spawned.length === 1 ? 1000 : -1;
      expect(table.isAlive(pid)).toBe(false);
      // SIGTERM first: a git killed outright leaves its index.lock behind.
      expect(table.delivered).toEqual([{ target: -pid, signal: 'SIGTERM' }]);
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });

  // A read-only probe's caller should not wait out a grace period it has no use for.
  it.effect('skips the SIGTERM grace under a read-only abandon policy', () => {
    const table = new FakeProcessTable('linux');
    table.queueSpawn({ ignores: ['SIGTERM'] });
    return Effect.gen(function* () {
      const command = yield* Effect.forkChild(
        runCommand({
          command: 'sysctl',
          args: [],
          timeout: '1 second',
          abandonPolicy: READ_ONLY_ABANDON_POLICY,
        })
      );
      yield* TestClock.adjust('1 second');
      const failure = failureOf(yield* Fiber.await(command));

      expect(failure).toBeInstanceOf(CommandTimedOut);
      expect(table.delivered.map((delivery) => delivery.signal)).toEqual(['SIGKILL']);
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });

  // The abandoned tree is ended in a scope finalizer, where nothing can be
  // interrupted: the waits there must be bounded without interruption.
  it.effect('still settles when the abandoned tree survives SIGKILL', () => {
    const table = new FakeProcessTable('linux');
    table.queueSpawn({ ignores: ['SIGTERM', 'SIGKILL'] });
    return Effect.gen(function* () {
      const command = yield* Effect.forkChild(
        runCommand({ command: 'git', args: ['fetch'], timeout: '1 second' })
      );
      yield* TestClock.adjust('1 second');
      yield* TestClock.adjust('5 seconds');
      const failure = failureOf(yield* Fiber.await(command));

      expect(failure).toBeInstanceOf(CommandTimedOut);
      expect(table.delivered.map((delivery) => delivery.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });
});

describe('runCommand process-tree ownership', () => {
  it.effect('leaves what a finished command deliberately started running', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const command = yield* Effect.forkChild(runCommand({ command: 'git', args: ['status'] }));
      while (table.spawned.length === 0) yield* Effect.yieldNow;
      const leader = 1000;
      const daemon = table.addDescendant(leader);
      table.exitOnItsOwn(leader);

      yield* Fiber.join(command);

      expect(table.isAlive(daemon)).toBe(true);
      expect(table.delivered).toEqual([]);
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });

  it.effect('fails at once and ends the tree when output exceeds its limit', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const command = yield* Effect.forkChild(
        runCommand({ command: 'git', args: ['log'], maxOutputBytes: 4 })
      );
      while (table.spawned.length === 0) yield* Effect.yieldNow;
      const leader = 1000;
      const child = table.childOf(leader);
      child?.stdout.write(Buffer.from('more than four bytes'));

      const failure = failureOf(yield* Fiber.await(command));

      expect(failure).toBeInstanceOf(CommandOutputTooLarge);
      expect(table.isAlive(leader)).toBe(false);
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });
});

describe('signalChildTreeNow', () => {
  it('signals the whole group before returning, for exit handlers that cannot wait', () => {
    const table = new FakeProcessTable('linux');
    const child = table.api.spawn('cli', [], { detached: true });
    const leader = child.pid ?? -1;
    const descendant = table.addDescendant(leader);

    signalChildTreeNow(child, 'SIGTERM', { processGroup: true }, { nodeProcess: table.api });

    expect(table.delivered).toEqual([{ target: -leader, signal: 'SIGTERM' }]);
    expect(table.isAlive(descendant)).toBe(false);
  });
});

describe('resolveWindowsCommand', () => {
  const files = new Set([
    'C:\\repo\\git.cmd',
    'C:\\repo\\tools\\build.cmd',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
  ]);
  // Windows file names are case-insensitive; PATHEXT entries are upper case.
  const isFile = (filePath: string) =>
    Array.from(files).some((file) => file.toLowerCase() === filePath.toLowerCase());
  const env = {
    Path: 'C:\\Program Files\\Git\\cmd;.;"C:\\Users\\me\\AppData\\Roaming\\npm"',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  };

  // A repository cannot make Lody run its own `git.cmd`.
  it('resolves a bare name from absolute PATH entries only, never the working directory', () => {
    expect(resolveWindowsCommand('git', { cwd: 'C:\\repo', env }, isFile)).toBe(
      'C:\\Program Files\\Git\\cmd\\git.EXE'
    );
    expect(resolveWindowsCommand('claude', { cwd: 'C:\\repo', env }, isFile)).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.CMD'
    );
  });

  it('reports nothing for a command found only in the working directory', () => {
    expect(
      resolveWindowsCommand('git', { cwd: 'C:\\repo', env: { PATHEXT: env.PATHEXT } }, isFile)
    ).toBeNull();
  });

  it('resolves an explicit path against the working directory, and a missing one to nothing', () => {
    expect(resolveWindowsCommand('tools\\build', { cwd: 'C:\\repo', env }, isFile)).toBe(
      'C:\\repo\\tools\\build.CMD'
    );
    expect(
      resolveWindowsCommand(
        'C:\\Program Files\\Microsoft VS Code\\Code.exe',
        { cwd: 'C:\\repo', env },
        isFile
      )
    ).toBeNull();
  });
});

describe('official process service and interruption', () => {
  it.live('runs the official output helper and preserves an explicitly replaced environment', () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const output = yield* spawner.string(
        ChildProcess.make(
          process.execPath,
          ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
          { env: { LODY_TEST_ENV: 'only' }, extendEnv: false }
        )
      );
      const env = JSON.parse(output);
      expect(env.LODY_TEST_ENV).toBe('only');
      expect(env.PATH).toBeUndefined();
      expect(env.HOME).toBeUndefined();
    }).pipe(Effect.provide(processLayer({})))
  );

  it.live('runs an official command pipeline without leaving either process running', () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const output = yield* spawner.string(
        ChildProcess.make(process.execPath, ['-e', 'process.stdout.write("hello")']).pipe(
          ChildProcess.pipeTo(
            ChildProcess.make(process.execPath, [
              '-e',
              'process.stdin.on("data", b => process.stdout.write(b.toString().toUpperCase()))',
            ])
          )
        )
      );
      expect(output).toBe('HELLO');
    }).pipe(Effect.provide(processLayer({})))
  );

  it.effect('interrupting a command waits for its root and orphaned descendant to be gone', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        runCommand({
          command: 'git',
          args: [],
          abandonPolicy: { graceMs: 0, killWaitMs: 0 },
          onSpawned: () => Deferred.doneUnsafe(ready, Effect.void),
        })
      );
      yield* Deferred.await(ready);
      const descendant = table.addDescendant(1000);
      table.exitOnItsOwn(1000);
      yield* Fiber.interrupt(fiber);
      expect(table.isAlive(descendant)).toBe(false);
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });

  it.effect(
    'interrupting an owner releases the process acquired through the scoped spawn API',
    () => {
      const table = new FakeProcessTable('linux');
      return Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const owner = yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* spawnProcess(agentSpec);
            yield* Deferred.succeed(ready, undefined);
            yield* Effect.never;
          }).pipe(Effect.scoped)
        );
        yield* Deferred.await(ready);
        const descendant = table.addDescendant(1000);
        yield* Fiber.interrupt(owner);
        expect(table.isAlive(1000)).toBe(false);
        expect(table.isAlive(descendant)).toBe(false);
      }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
    }
  );

  it.effect('a legacy started process can finish cleanup after its signal is aborted', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const controller = new AbortController();
      const handle = startProcess(agentSpec, { nodeProcess: table.api, signal: controller.signal });
      const descendant = table.addDescendant(1000);
      controller.abort();
      yield* Effect.promise(() => handle.terminate({ graceMs: 0, killWaitMs: 0 }));
      expect(table.isAlive(1000)).toBe(false);
      expect(table.isAlive(descendant)).toBe(false);
    });
  });

  it.effect('the legacy Promise command honors its entry point cancellation signal', () => {
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const controller = new AbortController();
      const result = runCommandText(
        {
          command: 'git',
          args: [],
          check: 'none',
          abandonPolicy: { graceMs: 0, killWaitMs: 0 },
          onSpawned: () => Deferred.doneUnsafe(ready, Effect.void),
        },
        { nodeProcess: table.api, signal: controller.signal }
      ).then(
        () => false,
        () => true
      );
      yield* Deferred.await(ready);
      const descendant = table.addDescendant(1000);
      controller.abort();
      expect(yield* Effect.promise(() => result)).toBe(true);
      expect(table.isAlive(1000)).toBe(false);
      expect(table.isAlive(descendant)).toBe(false);
    });
  });
  it.effect(
    'a failing synchronous owner hook releases the process acquired before the hook',
    () => {
      const table = new FakeProcessTable('linux');
      return Effect.gen(function* () {
        const failure = yield* Effect.exit(
          acquireProcess(
            {
              ...agentSpec,
              onSpawned: () => {
                throw new Error('owner setup failed');
              },
            },
            { graceMs: 0, killWaitMs: 0 }
          )
        );
        expect(Exit.isFailure(failure)).toBe(true);
        expect(table.isAlive(1000)).toBe(false);
      }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
    }
  );
});
