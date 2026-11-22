import { toShared } from '@/platform/process-options';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliRuntimeState } from '@lody/shared';
import { startProcessLegacy } from '@lody/shared/node/process';

import type { NodeProcessApi } from '@lody/shared/node/process';
import { FakeProcessTable } from '@lody/shared/node/process-testing';
import { registerDaemonAutostart } from './daemon-autostart';
import { buildDaemonStartPassthroughArgs } from './daemon-start-options';
import { formatDaemonBackendStatus, type DaemonStatusPalette } from './daemon-status-format';
import { releaseScopedMallocArenaLimit, withDaemonMallocArenaLimit } from '@/utils/malloc-arena';
import {
  DAEMON_RUNNER_READY_TIMEOUT_MS,
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

  it('keeps waiting for a slow cold start instead of killing the replacement', async () => {
    const { table, api, readyPipes } = runnerProcessTable();
    const launch = spawnDaemonRunnerAndAwaitReady([], {
      nodeProcess: api,
      pidFilePath: createPidPath(),
    });
    const runnerPid = 1000;
    const workerPid = table.addDescendant(runnerPid);

    // A Worker on a slow machine took about 40 seconds to reach ready.
    await vi.advanceTimersByTimeAsync(45_000);
    readyPipes[0]?.write(
      `${JSON.stringify({ status: 'ready', pid: runnerPid, instanceId: 'slow' })}\n`
    );

    expect(await launch).toMatchObject({ status: 'ready', pid: runnerPid, instanceId: 'slow' });
    expect(table.isAlive(runnerPid)).toBe(true);
    expect(table.isAlive(workerPid)).toBe(true);
  });

  it('ends the runner and its Worker when it never reports readiness', async () => {
    const { table, api } = runnerProcessTable();
    const launch = spawnDaemonRunnerAndAwaitReady([], {
      nodeProcess: api,
      pidFilePath: createPidPath(),
    });
    const runnerPid = 1000;
    const workerPid = table.addDescendant(runnerPid);

    await vi.advanceTimersByTimeAsync(DAEMON_RUNNER_READY_TIMEOUT_MS);

    expect(await launch).toEqual({ status: 'timeout', runnerPid });
    expect(table.isAlive(runnerPid)).toBe(false);
    expect(table.isAlive(workerPid)).toBe(false);
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
    const runner = startProcessLegacy(
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
    const runner = startProcessLegacy(
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

describe('daemon child allocator limit', () => {
  it('caps glibc arenas for daemon Node children without passing the cap to what they launch', () => {
    const childEnv = { ...withDaemonMallocArenaLimit({ PATH: '/bin' }, 'linux') };
    expect(childEnv.MALLOC_ARENA_MAX).toBe('2');

    releaseScopedMallocArenaLimit(childEnv);
    expect(childEnv).toEqual({ PATH: '/bin' });
  });

  it('keeps a caller-chosen limit for the child and everything it launches', () => {
    const childEnv = { ...withDaemonMallocArenaLimit({ MALLOC_ARENA_MAX: '4' }, 'linux') };
    releaseScopedMallocArenaLimit(childEnv);
    expect(childEnv).toEqual({ MALLOC_ARENA_MAX: '4' });
  });

  it('leaves non-glibc platforms untouched', () => {
    expect(withDaemonMallocArenaLimit({ PATH: '/bin' }, 'darwin')).toEqual({ PATH: '/bin' });
  });
});

describe('buildDaemonStartPassthroughArgs', () => {
  it('never forwards auth credentials to the daemon runner', () => {
    expect(
      buildDaemonStartPassthroughArgs({ auth: 'lody_pair_secret', machineName: 'build-host' }, [
        '--debug',
        '--auth',
        'fallback-secret',
        '--auth=inline-secret',
      ])
    ).toEqual(['--machine-name', 'build-host', '--debug']);
  });
});

describe('formatDaemonBackendStatus', () => {
  const palette: DaemonStatusPalette = {
    success: (value) => `<green>${value}</green>`,
    warning: (value) => `<yellow>${value}</yellow>`,
    error: (value) => `<red>${value}</red>`,
    muted: (value) => `<gray>${value}</gray>`,
  };

  const runtimeState = (overrides: Partial<CliRuntimeState> = {}): CliRuntimeState => ({
    schemaVersion: 1,
    phase: 'running',
    pid: 123,
    updatedAtMs: 1,
    issues: [],
    ...overrides,
  });

  it('reports a red error after a connection stays unavailable for one minute', () => {
    expect(
      formatDaemonBackendStatus(
        runtimeState({
          backend: {
            authorization: 'authorized',
            connection: 'connecting',
          },
          connectionAges: {
            backendNotConnectedSinceMs: 60_000,
            workspaceNotConnectedSinceMs: { 'workspace-1': 30_000 },
          },
          connectedWorkspaces: [
            {
              id: 'workspace-1',
              name: 'Alpha',
              slug: 'alpha',
              role: 'owner',
              backendConnection: 'reconnecting',
            },
          ],
        }),
        { palette, nowMs: 120_000 }
      )
    ).toEqual([
      '  Backend Auth: <green>authorized</green>',
      '  Backend Link: <red>connecting (1m)</red>',
      '<red>  Backend Error: not connected for 1m</red>',
      '  Workspaces:   1',
      '    - Alpha (alpha) [owner]',
      '      ID: workspace-1',
      '      Backend: <red>reconnecting (1m 30s)</red>',
      '<red>      Error: not connected for 1m 30s</red>',
    ]);
  });

  it('does not claim backend state for an older daemon payload', () => {
    expect(formatDaemonBackendStatus(runtimeState(), { palette })).toEqual([
      '  Backend Auth: <gray>unknown</gray>',
      '  Backend Link: <gray>unknown</gray>',
      '  Workspaces:   <gray>unavailable</gray>',
    ]);
  });
});

describe('registerDaemonAutostart', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true }))
    );
  });

  async function autostartFixture() {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'lody-install-service-'));
    roots.push(home);
    return {
      home,
      dataDir: path.join(home, 'data with & spaces'),
      service: path.join(home, 'data with & spaces', 'service'),
    };
  }

  it('registers the fixed absolute Mac entry for next login, preserves the installation profile and never starts another host', async () => {
    const options = await autostartFixture();
    const result = await registerDaemonAutostart({
      ...options,
      platform: 'darwin',
      run: async () => {
        throw new Error('Must not spawn on registration');
      },
    });
    const directory = path.join(options.home, 'Library', 'LaunchAgents');
    const files = await fsp.readdir(directory);
    const file = path.join(directory, files[0] ?? '');
    const installed = await fsp.readFile(file, 'utf8');
    expect(installed).toContain('data with &amp; spaces');
    expect(installed).toContain('<string>daemon-runner</string>');
    expect(result).toContain('Login autostart registered');
    await registerDaemonAutostart({ ...options, platform: 'darwin' });
    expect(await fsp.readFile(file, 'utf8')).toBe(installed);
    await fsp.writeFile(file, 'user-owned configuration');
    await expect(registerDaemonAutostart({ ...options, platform: 'darwin' })).rejects.toThrow(
      /preserved/
    );
    expect(await fsp.readFile(file, 'utf8')).toBe('user-owned configuration');
  });

  it('enables a user Linux unit without starting it, preserves percent/space paths, and leaves unavailable managers recoverable', async () => {
    const options = await autostartFixture();
    options.dataDir += '%profile';
    const commands: string[][] = [];
    await registerDaemonAutostart({
      ...options,
      platform: 'linux',
      run: async (command, args) => {
        commands.push([command, ...args]);
      },
    });
    const directory = path.join(options.home, '.config', 'systemd', 'user');
    const [name] = await fsp.readdir(directory);
    expect(await fsp.readFile(path.join(directory, name ?? ''), 'utf8')).toContain('%%profile');
    expect(commands).toEqual([
      ['systemctl', '--user', 'show', '--property=Version', '--value'],
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', name],
    ]);
    const unavailable = await autostartFixture();
    await expect(
      registerDaemonAutostart({
        ...unavailable,
        platform: 'linux',
        run: async () => {
          throw new Error('No user bus');
        },
      })
    ).rejects.toThrow('No user bus');
    await expect(fsp.access(path.join(unavailable.home, '.config'))).rejects.toThrow();
  });
});
