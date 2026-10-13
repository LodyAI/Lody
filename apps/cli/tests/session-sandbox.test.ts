import { EventEmitter } from 'events';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';
import { it as effectIt } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { ChildProcessSpawner } from 'effect/process';
import { processLayer, ProcessReleaseFailed, TerminationFailed } from '@lody/shared/node/process';
import { makeCgroupContainer } from '../src/platform/sandbox/cgroup-container';
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
import { FakeProcessTable } from '@lody/shared/node/process-testing';

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
      // cgroup.kill ends the whole subtree, nested cgroups included.
      this.files.set(path.join(path.dirname(normalized), 'cgroup.procs'), '');
      this.files.set(
        path.join(path.dirname(normalized), 'cgroup.events'),
        'populated 0\nfrozen 0\n'
      );
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
      [path.join(dir, 'cgroup.events'), 'populated 0\nfrozen 0\n'],
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
  it('applies process resource profiles on Linux', async () => {
    const priorities = new Map<number, number>();
    const files = new Map<string, string>();
    const setPriority = (pid: number, priority: number) => {
      priorities.set(pid, priority);
    };
    const writeFile = async (target: string, value: string) => {
      files.set(target, value);
    };

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

    expect(priorities.get(1234)).toBe(0);
    expect(files.get('/proc/1234/oom_score_adj')).toBe('1000\n');
  });

  it('skips process resource profiles outside Linux', async () => {
    const priorities = new Map<number, number>();
    const files = new Map<string, string>();
    const setPriority = (pid: number, priority: number) => {
      priorities.set(pid, priority);
    };
    const writeFile = async (target: string, value: string) => {
      files.set(target, value);
    };

    await applyProcessResourceProfile(1234, EXECUTION_PLANE_RESOURCE_PROFILE, {
      label: 'test process',
      deps: {
        platform: 'darwin',
        setPriority,
        writeFile,
      },
    });

    expect(priorities.size).toBe(0);
    expect(files.size).toBe(0);
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
    const table = new FakeProcessTable('linux');
    const configureExecutionProcess = vi.fn(async () => {});

    const factory = createSessionSandboxFactory({
      logger: createSilentLogger(),
      deps: {
        platform: 'linux',
        cgroupMount,
        fs: fakeFs,
        spawnProcess: table.api.spawn,
        readSelfCgroupPath: async () => '/system.slice/lody.service',
        configureExecutionProcess,
        killPid: (pid, signal) => table.api.kill(pid, signal ?? 'SIGTERM'),
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
    const leader = handle.child.pid!;
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
    expect(configureExecutionProcess).toHaveBeenCalledWith(leader, expect.any(Object));
    expect(fakeFs.readText(path.join(sessionDir, 'cgroup.procs'))).toContain(String(leader));

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

  // A session process may move itself into a nested cgroup; cgroup.procs then
  // lists nobody, but the subtree is still populated.
  it('kills members of nested cgroups under a forced terminate', async () => {
    const cgroupMount = path.join(path.sep, 'mock', 'sys', 'fs', 'cgroup');
    const fakeFs = new FakeCgroupFs(cgroupMount);
    const sandbox = await createSessionSandboxFactory({
      logger: createSilentLogger(),
      deps: {
        platform: 'linux',
        cgroupMount,
        fs: fakeFs,
        readSelfCgroupPath: async () => '/system.slice/lody.service',
        configureExecutionProcess: vi.fn(async () => {}),
        killPid: vi.fn(),
      },
    })('session-1' as SessionId);
    const sessionDir = path.join(
      cgroupMount,
      'system.slice',
      'lody.service',
      'lody-sessions',
      'lody-session-session-1'
    );
    fakeFs.writeText(path.join(sessionDir, 'cgroup.events'), 'populated 1\nfrozen 0\n');

    await sandbox.terminate(true);

    expect(fakeFs.readText(path.join(sessionDir, 'cgroup.events'))).toContain('populated 0');
  });

  it('refuses to start a process once cleanup has removed the session cgroup', async () => {
    const cgroupMount = path.join(path.sep, 'mock', 'sys', 'fs', 'cgroup');
    const fakeFs = new FakeCgroupFs(cgroupMount);
    const started: string[] = [];
    const sandbox = await createSessionSandboxFactory({
      logger: createSilentLogger(),
      deps: {
        platform: 'linux',
        cgroupMount,
        fs: fakeFs,
        spawnProcess: ((command: string) => {
          started.push(command);
          return new FakeChildProcess(4321) as unknown as ChildProcess;
        }) as unknown as typeof realSpawn,
        readSelfCgroupPath: async () => '/system.slice/lody.service',
        configureExecutionProcess: vi.fn(async () => {}),
        killPid: vi.fn(),
      },
    })('session-1' as SessionId);
    await sandbox.cleanup();

    await expect(sandbox.spawn('agent', [], { cwd: process.cwd(), env: {} })).rejects.toThrow(
      'Session sandbox is not initialized'
    );
    expect(started).toEqual([]);
  });

  it('replays buffered exit and close events when the process exits during cgroup attach', async () => {
    const cgroupMount = path.join(path.sep, 'mock', 'sys', 'fs', 'cgroup');
    const fakeFs = new FakeCgroupFs(cgroupMount);
    const table = new FakeProcessTable('linux');
    const originalWriteFile = fakeFs.writeFile.bind(fakeFs);
    fakeFs.writeFile = vi.fn(async (target: string, value: string) => {
      if (path.basename(target) === 'cgroup.procs') {
        await originalWriteFile(target, value);
        table.exitOnItsOwn(1000);
        fakeFs.writeText(target, '');
        return;
      }
      await originalWriteFile(target, value);
    });

    const factory = createSessionSandboxFactory({
      logger: createSilentLogger(),
      deps: {
        platform: 'linux',
        cgroupMount,
        fs: fakeFs,
        spawnProcess: table.api.spawn,
        readSelfCgroupPath: async () => '/system.slice/lody.service',
        configureExecutionProcess: vi.fn(async () => {}),
        killPid: (pid, signal) => table.api.kill(pid, signal ?? 'SIGTERM'),
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
    const replayed: unknown[] = [];
    const closed = Promise.withResolvers<void>();
    handle.onExit((code, signal) => replayed.push(['exit', code, signal]));
    handle.onClose((code, signal) => {
      replayed.push(['close', code, signal]);
      closed.resolve();
    });
    await closed.promise;
    expect(replayed).toEqual([
      ['exit', 0, null],
      ['close', 0, null],
    ]);
    await sandbox.cleanup();
  });

  it('rejects ESRCH attachment and reclaims children of the exited leader', async () => {
    const cgroupMount = '/mock/sys/fs/cgroup';
    const fakeFs = new FakeCgroupFs(cgroupMount);
    const table = new FakeProcessTable('linux');
    let orphan = 0;
    const writeFile = fakeFs.writeFile.bind(fakeFs);
    fakeFs.writeFile = async (target, value) => {
      if (path.basename(target) === 'cgroup.procs') {
        orphan = table.addDescendant(1000);
        table.exitOnItsOwn(1000);
        throw Object.assign(new Error('leader exited before attachment'), { code: 'ESRCH' });
      }
      await writeFile(target, value);
    };
    const sandbox = await createSessionSandboxFactory({
      logger: createSilentLogger(),
      deps: {
        platform: 'linux',
        cgroupMount,
        fs: fakeFs,
        spawnProcess: table.api.spawn,
        killPid: (pid, signal) => table.api.kill(pid, signal ?? 'SIGTERM'),
        readSelfCgroupPath: async () => '/system.slice/lody.service',
        configureExecutionProcess: async () => {},
      },
    })('session-esrch-attach' as SessionId);
    await expect(sandbox.spawn('agent', [], {})).rejects.toMatchObject({ code: 'ESRCH' });
    expect(table.isAlive(orphan)).toBe(false);
    await sandbox.terminate(true);
    await sandbox.cleanup();
  });

  it('shares the reopened noop owner between concurrent starts', async () => {
    const table = new FakeProcessTable('darwin');
    const sandbox = await createSessionSandboxFactory({
      logger: createSilentLogger(),
      deps: {
        platform: 'darwin',
        spawnProcess: table.api.spawn,
        killPid: (pid, signal) => table.api.kill(pid, signal ?? 'SIGTERM'),
        configureExecutionProcess: async () => {},
      },
    })('concurrent-generation' as SessionId);
    await sandbox.cleanup();
    const children = await Promise.all([
      sandbox.spawn('first', [], {}),
      sandbox.spawn('second', [], {}),
    ]);
    const roots = children.map((child) => child.child.pid!);
    const accounting = await sandbox.readResourceAccounting();
    expect(accounting.kind === 'process-tree' && new Set(accounting.rootPids)).toEqual(
      new Set(roots)
    );
    await sandbox.cleanup();
    expect(roots.map((pid) => table.isAlive(pid))).toEqual([false, false]);
  });

  it('keeps a failed noop generation reachable instead of replacing it on spawn', async () => {
    const table = new FakeProcessTable('darwin');
    let denied = true;
    const sandbox = await createSessionSandboxFactory({
      logger: createSilentLogger(),
      deps: {
        platform: 'darwin',
        spawnProcess: table.api.spawn,
        killPid: (pid, signal) => {
          if (signal !== 0 && denied)
            throw Object.assign(new Error('signal failed'), { code: 'EIO' });
          table.api.kill(pid, signal ?? 'SIGTERM');
        },
        configureExecutionProcess: async () => {},
      },
    })('failed-generation' as SessionId);
    const first = await sandbox.spawn('agent', [], {});
    await expect(sandbox.cleanup()).rejects.toBeInstanceOf(ProcessReleaseFailed);
    await expect(sandbox.spawn('replacement', [], {})).rejects.toBeInstanceOf(TerminationFailed);
    expect(await sandbox.readResourceAccounting()).toMatchObject({ rootPids: [first.child.pid] });
    expect(table.isAlive(first.child.pid!)).toBe(true);
    denied = false;
    const next = await sandbox.spawn('replacement', [], {});
    expect(table.isAlive(first.child.pid!)).toBe(false);
    expect(table.isAlive(next.child.pid!)).toBe(true);
    expect(await sandbox.readResourceAccounting()).toMatchObject({ rootPids: [next.child.pid] });
    await sandbox.cleanup();
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

  const createProcessTableSandbox = async (table: FakeProcessTable) => {
    const factory = createSessionSandboxFactory({
      logger: createSilentLogger(),
      deps: {
        platform: table.platform,
        spawnProcess: table.api.spawn as unknown as typeof realSpawn,
        configureExecutionProcess: vi.fn(async () => {}),
        killPid: table.api.kill,
      },
    });
    return await factory('session-noop-tree' as SessionId);
  };

  it('terminates a noop process together with its descendants on POSIX hosts', async () => {
    const table = new FakeProcessTable('darwin');
    const sandbox = await createProcessTableSandbox(table);
    const handle = await sandbox.spawn('bash', ['-lc', 'node'], {
      cwd: process.cwd(),
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const leader = handle.child.pid ?? -1;
    const descendant = table.addDescendant(leader);

    await handle.terminate(false);

    expect(table.spawned[0]?.options.detached).toBe(true);
    expect(table.isAlive(leader)).toBe(false);
    expect(table.isAlive(descendant)).toBe(false);
    expect(table.delivered).toEqual([{ target: -leader, signal: 'SIGTERM' }]);
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

    expect(exitEvents).toEqual([[0, null]]);
    expect(closeEvents).toEqual([[0, null]]);
  });

  it('signals nothing for a noop process group that is already empty', async () => {
    const table = new FakeProcessTable('darwin');
    const sandbox = await createProcessTableSandbox(table);
    const handle = await sandbox.spawn('bash', ['-lc', 'exit 0'], {
      cwd: process.cwd(),
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    table.exitOnItsOwn(handle.child.pid ?? -1);

    await sandbox.terminate(true);

    expect(table.delivered).toEqual([]);
  });

  // An npx or shell wrapper can exit while the agent it started keeps running
  // in the same group; the sandbox must still reach that orphan.
  it('kills descendants that outlived their exited noop leader', async () => {
    const table = new FakeProcessTable('darwin');
    const sandbox = await createProcessTableSandbox(table);
    const handle = await sandbox.spawn('npx', ['agent'], {
      cwd: process.cwd(),
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const leader = handle.child.pid ?? -1;
    const orphan = table.addDescendant(leader);
    table.exitOnItsOwn(leader);

    await sandbox.terminate(true);

    expect(table.isAlive(orphan)).toBe(false);
    expect(table.delivered).toEqual([{ target: -leader, signal: 'SIGKILL' }]);
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

const cgroupMount = '/mock/sys/fs/cgroup';
const reviewSessionDir = path.join(
  cgroupMount,
  'system.slice/lody.service/lody-sessions/lody-session-review'
);
const makeReviewContainer = (fakeFs: FakeCgroupFs) =>
  makeCgroupContainer({
    sessionId: 'review',
    cgroupMount,
    fs: fakeFs,
    readSelfCgroupPath: async () => '/system.slice/lody.service',
    configureProcess: () => Effect.void,
  });
const firstError = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

describe('cgroup failure ownership', () => {
  effectIt.effect('releases completed process Scopes without removing the reusable cgroup', () => {
    const fakeFs = new FakeCgroupFs(cgroupMount);
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
      const container = yield* makeReviewContainer(fakeFs).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
      );
      for (let index = 0; index < 2; index++) {
        released = yield* Deferred.make<void>();
        const process = yield* container.spawn({ command: 'command', args: [], options: {} });
        table.exitOnItsOwn(process.child.pid!);
        yield* process.closed;
        yield* Deferred.await(released);
        expect(fakeFs.hasDir(reviewSessionDir)).toBe(true);
      }
      // Scope retirement keeps the cgroup available for subsequent commands.
      fakeFs.writeText(path.join(reviewSessionDir, 'cgroup.procs'), '');
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });
  effectIt.effect(
    'retains an escaped group after rollback fails so later termination can retry',
    () => {
      const fakeFs = new FakeCgroupFs(cgroupMount);
      const table = new FakeProcessTable('linux');
      let orphan = 0;
      const ready = Deferred.makeUnsafe<void>();
      const write = fakeFs.writeFile.bind(fakeFs);
      fakeFs.writeFile = async (target, value) => {
        if (path.basename(target) === 'cgroup.procs') {
          orphan = table.addDescendant(1000, { ignores: ['SIGTERM', 'SIGKILL'] });
          table.exitOnItsOwn(1000);
          Deferred.doneUnsafe(ready, Effect.void);
          throw Object.assign(new Error('leader exited'), { code: 'ESRCH' });
        }
        await write(target, value);
      };
      return Effect.gen(function* () {
        const container = yield* makeReviewContainer(fakeFs);
        const spawn = yield* Effect.forkChild(
          Effect.exit(container.spawn({ command: 'agent', args: [], options: {} }))
        );
        yield* Deferred.await(ready);
        yield* TestClock.adjust('4 seconds');
        expect(Exit.isFailure(yield* Fiber.join(spawn))).toBe(true);
        expect(table.isAlive(orphan)).toBe(true);
        expect(
          firstError(yield* Effect.exit(container.terminateAll({ graceMs: 0, killWaitMs: 0 })))
        ).toBeInstanceOf(TerminationFailed);
        const cleanup = yield* Effect.forkChild(container.cleanup);
        yield* TestClock.adjust('5 seconds');
        yield* Fiber.join(cleanup);
        expect(fakeFs.hasDir(reviewSessionDir)).toBe(true);
        expect(
          firstError(yield* Effect.exit(container.terminateAll({ graceMs: 0, killWaitMs: 0 })))
        ).toBeInstanceOf(TerminationFailed);
        table.exitOnItsOwn(orphan);
        yield* container.terminateAll({ graceMs: 0, killWaitMs: 0 });
        yield* container.cleanup;
        expect(fakeFs.hasDir(reviewSessionDir)).toBe(false);
      }).pipe(
        Effect.ensuring(Effect.sync(() => table.exitOnItsOwn(orphan))),
        Effect.provide(processLayer({ nodeProcess: table.api }))
      );
    }
  );

  effectIt.effect('rejects unknown populated state and accepts confirmed directory removal', () => {
    const fakeFs = new FakeCgroupFs(cgroupMount);
    const table = new FakeProcessTable('linux');
    return Effect.gen(function* () {
      const container = yield* makeReviewContainer(fakeFs);
      fakeFs.writeText(path.join(reviewSessionDir, 'cgroup.events'), 'frozen 0\n');
      expect(
        firstError(yield* Effect.exit(container.terminateAll({ graceMs: 0, killWaitMs: 0 })))
      ).toBeInstanceOf(TerminationFailed);
      fakeFs.writeText(path.join(reviewSessionDir, 'cgroup.events'), 'populated 0\n');
      yield* Effect.promise(() => fakeFs.rmdir(reviewSessionDir));
      yield* container.terminateAll({ graceMs: 0, killWaitMs: 0 });
      expect(fakeFs.hasDir(reviewSessionDir)).toBe(false);
    }).pipe(Effect.provide(processLayer({ nodeProcess: table.api })));
  });

  for (const [fileName, code] of [
    ['cgroup.procs', 'EACCES'],
    ['cgroup.procs', 'ENOENT'],
    ['cgroup.events', 'EIO'],
  ] as const) {
    effectIt.effect(
      `fails ${code} membership reads of ${fileName} without forgetting the cgroup`,
      () => {
        const fakeFs = new FakeCgroupFs(cgroupMount);
        const table = new FakeProcessTable('linux');
        const member = table.api.spawn('nested-member', [], { detached: true }).pid!;
        const read = fakeFs.readFile.bind(fakeFs);
        const write = fakeFs.writeFile.bind(fakeFs);
        let unreadable = false;
        fakeFs.readFile = async (target, encoding) => {
          if (unreadable && path.basename(target) === fileName)
            throw Object.assign(new Error('read failed'), { code });
          return await read(target, encoding);
        };
        fakeFs.writeFile = async (target, value) => {
          if (path.basename(target) === 'cgroup.kill') table.kill(member, 'SIGKILL');
          await write(target, value);
        };
        return Effect.gen(function* () {
          const container = yield* makeReviewContainer(fakeFs);
          fakeFs.writeText(path.join(reviewSessionDir, 'cgroup.events'), 'populated 1\nfrozen 0\n');
          unreadable = true;
          expect(
            firstError(yield* Effect.exit(container.terminateAll({ graceMs: 0, killWaitMs: 0 })))
          ).toBeInstanceOf(TerminationFailed);
          yield* container.cleanup;
          expect(table.isAlive(member)).toBe(true);
          expect(fakeFs.hasDir(reviewSessionDir)).toBe(true);
          unreadable = false;
          yield* container.terminateAll({ graceMs: 0, killWaitMs: 0 });
          expect(table.isAlive(member)).toBe(false);
          yield* container.cleanup;
          expect(fakeFs.hasDir(reviewSessionDir)).toBe(false);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              unreadable = false;
              table.exitOnItsOwn(member);
              fakeFs.writeText(path.join(reviewSessionDir, 'cgroup.events'), 'populated 0\n');
              fakeFs.writeText(path.join(reviewSessionDir, 'cgroup.procs'), '');
            })
          ),
          Effect.provide(processLayer({ nodeProcess: table.api }))
        );
      }
    );
  }
});
