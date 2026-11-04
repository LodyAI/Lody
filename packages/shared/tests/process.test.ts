import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit, Option } from 'effect';

import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { runCommand } from '../src/node/process';
import { signalChildTreeNowLegacy } from '../src/node/process';
import { spawnProcess as acquireProcess, type SpawnSpec } from '../src/node/process';
import { processLayer, isPidAliveSyncLegacy } from '../src/node/process';
import { nodeProcessLive, resolveWindowsCommand } from '../src/node/process';
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

describe('process tree termination (Windows)', () => {
  // Windows reuses pids quickly; an exit handler must not taskkill whatever
  // process now holds the exited child's pid.
  it('never runs taskkill for a root that has already exited', () => {
    const table = new FakeProcessTable('win32');
    const child = table.api.spawn('cli', [], {});
    table.exitOnItsOwn(child.pid ?? -1);

    signalChildTreeNowLegacy(child, 'SIGKILL', { processGroup: false }, { nodeProcess: table.api });

    expect(table.spawned.filter((call) => call.command === 'taskkill')).toEqual([]);
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
        expect(isPidAliveSyncLegacy(grandchild)).toBe(true);

        yield* managed.terminate(FORCED);

        expect(isPidAliveSyncLegacy(grandchild)).toBe(false);
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
        expect(isPidAliveSyncLegacy(childPid)).toBe(true);
        yield* managed.terminate(FORCED);
        expect(isPidAliveSyncLegacy(childPid)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(processLayer({})))
  );

  // Session termination walks this table to reach commands that called setsid.
  it.live.skipIf(process.platform === 'win32')(
    'lists a real setsid child with its parent and its own group',
    () =>
      Effect.gen(function* () {
        const managed = yield* spawnProcess({
          command: 'perl',
          args: [
            '-MPOSIX',
            '-e',
            // The child reports its pid only after setsid, so the scan cannot see it mid-way.
            '$| = 1; if (!fork) { POSIX::setsid(); print "$$\\n"; exec "sleep", "30" } sleep 30',
          ],
          options: { stdio: ['ignore', 'pipe', 'ignore'] },
          processGroup: true,
        });
        const escaped = yield* readPidLine(managed.child.stdout);
        const parent = managed.child.pid ?? -1;

        const entries = nodeProcessLive.listProcesses?.() ?? [];

        expect(entries.find((entry) => entry.pid === parent)).toMatchObject({ pgid: parent });
        expect(entries.find((entry) => entry.pid === escaped)).toEqual({
          pid: escaped,
          ppid: parent,
          pgid: escaped,
          zombie: false,
        });
        nodeProcessLive.kill(escaped, 'SIGKILL');
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
});
