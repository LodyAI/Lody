import { EventEmitter } from 'events';
import path from 'path';
import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import realSpawn from 'cross-spawn';
import type { SessionId } from '@lody/shared';

import {
  calculateAutomaticSessionSandboxLimits,
  createSessionSandboxFactory,
} from '../src/session/session-sandbox';
import {
  applyProcessResourceProfile,
  EXECUTION_PLANE_RESOURCE_PROFILE,
} from '../src/utils/process-resource-profile';
import type { Logger } from '../src/utils/logger';

const createSilentLogger = (warnings: string[] = []): Logger => ({
  info: () => {},
  warn: (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  },
  error: () => {},
  success: () => {},
  debug: (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  },
  setLevel: () => {},
  child: () => createSilentLogger(warnings),
  close: async () => {},
});

class FakeChildProcess extends EventEmitter {
  pid: number;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => {
    this.killed = true;
    return true;
  });

  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

class FakeCgroupFs {
  private readonly dirs = new Set<string>();
  private readonly files = new Map<string, string>();

  constructor(private readonly cgroupMount: string) {
    this.ensureDir(this.cgroupMount);
    this.files.set(path.join(this.cgroupMount, 'cgroup.controllers'), 'cpu memory pids\n');
    this.ensureDir(path.join(this.cgroupMount, 'system.slice'));
    this.ensureDir(path.join(this.cgroupMount, 'system.slice', 'lody.service'));
  }

  async access(target: string): Promise<void> {
    const normalized = this.normalize(target);
    if (this.dirs.has(normalized) || this.files.has(normalized)) {
      return;
    }
    throw this.createNotFoundError(normalized);
  }

  async mkdir(target: string, options?: { recursive?: boolean }): Promise<void> {
    const normalized = this.normalize(target);
    if (!options?.recursive) {
      this.ensureDir(normalized);
      return;
    }

    let current = path.isAbsolute(normalized) ? path.sep : '';
    for (const part of normalized.split(path.sep).filter(Boolean)) {
      current = current ? path.join(current, part) : part;
      this.ensureDir(current);
    }
  }

  async readFile(target: string, encoding?: BufferEncoding): Promise<string | Buffer> {
    const normalized = this.normalize(target);
    const value = this.files.get(normalized);
    if (value === undefined) {
      throw this.createNotFoundError(normalized);
    }
    if (encoding) {
      return value;
    }
    return Buffer.from(value);
  }

  async writeFile(target: string, value: string): Promise<void> {
    const normalized = this.normalize(target);
    if (path.basename(normalized) === 'cgroup.procs') {
      const trimmed = value.trim();
      const existing = (this.files.get(normalized) ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const merged = Array.from(new Set(trimmed ? [...existing, trimmed] : existing));
      this.files.set(normalized, merged.length > 0 ? `${merged.join('\n')}\n` : '');
      return;
    }

    this.files.set(normalized, value);
    if (path.basename(normalized) === 'cgroup.kill' && value.trim() === '1') {
      this.files.set(path.join(path.dirname(normalized), 'cgroup.procs'), '');
    }
  }

  async rmdir(target: string): Promise<void> {
    const normalized = this.normalize(target);
    this.dirs.delete(normalized);
    for (const key of Array.from(this.files.keys())) {
      if (key === normalized || key.startsWith(`${normalized}${path.sep}`)) {
        this.files.delete(key);
      }
    }
  }

  hasDir(target: string): boolean {
    return this.dirs.has(this.normalize(target));
  }

  readText(target: string): string {
    return this.files.get(this.normalize(target)) ?? '';
  }

  writeText(target: string, value: string): void {
    this.files.set(this.normalize(target), value);
  }

  private ensureDir(target: string): void {
    const normalized = this.normalize(target);
    if (this.dirs.has(normalized)) {
      return;
    }
    this.dirs.add(normalized);
    if (normalized.startsWith(this.cgroupMount)) {
      this.ensureCgroupControlFiles(normalized);
    }
  }

  private ensureCgroupControlFiles(target: string): void {
    const dir = this.normalize(target);
    const defaults: Array<[string, string]> = [
      [path.join(dir, 'cgroup.procs'), ''],
      [path.join(dir, 'cgroup.kill'), ''],
      [path.join(dir, 'memory.max'), 'max\n'],
      [path.join(dir, 'memory.high'), 'max\n'],
      [path.join(dir, 'memory.events'), 'max 0\noom 0\noom_kill 0\noom_group_kill 0\n'],
      [path.join(dir, 'memory.oom.group'), '0\n'],
      [path.join(dir, 'cpu.max'), 'max 100000\n'],
      [path.join(dir, 'pids.max'), 'max\n'],
      [path.join(dir, 'pids.events'), 'max 0\n'],
    ];

    for (const [filePath, value] of defaults) {
      if (!this.files.has(filePath)) {
        this.files.set(filePath, value);
      }
    }
  }

  private normalize(target: string): string {
    return path.normalize(target);
  }

  private createNotFoundError(target: string): Error & { code: string } {
    const error = new Error(`ENOENT: ${target}`) as Error & { code: string };
    error.code = 'ENOENT';
    return error;
  }
}

describe('session sandbox', () => {
  it.skipIf(process.platform !== 'win32')(
    'cleans a buffered real spawn failure without signaling a nonexistent child',
    async () => {
      const factory = createSessionSandboxFactory({
        logger: createSilentLogger(),
        deps: {
          platform: 'win32',
          spawnProcess: realSpawn,
          configureExecutionProcess: vi.fn(async () => {}),
        },
      });
      const sandbox = await factory('windows-spawn-failure' as SessionId);
      const handle = await sandbox.spawn(`lody-missing-${randomUUID()}.exe`, [], {
        cwd: process.cwd(),
        stdio: 'ignore',
      });
      const failure = await new Promise<Error>((resolve) => handle.onError(resolve));
      expect(failure).toMatchObject({ code: 'ENOENT' });
      const kill = vi.spyOn(handle.child, 'kill');
      await handle.terminate(false);
      await sandbox.terminate(true);
      expect(kill).not.toHaveBeenCalled();
      expect(await sandbox.readResourceAccounting()).toMatchObject({ rootPids: [] });
    }
  );
  it('awaits Windows child exit through the retained handle', async () => {
    const child = new FakeChildProcess(1234);
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess) as typeof realSpawn;
    const factory = createSessionSandboxFactory({
      logger: createSilentLogger(),
      deps: { platform: 'win32', spawnProcess, configureExecutionProcess: vi.fn(async () => {}) },
    });
    const sandbox = await factory('windows-child' as SessionId);
    const handle = await sandbox.spawn('node', [], {
      cwd: process.cwd(),
      env: {},
      stdio: 'ignore',
    });
    const settled = vi.fn();
    const termination = handle.terminate(true).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await termination;
  });

  it('never signals an exited Windows child', async () => {
    const child = new FakeChildProcess(1234);
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess) as typeof realSpawn;
    const factory = createSessionSandboxFactory({
      logger: createSilentLogger(),
      deps: { platform: 'win32', spawnProcess, configureExecutionProcess: vi.fn(async () => {}) },
    });
    const sandbox = await factory('windows-exited' as SessionId);
    const handle = await sandbox.spawn('node', [], {
      cwd: process.cwd(),
      env: {},
      stdio: 'ignore',
    });
    child.signalCode = 'SIGTERM';
    child.emit('exit', null, 'SIGTERM');
    await handle.terminate(true);
    await sandbox.terminate(true);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('attempts every Windows root and retains a failed handle for retry', async () => {
    const first = new FakeChildProcess(1234);
    const second = new FakeChildProcess(2345);
    first.kill.mockImplementation(() => {
      first.emit('error', new Error('kill failed'));
      return false;
    });
    second.kill.mockImplementation(() => {
      second.exitCode = 0;
      second.emit('exit', 0, null);
      return true;
    });
    const spawnProcess = vi.fn(
      (command: string) => (command === 'first' ? first : second) as unknown as ChildProcess
    ) as typeof realSpawn;
    const factory = createSessionSandboxFactory({
      logger: createSilentLogger(),
      deps: { platform: 'win32', spawnProcess, configureExecutionProcess: vi.fn(async () => {}) },
    });
    const sandbox = await factory('windows-multiple' as SessionId);
    for (const command of ['first', 'second']) {
      await sandbox.spawn(command, [], { cwd: process.cwd(), env: {}, stdio: 'ignore' });
    }
    await expect(sandbox.terminate(true)).rejects.toThrow(
      'Session process tree termination failed'
    );
    expect(first.kill).toHaveBeenCalledOnce();
    expect(second.kill).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(await sandbox.readResourceAccounting()).toMatchObject({ rootPids: [1234] });
    first.kill.mockImplementation(() => {
      first.exitCode = 0;
      first.emit('exit', 0, null);
      return true;
    });
    await sandbox.terminate(true);
    expect(first.kill).toHaveBeenCalledTimes(2);
    expect(await sandbox.readResourceAccounting()).toMatchObject({ rootPids: [] });
  });
  it('applies process resource profiles on Linux', async () => {
    const setPriority = vi.fn();
    const writeFile = vi.fn(async () => {});

    await applyProcessResourceProfile(
      1234,
      { nice: 0, oomScoreAdj: 1200 },
      {
        label: 'test process',
        deps: {
          platform: 'linux',
          setPriority,
          writeFile,
        },
      }
    );

    expect(setPriority).toHaveBeenCalledWith(1234, 0);
    expect(writeFile).toHaveBeenCalledWith('/proc/1234/oom_score_adj', '1000\n');
  });

  it('skips process resource profiles outside Linux', async () => {
    const setPriority = vi.fn();
    const writeFile = vi.fn(async () => {});

    await applyProcessResourceProfile(1234, EXECUTION_PLANE_RESOURCE_PROFILE, {
      label: 'test process',
      deps: {
        platform: 'darwin',
        setPriority,
        writeFile,
      },
    });

    expect(setPriority).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('derives per-session limits from 75% of machine memory and CPU capacity', () => {
    const limits = calculateAutomaticSessionSandboxLimits(
      {
        totalMemoryBytes: 16 * 1024 * 1024 * 1024,
        totalCpuCount: 8,
      },
      2
    );

    expect(limits).toEqual({
      memoryMaxBytes: Math.floor((16 * 1024 * 1024 * 1024 * 0.75) / 2),
      cpuMax: '300000 100000',
      pidsMax: 1024,
    });
  });

  it('initializes a Linux cgroup sandbox, writes limits, and detects memory kills', async () => {
    const cgroupMount = path.join(path.sep, 'mock', 'sys', 'fs', 'cgroup');
    const fakeFs = new FakeCgroupFs(cgroupMount);
    const child = new FakeChildProcess(4321);
    const configureExecutionProcess = vi.fn(async () => {});

    const factory = createSessionSandboxFactory({
      logger: createSilentLogger(),
      deps: {
        platform: 'linux',
        cgroupMount,
        fs: fakeFs,
        spawnProcess: (() => child as unknown as ChildProcess) as typeof realSpawn,
        readSelfCgroupPath: async () => '/system.slice/lody.service',
        configureExecutionProcess,
        killPid: vi.fn(),
        sleep: async () => {},
      },
    });

    const sandbox = await factory('session-1' as SessionId);
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.description).toBe('linux-cgroup-v2');

    await sandbox.applyLimits({
      memoryMaxBytes: 256 * 1024 * 1024,
      memoryHighBytes: 192 * 1024 * 1024,
      cpuMax: '200000 100000',
      pidsMax: 64,
    });

    const handle = await sandbox.spawn('bash', ['-lc', 'node'], { cwd: process.cwd(), env: {} });
    const sessionDir = path.join(
      cgroupMount,
      'system.slice',
      'lody.service',
      'lody-sessions',
      'lody-session-session-1'
    );

    expect(fakeFs.readText(path.join(sessionDir, 'memory.max'))).toBe(`${256 * 1024 * 1024}\n`);
    expect(fakeFs.readText(path.join(sessionDir, 'memory.high'))).toBe(`${192 * 1024 * 1024}\n`);
    expect(fakeFs.readText(path.join(sessionDir, 'cpu.max'))).toBe('200000 100000\n');
    expect(fakeFs.readText(path.join(sessionDir, 'pids.max'))).toBe('64\n');
    expect(fakeFs.readText(path.join(sessionDir, 'memory.oom.group'))).toBe('1\n');
    expect(configureExecutionProcess).toHaveBeenCalledWith(4321, expect.any(Object));
    expect(fakeFs.readText(path.join(sessionDir, 'cgroup.procs'))).toContain('4321');

    fakeFs.writeText(path.join(sessionDir, 'memory.events'), 'max 1\noom 1\noom_kill 1\n');

    const violation = await handle.inspectExit(null, 'SIGKILL');
    expect(violation).toEqual({
      kind: 'memory',
      message: 'Session exceeded memory.max (256 MiB) and was killed by the kernel',
    });

    await sandbox.terminate(true);
    expect(fakeFs.readText(path.join(sessionDir, 'cgroup.kill'))).toBe('1\n');

    await sandbox.cleanup();
    expect(fakeFs.hasDir(sessionDir)).toBe(false);
  });

  it('replays buffered exit and close events when the process exits during cgroup attach', async () => {
    const cgroupMount = path.join(path.sep, 'mock', 'sys', 'fs', 'cgroup');
    const fakeFs = new FakeCgroupFs(cgroupMount);
    const child = new FakeChildProcess(5432);
    const originalWriteFile = fakeFs.writeFile.bind(fakeFs);
    fakeFs.writeFile = vi.fn(async (target: string, value: string) => {
      if (path.basename(target) === 'cgroup.procs') {
        child.exitCode = 0;
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      }
      await originalWriteFile(target, value);
    });

    const factory = createSessionSandboxFactory({
      logger: createSilentLogger(),
      deps: {
        platform: 'linux',
        cgroupMount,
        fs: fakeFs,
        spawnProcess: (() => child as unknown as ChildProcess) as typeof realSpawn,
        readSelfCgroupPath: async () => '/system.slice/lody.service',
        configureExecutionProcess: vi.fn(async () => {}),
        killPid: vi.fn(),
        sleep: async () => {},
      },
    });

    const sandbox = await factory('session-buffered-events' as SessionId);
    await sandbox.applyLimits({
      memoryMaxBytes: 128 * 1024 * 1024,
      cpuMax: '100000 100000',
      pidsMax: 64,
    });

    const handle = await sandbox.spawn('bash', ['-lc', 'exit 0'], {
      cwd: process.cwd(),
      env: {},
    });
    const onExit = vi.fn();
    const onClose = vi.fn();

    handle.onExit(onExit);
    handle.onClose(onClose);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onExit).toHaveBeenCalledWith(0, null);
    expect(onClose).toHaveBeenCalledWith(0, null);
  });

  it('ignores ESRCH when the process exits before cgroup attachment completes', async () => {
    const cgroupMount = path.join(path.sep, 'mock', 'sys', 'fs', 'cgroup');
    const fakeFs = new FakeCgroupFs(cgroupMount);
    const child = new FakeChildProcess(6543);
    const originalWriteFile = fakeFs.writeFile.bind(fakeFs);
    fakeFs.writeFile = vi.fn(async (target: string, value: string) => {
      if (path.basename(target) === 'cgroup.procs') {
        child.exitCode = 0;
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
        const error = new Error('ESRCH: process already exited') as Error & { code: string };
        error.code = 'ESRCH';
        throw error;
      }
      await originalWriteFile(target, value);
    });

    const factory = createSessionSandboxFactory({
      logger: createSilentLogger(),
      deps: {
        platform: 'linux',
        cgroupMount,
        fs: fakeFs,
        spawnProcess: (() => child as unknown as ChildProcess) as typeof realSpawn,
        readSelfCgroupPath: async () => '/system.slice/lody.service',
        configureExecutionProcess: vi.fn(async () => {}),
        killPid: vi.fn(),
        sleep: async () => {},
      },
    });

    const sandbox = await factory('session-esrch-attach' as SessionId);
    await sandbox.applyLimits({
      memoryMaxBytes: 128 * 1024 * 1024,
      cpuMax: '100000 100000',
      pidsMax: 64,
    });

    const handle = await sandbox.spawn('bash', ['-lc', 'true'], {
      cwd: process.cwd(),
      env: {},
    });
    const onExit = vi.fn();
    const onClose = vi.fn();

    handle.onExit(onExit);
    handle.onClose(onClose);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onExit).toHaveBeenCalledWith(0, null);
    expect(onClose).toHaveBeenCalledWith(0, null);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('falls back to a noop sandbox on non-Linux hosts and logs a diagnostic', async () => {
    const warnings: string[] = [];
    const child = new FakeChildProcess(9876);

    const factory = createSessionSandboxFactory({
      logger: createSilentLogger(warnings),
      deps: {
        platform: 'darwin',
        spawnProcess: (() => child as unknown as ChildProcess) as typeof realSpawn,
      },
    });

    const sandbox = await factory('session-2' as SessionId);
    expect(sandbox.enabled).toBe(false);
    expect(sandbox.description).toBe('unsupported-platform:darwin');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('only supported on Linux');
  });

  it('uses process-group tree kill for noop sandbox processes on POSIX hosts', async () => {
    const killPid = vi.fn();
    const configureExecutionProcess = vi.fn(async () => {});
    const child = new FakeChildProcess(2468);
    const spawnProcess = vi.fn(
      (_command: string, _args: string[], _options: unknown) => child as unknown as ChildProcess
    ) as typeof realSpawn;

    const factory = createSessionSandboxFactory({
      logger: createSilentLogger(),
      deps: {
        platform: 'darwin',
        spawnProcess,
        configureExecutionProcess,
        killPid,
      },
    });

    const sandbox = await factory('session-noop-tree-kill' as SessionId);
    const handle = await sandbox.spawn('bash', ['-lc', 'node'], {
      cwd: process.cwd(),
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      'bash',
      ['-lc', 'node'],
      expect.objectContaining({ detached: true })
    );
    expect(configureExecutionProcess).toHaveBeenCalledWith(2468, expect.any(Object));

    await handle.terminate(false);
    await sandbox.terminate(true);

    expect(killPid).toHaveBeenNthCalledWith(1, -2468, 'SIGTERM');
    expect(killPid).toHaveBeenNthCalledWith(2, -2468, 'SIGKILL');
  });

  it('buffers noop sandbox exits that happen while applying process resource profiles', async () => {
    const cgroupMount = path.join(path.sep, 'mock', 'sys', 'fs', 'cgroup');
    const missingCgroupMount = path.join(path.sep, 'missing', 'sys', 'fs', 'cgroup');
    const fakeFs = new FakeCgroupFs(cgroupMount);
    const child = new FakeChildProcess(7531);
    const configureExecutionProcess = vi.fn(async () => {
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    });
    const factory = createSessionSandboxFactory({
      logger: createSilentLogger(),
      deps: {
        platform: 'linux',
        cgroupMount: missingCgroupMount,
        fs: fakeFs,
        spawnProcess: (() => child as unknown as ChildProcess) as typeof realSpawn,
        configureExecutionProcess,
        killPid: vi.fn(),
        sleep: async () => {},
      },
    });

    const sandbox = await factory('session-noop-exit-buffer' as SessionId);
    const handle = await sandbox.spawn('bash', ['-lc', 'true'], {
      cwd: process.cwd(),
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exitEvents: unknown[] = [];
    const closeEvents: unknown[] = [];

    handle.onExit((exitCode, signal) => exitEvents.push([exitCode, signal]));
    handle.onClose((exitCode, signal) => closeEvents.push([exitCode, signal]));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(configureExecutionProcess).toHaveBeenCalledWith(7531, expect.any(Object));
    expect(exitEvents).toEqual([[0, null]]);
    expect(closeEvents).toEqual([[0, null]]);
  });

  it('removes exited noop sandbox processes from later tree-kill passes', async () => {
    const killPid = vi.fn();
    const child = new FakeChildProcess(1357);
    const factory = createSessionSandboxFactory({
      logger: createSilentLogger(),
      deps: {
        platform: 'darwin',
        spawnProcess: (() => child as unknown as ChildProcess) as typeof realSpawn,
        configureExecutionProcess: vi.fn(async () => {}),
        killPid,
      },
    });

    const sandbox = await factory('session-noop-cleanup' as SessionId);
    await sandbox.spawn('bash', ['-lc', 'exit 0'], {
      cwd: process.cwd(),
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);

    await sandbox.terminate(true);

    expect(killPid).not.toHaveBeenCalled();
  });

  it('continues when execution process resource profile application fails', async () => {
    const cgroupMount = path.join(path.sep, 'mock', 'sys', 'fs', 'cgroup');
    const fakeFs = new FakeCgroupFs(cgroupMount);
    const child = new FakeChildProcess(6789);
    const warnings: string[] = [];

    const factory = createSessionSandboxFactory({
      logger: createSilentLogger(warnings),
      deps: {
        platform: 'linux',
        cgroupMount,
        fs: fakeFs,
        spawnProcess: (() => child as unknown as ChildProcess) as typeof realSpawn,
        readSelfCgroupPath: async () => '/system.slice/lody.service',
        configureExecutionProcess: vi.fn(async () => {
          throw new Error('profile failed');
        }),
        killPid: vi.fn(),
        sleep: async () => {},
      },
    });

    const sandbox = await factory('session-profile-fail' as SessionId);
    await sandbox.spawn('bash', ['-lc', 'node'], { cwd: process.cwd(), env: {} });
    const sessionDir = path.join(
      cgroupMount,
      'system.slice',
      'lody.service',
      'lody-sessions',
      'lody-session-session-profile-fail'
    );

    expect(fakeFs.readText(path.join(sessionDir, 'cgroup.procs'))).toContain('6789');
    expect(warnings.join('\n')).toContain(
      'Failed to apply execution-plane process resource profile'
    );
  });

  describe('captureOutput', () => {
    // spawn() does async post-spawn work, so a short-lived child can finish
    // before the caller ever receives the handle. Real regression: `git branch
    // --show-current` resolved to '' and PR detection reported "detached HEAD".
    const spawnWithOutputBeforeHandle = async (options: { captureOutput?: boolean }) => {
      const child = new FakeChildProcess(4321);
      const factory = createSessionSandboxFactory({
        logger: createSilentLogger(),
        deps: {
          platform: 'darwin',
          spawnProcess: (() => child as unknown as ChildProcess) as typeof realSpawn,
          configureExecutionProcess: async () => {
            // The child runs to completion while spawn() is still working.
            child.stdout.emit('data', Buffer.from('feature/branch\n'));
            child.stderr.emit('data', Buffer.from('warning\n'));
            child.emit('close', 0, null);
          },
          killPid: vi.fn(),
        },
      });
      const sandbox = await factory('session-capture' as SessionId);
      const handle = await sandbox.spawn('git', ['branch', '--show-current'], {
        cwd: process.cwd(),
        env: {},
        ...options,
      });
      return { child, handle };
    };

    it('replays output produced before the caller subscribed', async () => {
      const { handle } = await spawnWithOutputBeforeHandle({ captureOutput: true });

      const stdout: string[] = [];
      const stderr: string[] = [];
      handle.onStdout((chunk) => stdout.push(chunk.toString()));
      handle.onStderr((chunk) => stderr.push(chunk.toString()));

      expect(stdout.join('')).toBe('feature/branch\n');
      expect(stderr.join('')).toBe('warning\n');
    });

    it('keeps delivering output after the replay, and stops on unsubscribe', async () => {
      const { child, handle } = await spawnWithOutputBeforeHandle({ captureOutput: true });

      const stdout: string[] = [];
      const unsubscribe = handle.onStdout((chunk) => stdout.push(chunk.toString()));
      child.stdout.emit('data', Buffer.from('trailing\n'));
      unsubscribe();
      child.stdout.emit('data', Buffer.from('after-unsubscribe\n'));

      expect(stdout.join('')).toBe('feature/branch\ntrailing\n');
    });

    // Consumers apply their own limits only once they subscribe (a terminal
    // retains 1 MiB), so the bridge buffer must not grow without bound while a
    // noisy command runs through a slow post-spawn setup.
    it('caps what it holds before subscription, keeping the newest output', async () => {
      const child = new FakeChildProcess(4321);
      const chunk = Buffer.alloc(1024 * 1024, 'a');
      const factory = createSessionSandboxFactory({
        logger: createSilentLogger(),
        deps: {
          platform: 'darwin',
          spawnProcess: (() => child as unknown as ChildProcess) as typeof realSpawn,
          configureExecutionProcess: async () => {
            // 9 MiB through a 4 MiB bridge.
            for (let i = 0; i < 8; i += 1) {
              child.stdout.emit('data', chunk);
            }
            child.stdout.emit('data', Buffer.from('tail-marker'));
          },
          killPid: vi.fn(),
        },
      });
      const sandbox = await factory('session-capture-cap' as SessionId);
      const handle = await sandbox.spawn('noisy', [], {
        cwd: process.cwd(),
        env: {},
        captureOutput: true,
      });

      let bytes = 0;
      let tail = '';
      handle.onStdout((received) => {
        bytes += received.length;
        tail = received.toString('utf8', Math.max(0, received.length - 11));
      });

      expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(bytes).toBeGreaterThan(0);
      expect(tail).toBe('tail-marker');
    });

    it('does not buffer without captureOutput, so long-lived stdio stays streaming', async () => {
      const { child, handle } = await spawnWithOutputBeforeHandle({});

      const stdout: string[] = [];
      handle.onStdout((chunk) => stdout.push(chunk.toString()));
      expect(stdout).toEqual([]);

      child.stdout.emit('data', Buffer.from('live\n'));
      expect(stdout.join('')).toBe('live\n');
    });
  });
});
