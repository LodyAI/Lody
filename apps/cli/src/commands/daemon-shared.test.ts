import { toShared } from '@/platform/process-options';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startProcess } from '@lody/shared/node/process';

import type { NodeProcessApi } from '@lody/shared/node/process';
import { FakeProcessTable } from '@lody/shared/node/process-testing';
import {
  interpretDaemonRunnerLaunchOutcome,
  readPidFileRecord,
  removePidFile,
  spawnDaemonRunnerAndAwaitReady,
  terminateSpawnedDaemonRunner,
  writePidFile,
} from './daemon-shared';

const tempDirs: string[] = [];

function createPidPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-daemon-owner-'));
  tempDirs.push(dir);
  return path.join(dir, 'daemon.pid');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The fake table's runner, given the fd 3 readiness pipe and `unref` a real
 * detached spawn has. Each spawn's pipe is handed to the test to report on.
 */
function runnerProcessTable(platform: NodeJS.Platform = 'linux') {
  const table = new FakeProcessTable(platform);
  const readyPipes: PassThrough[] = [];
  const api: NodeProcessApi = {
    ...table.api,
    spawn: (command, args, options) => {
      const child = table.api.spawn(command, args, options);
      if (command === 'taskkill') return child;
      const readyPipe = new PassThrough();
      readyPipes.push(readyPipe);
      return Object.assign(child, { stdio: [null, null, null, readyPipe], unref: () => child });
    },
  };
  return { table, api, readyPipes };
}

const runnerSpawns = (table: FakeProcessTable) =>
  table.spawned.filter((call) => call.command !== 'taskkill');

describe('daemon PID ownership', () => {
  it('atomically replaces stale diagnostics after Host ownership is acquired', () => {
    const filePath = createPidPath();
    writePidFile(101, 'stale', 'stale-token', filePath);
    const current = writePidFile(202, 'current', 'current-token', filePath);

    expect(readPidFileRecord(filePath)).toEqual(current);
  });

  it('does not let a stale owner delete a replacement owner record', () => {
    const filePath = createPidPath();
    const stale = writePidFile(101, 'stale', 'stale-token', filePath);
    expect(removePidFile(stale, filePath)).toBe(true);
    const replacement = writePidFile(202, 'replacement', 'replacement-token', filePath);

    expect(removePidFile(stale, filePath)).toBe(false);
    expect(readPidFileRecord(filePath)).toEqual(replacement);
  });

  it('rejects records without the full v1 identity, including legacy numeric files', () => {
    const filePath = createPidPath();
    fs.writeFileSync(filePath, '303', 'utf8');
    expect(readPidFileRecord(filePath)).toBeNull();

    fs.writeFileSync(filePath, JSON.stringify({ version: 1, pid: 303 }), 'utf8');
    expect(readPidFileRecord(filePath)).toBeNull();
  });
});

describe('daemon runner launch cleanup', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it.each(['1.2.2', undefined])(
    'rejects and drains a replacement reporting version %s',
    (cliVersion) => {
      expect(
        interpretDaemonRunnerLaunchOutcome(
          {
            status: 'ready',
            pid: 999_000,
            instanceId: 'replacement',
            cliVersion,
          },
          999_000,
          '1.2.3'
        )
      ).toEqual({
        outcome: {
          status: 'error',
          runnerPid: 999_000,
          message: `Daemon reported version ${cliVersion ?? 'unknown'}; expected 1.2.3`,
        },
        cancelRunner: true,
      });
    }
  );

  it('accepts legacy readiness for ordinary launches without an expected upgrade version', () => {
    expect(
      interpretDaemonRunnerLaunchOutcome(
        {
          status: 'ready',
          pid: 999_000,
          instanceId: 'legacy',
        },
        999_000
      )
    ).toEqual({
      outcome: { status: 'ready', pid: 999_000, instanceId: 'legacy' },
      cancelRunner: false,
    });
  });

  it('awaits a runner that reported startup failure before returning the error', () => {
    expect(
      interpretDaemonRunnerLaunchOutcome(
        { status: 'error', message: 'worker bootstrap failed' },
        999_000
      )
    ).toEqual({
      outcome: {
        status: 'error',
        runnerPid: 999_000,
        message: 'worker bootstrap failed',
      },
      cancelRunner: true,
    });
  });

  it('leaves a ready runner running, detached from the launching terminal', async () => {
    const { table, api, readyPipes } = runnerProcessTable();
    const launch = spawnDaemonRunnerAndAwaitReady([], {
      nodeProcess: api,
      pidFilePath: createPidPath(),
    });
    const [runnerSpawn] = runnerSpawns(table);
    readyPipes[0]?.write(
      `${JSON.stringify({ status: 'ready', pid: 1, instanceId: 'runner-a' })}\n`
    );

    const result = await launch;

    expect(result).toMatchObject({ status: 'ready', instanceId: 'runner-a' });
    const runnerPid = result.status === 'ready' ? result.pid : -1;
    expect(table.isAlive(runnerPid)).toBe(true);
    expect(runnerSpawn?.options).toMatchObject({
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
  });

  it('ends the runner and its Worker when the readiness report is invalid', async () => {
    const { table, api, readyPipes } = runnerProcessTable();
    const launch = spawnDaemonRunnerAndAwaitReady([], {
      nodeProcess: api,
      pidFilePath: createPidPath(),
    });
    const runnerPid = 1000;
    const workerPid = table.addDescendant(runnerPid);
    readyPipes[0]?.write('not json\n');

    const result = await launch;

    expect(result).toEqual({ status: 'error', runnerPid, message: 'invalid readiness report' });
    expect(table.isAlive(runnerPid)).toBe(false);
    expect(table.isAlive(workerPid)).toBe(false);
  });

  it('detaches the runner on Windows too and ends its tree after a failed launch', async () => {
    const { table, api, readyPipes } = runnerProcessTable('win32');
    const launch = spawnDaemonRunnerAndAwaitReady([], {
      nodeProcess: api,
      pidFilePath: createPidPath(),
    });
    readyPipes[0]?.end();

    const result = await launch;

    expect(result).toEqual({ status: 'runner_exited', runnerPid: 1000 });
    expect(runnerSpawns(table)[0]?.options.detached).toBe(true);
    expect(table.isAlive(1000)).toBe(false);
  });

  it('force-kills the runner tree when graceful shutdown does not finish', async () => {
    const table = new FakeProcessTable();
    table.queueSpawn({ ignores: ['SIGTERM'] });
    const runner = startProcess(
      { command: 'runner', args: [], options: {}, processGroup: true },
      toShared({ nodeProcess: table.api })
    );
    const runnerPid = runner.child.pid ?? -1;
    const workerPid = table.addDescendant(runnerPid, { ignores: ['SIGTERM'] });

    const stopped = terminateSpawnedDaemonRunner(runner, runnerPid, {
      shutdownGraceMs: 10,
      forceKillWaitMs: 1_000,
      pidFilePath: createPidPath(),
    });
    await vi.advanceTimersByTimeAsync(1_020);
    expect(await stopped).toBe(true);

    expect(table.isAlive(runnerPid)).toBe(false);
    expect(table.isAlive(workerPid)).toBe(false);
    expect(table.delivered.map((delivery) => delivery.signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports a runner tree that survives SIGKILL instead of claiming it stopped', async () => {
    const table = new FakeProcessTable();
    table.queueSpawn({ ignores: ['SIGTERM', 'SIGKILL'] });
    const runner = startProcess(
      { command: 'runner', args: [], options: {}, processGroup: true },
      toShared({ nodeProcess: table.api })
    );

    const stopped = terminateSpawnedDaemonRunner(runner, runner.child.pid ?? -1, {
      shutdownGraceMs: 0,
      forceKillWaitMs: 10,
      pidFilePath: createPidPath(),
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(await stopped).toBe(false);
  });
});
