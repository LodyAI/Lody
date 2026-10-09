import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliRuntimeState } from '@lody/shared/electron-ipc';
import { FakeProcessTable } from '@lody/shared/node/process-testing';
import { CliSupervisor } from './supervisor';
import type { CliRunResult, LaunchHandle, PreparedLaunch, SupervisorOptions } from './types';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRun(pid: number): {
  handle: LaunchHandle;
  child: ChildProcess;
  requestShutdown: ReturnType<typeof vi.fn>;
  exit: (result: CliRunResult) => void;
  rejectResult: (error: unknown) => void;
  confirmExit: (code?: number | null) => void;
} {
  const result = deferred<CliRunResult>();
  const requestShutdown = vi.fn();
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    kill: () => true,
  }) as unknown as ChildProcess;
  return {
    handle: { child, result: result.promise, requestShutdown },
    child,
    requestShutdown,
    exit: (runResult) => {
      if (runResult.code === null) {
        Object.assign(child, { signalCode: 'SIGTERM' as NodeJS.Signals });
      } else {
        Object.assign(child, { exitCode: runResult.code });
      }
      result.resolve(runResult);
      child.emit('exit', runResult.code, child.signalCode);
      child.emit('close', runResult.code, child.signalCode);
    },
    rejectResult: (error) => result.reject(error),
    confirmExit: (code = 1) => {
      if (code === null) {
        Object.assign(child, { signalCode: 'SIGTERM' as NodeJS.Signals });
      } else {
        Object.assign(child, { exitCode: code });
      }
      child.emit('exit', code, child.signalCode);
      child.emit('close', code, child.signalCode);
    },
  };
}

/**
 * A launch whose child lives in the fake OS process table, so termination is
 * observed as process state rather than as calls on a mock.
 */
function spawnTableRun(
  table: FakeProcessTable,
  options: {
    ignores?: NodeJS.Signals[];
    processGroup?: boolean;
    requestShutdown?: () => Promise<void>;
  } = {}
): {
  handle: LaunchHandle;
  child: ChildProcess;
  pid: number;
  requestShutdown: ReturnType<typeof vi.fn>;
} {
  table.queueSpawn({ ignores: options.ignores });
  const child = table.api.spawn('lody', ['start'], { detached: options.processGroup === true });
  const result = new Promise<CliRunResult>((resolve) => {
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) =>
      resolve({ code, signal, stdout: '', stderr: '' })
    );
  });
  const requestShutdown = vi.fn(options.requestShutdown ?? (async () => {}));
  return {
    handle: { child, result, requestShutdown, processGroup: options.processGroup },
    child,
    pid: child.pid as number,
    requestShutdown,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function createSupervisor(
  prepareLaunch: SupervisorOptions['prepareLaunch'],
  overrides: Partial<SupervisorOptions> = {}
): CliSupervisor {
  return new CliSupervisor({
    prepareLaunch,
    decideExit: (result) => ({
      action: 'retry',
      countFailure: true,
      message: `exit:${result.code}`,
    }),
    fetchRuntimeState: vi.fn(async () => null),
    probeIntervalMs: 60_000,
    probeTimeoutMs: 1,
    minRetryMs: 1_000,
    maxRetryMs: 1_000,
    retryJitterFraction: 0,
    ...overrides,
  });
}

describe('CliSupervisor lifecycle actor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('observes an external runtime without acquiring ownership or launching', async () => {
    const externalRuntime: CliRuntimeState = {
      schemaVersion: 1,
      phase: 'running',
      startupStage: 'ready',
      machineId: 'machine-external',
      pid: 4242,
      updatedAtMs: 1,
      issues: [],
    };
    const prepareLaunch = vi.fn(async () => ({ spawn: vi.fn() }));
    const acquire = vi.fn(async () => ({ status: 'acquired' as const }));
    const inspect = vi.fn(async () => ({
      instanceId: 'foreground-host',
      pid: externalRuntime.pid,
      mode: 'foreground' as const,
    }));
    const supervisor = createSupervisor(prepareLaunch, {
      fetchRuntimeState: vi.fn(async () => externalRuntime),
      ownership: { acquire, inspect, release: vi.fn() },
    });

    supervisor.startProbing();
    await flushMicrotasks();

    expect(prepareLaunch).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledOnce();
    const state = supervisor.getState();
    expect(state.desiredState).toBe('stopped');
    expect(state.phase).toBe('running');
    expect(state.runtime?.machineId).toBe('machine-external');
    expect(state.runtimeOwnership).toBe('external');

    await supervisor.stop();
  });

  it('never spawns a preparation that completes after stop invalidates its generation', async () => {
    const pendingPreparation = deferred<PreparedLaunch>();
    const spawn = vi.fn();
    const supervisor = createSupervisor(async () => await pendingPreparation.promise);

    const started = supervisor.start();
    await flushMicrotasks();
    const stopped = supervisor.stop();
    pendingPreparation.resolve({ spawn });

    await Promise.all([started, stopped]);
    expect(spawn).not.toHaveBeenCalled();
    expect(supervisor.getState().phase).toBe('stopped');
    expect(supervisor.getActiveChild()).toBeNull();
  });

  it('does not let an uncooperative preparation block stop', async () => {
    const pendingPreparation = deferred<PreparedLaunch>();
    const supervisor = createSupervisor(async () => await pendingPreparation.promise);

    const started = supervisor.start();
    await flushMicrotasks();
    await supervisor.stop();

    expect(supervisor.getState().phase).toBe('stopped');
    pendingPreparation.resolve({ spawn: vi.fn() });
    await started;
  });

  it('releases a late ownership acquisition after stop invalidates its generation', async () => {
    const acquisition = deferred<{ status: 'acquired' }>();
    const release = vi.fn();
    const spawn = vi.fn();
    const supervisor = createSupervisor(async () => ({ spawn }), {
      ownership: {
        acquire: async () => await acquisition.promise,
        release,
      },
    });

    const started = supervisor.start();
    await flushMicrotasks();
    const stopped = supervisor.stop();
    acquisition.resolve({ status: 'acquired' });

    await Promise.all([started, stopped]);
    expect(release).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('acquires host ownership before its first runtime probe', async () => {
    const order: string[] = [];
    const run = createRun(99);
    const supervisor = createSupervisor(async () => ({ spawn: () => run.handle }), {
      ownership: {
        acquire: async () => {
          order.push('ownership');
          return { status: 'acquired' };
        },
        release: vi.fn(),
      },
      fetchRuntimeState: vi.fn(async () => {
        order.push('probe');
        return null;
      }),
    });

    await supervisor.start();
    expect(order.slice(0, 2)).toEqual(['ownership', 'probe']);

    const stopped = supervisor.stop();
    await flushMicrotasks();
    run.exit({ code: 0, stdout: '', stderr: '' });
    await stopped;
  });

  it('waits for an unowned runtime to exit instead of going fatal, then launches', async () => {
    const runtime = {
      schemaVersion: 1 as const,
      phase: 'running' as const,
      pid: 100,
      updatedAtMs: 1,
      issues: [],
    };
    const replacement = createRun(102);
    const release = vi.fn();
    const fetchRuntimeState = vi.fn().mockResolvedValueOnce(runtime).mockResolvedValue(null);
    const spawn = vi.fn(() => replacement.handle);
    const supervisor = createSupervisor(async () => ({ spawn }), {
      existingRuntimePolicy: 'attach',
      ownership: {
        acquire: async () => ({ status: 'acquired' }),
        release,
      },
      fetchRuntimeState,
    });

    await supervisor.start();

    expect(spawn).not.toHaveBeenCalled();
    expect(supervisor.getState().phase).not.toBe('fatal');
    expect(supervisor.getState().message).toContain('without Local Host ownership');
    expect(supervisor.getState().retryInMs).toBe(1_000);
    expect(release).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(spawn).toHaveBeenCalledOnce();
    expect(supervisor.getActiveChild()).toBe(replacement.child);

    const stopped = supervisor.stop();
    await flushMicrotasks();
    replacement.exit({ code: 0, stdout: '', stderr: '' });
    await stopped;
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps waiting when an unowned runtime appears during an owned retry delay', async () => {
    const first = createRun(100);
    const second = createRun(103);
    const runtime = {
      schemaVersion: 1 as const,
      phase: 'running' as const,
      pid: 101,
      updatedAtMs: 1,
      issues: [],
    };
    const fetchRuntimeState = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(runtime)
      .mockResolvedValue(null);
    const spawn = vi
      .fn<() => LaunchHandle>()
      .mockReturnValueOnce(first.handle)
      .mockReturnValueOnce(second.handle);
    const supervisor = createSupervisor(async () => ({ spawn }), {
      existingRuntimePolicy: 'attach',
      ownership: {
        acquire: async () => ({ status: 'acquired' }),
        release: vi.fn(),
      },
      fetchRuntimeState,
      probeIntervalMs: 500,
      minRetryMs: 1_000,
      maxRetryMs: 1_000,
    });

    await supervisor.start();
    first.exit({ code: 1, stdout: '', stderr: 'crash' });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(500);

    expect(supervisor.getState().phase).not.toBe('fatal');
    expect(supervisor.getState().message).toContain('without Local Host ownership');
    expect(spawn).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(supervisor.getActiveChild()).toBe(second.child);
  });

  it('start() clears a fatal verdict and begins a new generation', async () => {
    const first = createRun(901);
    const second = createRun(902);
    const spawn = vi
      .fn<() => LaunchHandle>()
      .mockReturnValueOnce(first.handle)
      .mockReturnValueOnce(second.handle);
    const supervisor = createSupervisor(async () => ({ spawn }), {
      decideExit: (result) =>
        result.code === 44
          ? { action: 'fatal', message: 'auth failed' }
          : { action: 'retry', countFailure: true },
    });

    await supervisor.start();
    first.exit({ code: 44, stdout: '', stderr: '' });
    await flushMicrotasks();
    expect(supervisor.getState().phase).toBe('fatal');

    await supervisor.start();
    expect(supervisor.getState().phase).not.toBe('fatal');
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(supervisor.getActiveChild()).toBe(second.child);

    const stopped = supervisor.stop();
    await flushMicrotasks();
    second.exit({ code: 0, stdout: '', stderr: '' });
    await stopped;
  });

  it('does not resolve stop or launch a replacement before the old child exits', async () => {
    const first = createRun(101);
    const second = createRun(102);
    const spawn = vi
      .fn<() => LaunchHandle>()
      .mockReturnValueOnce(first.handle)
      .mockReturnValueOnce(second.handle);
    const supervisor = createSupervisor(async () => ({ spawn }));

    await supervisor.start();
    const stopped = supervisor.stop();
    const restarted = supervisor.start();
    let stopResolved = false;
    void stopped.then(() => {
      stopResolved = true;
    });
    await flushMicrotasks();

    expect(first.requestShutdown).toHaveBeenCalledOnce();
    expect(stopResolved).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);

    first.exit({ code: 0, stdout: '', stderr: '' });
    await stopped;
    await restarted;

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(supervisor.getActiveChild()).toBe(second.child);
  });

  it('does not treat an early result rejection as process exit', async () => {
    const first = createRun(151);
    const second = createRun(152);
    const spawn = vi
      .fn<() => LaunchHandle>()
      .mockReturnValueOnce(first.handle)
      .mockReturnValueOnce(second.handle);
    const supervisor = createSupervisor(async () => ({ spawn }));

    await supervisor.start();
    first.rejectResult(new Error('transient child error event'));
    await flushMicrotasks();

    expect(supervisor.getActiveChild()).toBe(first.child);
    expect(spawn).toHaveBeenCalledOnce();

    first.confirmExit(1);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(supervisor.getActiveChild()).toBe(second.child);
  });

  it('escalates an unanswered graceful shutdown to SIGKILL and waits for the real exit', async () => {
    const table = new FakeProcessTable();
    const run = spawnTableRun(table);
    const supervisor = createSupervisor(async () => ({ spawn: () => run.handle }), {
      terminationGraceMs: 1_000,
      forceKillWaitMs: 500,
      processOptions: { nodeProcess: table.api },
    });

    await supervisor.start();
    let resolved = false;
    const stopped = supervisor.stop().then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    // The shutdown request was accepted, so no signal preempts the drain.
    expect(run.requestShutdown).toHaveBeenCalledOnce();
    expect(table.isAlive(run.pid)).toBe(true);
    expect(supervisor.getState().phase).toBe('stopping');

    await vi.advanceTimersByTimeAsync(1);
    expect(table.isAlive(run.pid)).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    await stopped;
    expect(resolved).toBe(true);
    expect(supervisor.getState()).toMatchObject({ phase: 'stopped', lastExitCode: null });
  });

  it('falls back to SIGTERM when the shutdown channel fails', async () => {
    const table = new FakeProcessTable();
    const run = spawnTableRun(table, {
      requestShutdown: async () => {
        throw new Error('IPC channel closed');
      },
    });
    const supervisor = createSupervisor(async () => ({ spawn: () => run.handle }), {
      terminationGraceMs: 30_000,
      processOptions: { nodeProcess: table.api },
    });

    await supervisor.start();
    const stopped = supervisor.stop();
    await flushMicrotasks();
    await stopped;

    expect(table.delivered).toEqual([{ target: run.pid, signal: 'SIGTERM' }]);
    expect(supervisor.getState().phase).toBe('stopped');
  });

  it('ends the whole process group of a child started as a group leader', async () => {
    const table = new FakeProcessTable();
    const run = spawnTableRun(table, { ignores: ['SIGTERM'], processGroup: true });
    const descendant = table.addDescendant(run.pid, { ignores: ['SIGTERM'] });
    const supervisor = createSupervisor(async () => ({ spawn: () => run.handle }), {
      terminationGraceMs: 1_000,
      forceKillWaitMs: 500,
      processOptions: { nodeProcess: table.api },
    });

    await supervisor.start();
    const stopped = supervisor.stop();
    await vi.advanceTimersByTimeAsync(1_020);
    await stopped;

    expect(table.isAlive(run.pid)).toBe(false);
    expect(table.isAlive(descendant)).toBe(false);
  });

  it('turns fatal and keeps the run when the child survives SIGKILL', async () => {
    const table = new FakeProcessTable();
    const run = spawnTableRun(table, { ignores: ['SIGTERM', 'SIGKILL'] });
    const supervisor = createSupervisor(async () => ({ spawn: () => run.handle }), {
      terminationGraceMs: 1_000,
      forceKillWaitMs: 500,
      processOptions: { nodeProcess: table.api },
    });

    await supervisor.start();
    const stopped = supervisor.stop();
    const failure = expect(stopped).rejects.toThrow(
      `CLI process ${run.pid} did not exit after SIGKILL`
    );
    await vi.advanceTimersByTimeAsync(1_600);
    await failure;

    expect(table.isAlive(run.pid)).toBe(true);
    expect(supervisor.getActiveChild()).toBe(run.child);
    expect(supervisor.getState()).toMatchObject({
      phase: 'stopping',
      message: expect.stringContaining('did not exit after SIGKILL'),
    });
  });

  it('cancels an in-progress preparation before restart and spawns only the new generation', async () => {
    const firstPreparation = deferred<PreparedLaunch>();
    const oldSpawn = vi.fn();
    const replacement = createRun(302);
    const prepareLaunch = vi
      .fn<SupervisorOptions['prepareLaunch']>()
      .mockImplementationOnce(async () => await firstPreparation.promise)
      .mockResolvedValueOnce({ spawn: () => replacement.handle });
    const supervisor = createSupervisor(prepareLaunch);

    const started = supervisor.start();
    await flushMicrotasks();
    const restarted = supervisor.restart();
    firstPreparation.resolve({ spawn: oldSpawn });

    await Promise.all([started, restarted]);
    expect(oldSpawn).not.toHaveBeenCalled();
    expect(prepareLaunch).toHaveBeenCalledTimes(2);
    expect(supervisor.getActiveChild()).toBe(replacement.child);
  });

  it('drops a stale child result after stop-start instead of scheduling a third launch', async () => {
    const first = createRun(401);
    const second = createRun(402);
    const spawn = vi
      .fn<() => LaunchHandle>()
      .mockReturnValueOnce(first.handle)
      .mockReturnValueOnce(second.handle);
    const supervisor = createSupervisor(async () => ({ spawn }));

    await supervisor.start();
    const stopped = supervisor.stop();
    const startedAgain = supervisor.start();
    first.exit({ code: 1, stdout: '', stderr: 'old generation' });
    await Promise.all([stopped, startedAgain]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(supervisor.getActiveChild()).toBe(second.child);
  });

  it('restarts immediately when the explicit exit policy requests it', async () => {
    const first = createRun(501);
    const second = createRun(502);
    const spawn = vi
      .fn<() => LaunchHandle>()
      .mockReturnValueOnce(first.handle)
      .mockReturnValueOnce(second.handle);
    const decideExit = vi.fn((result: CliRunResult) =>
      result.code === 42
        ? { action: 'restart' as const, message: 'remote restart' }
        : { action: 'retry' as const, countFailure: true }
    );
    const supervisor = createSupervisor(async () => ({ spawn }), { decideExit });

    await supervisor.start();
    first.exit({ code: 42, stdout: '', stderr: '' });
    await flushMicrotasks();

    expect(decideExit).toHaveBeenCalledWith(
      { code: 42, stdout: '', stderr: '' },
      expect.any(AbortSignal)
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(supervisor.getActiveChild()).toBe(second.child);
  });

  it('uses the specified 1/2/4/8/16/32/60 second crash backoff', async () => {
    const runs = Array.from({ length: 8 }, (_, index) => createRun(550 + index));
    let runIndex = 0;
    const supervisor = new CliSupervisor({
      prepareLaunch: async () => ({ spawn: () => runs[runIndex++]!.handle }),
      decideExit: () => ({ action: 'retry', countFailure: true }),
      fetchRuntimeState: vi.fn(async () => null),
      probeIntervalMs: 1_000_000,
      probeTimeoutMs: 1,
      retryJitterFraction: 0,
    });
    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];

    await supervisor.start();
    for (const [index, delay] of expectedDelays.entries()) {
      runs[index]!.exit({ code: 1, stdout: '', stderr: 'crash' });
      await flushMicrotasks();
      expect(supervisor.getState().retryInMs).toBe(delay);
      await vi.advanceTimersByTimeAsync(delay);
      await flushMicrotasks();
      expect(supervisor.getActiveChild()).toBe(runs[index + 1]!.child);
    }
  });

  it('becomes fatal after a second V8 OOM even when each run passed the healthy timer', async () => {
    const first = createRun(580);
    const second = createRun(581);
    const spawn = vi
      .fn<() => LaunchHandle>()
      .mockReturnValueOnce(first.handle)
      .mockReturnValueOnce(second.handle);
    const supervisor = createSupervisor(async () => ({ spawn }), {
      healthyRunMs: 500,
      fatalOomWindowMs: 30 * 60_000,
      fatalOomThreshold: 2,
      decideExit: () => ({
        action: 'retry',
        countFailure: true,
        failureClass: 'v8_oom',
        message: 'worker V8 OOM',
      }),
    });

    await supervisor.start();
    await vi.advanceTimersByTimeAsync(600);
    first.exit({
      code: null,
      signal: 'SIGABRT',
      terminationKind: 'v8_oom',
      stdout: '',
      stderr: 'FATAL ERROR: Reached heap limit',
    });
    await flushMicrotasks();
    expect(supervisor.getState().phase).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(600);
    second.exit({
      code: null,
      signal: 'SIGABRT',
      terminationKind: 'v8_oom',
      stdout: '',
      stderr: 'FATAL ERROR: Reached heap limit',
    });
    await flushMicrotasks();

    expect(supervisor.getState()).toMatchObject({
      phase: 'fatal',
      desiredState: 'running',
    });
    expect(supervisor.getState().message).toContain('exhausted its V8 heap 2 times');
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('attaches to a healthy external runtime without claiming or killing it', async () => {
    const runtime = {
      schemaVersion: 1 as const,
      phase: 'running' as const,
      pid: 601,
      updatedAtMs: 1,
      issues: [],
    };
    const spawn = vi.fn();
    const supervisor = createSupervisor(async () => ({ spawn }), {
      existingRuntimePolicy: 'attach',
      fetchRuntimeState: vi.fn(async () => runtime),
    });

    await supervisor.start();

    expect(spawn).not.toHaveBeenCalled();
    expect(supervisor.getState().runtimeOwnership).toBe('external');
    expect(supervisor.getState().runtime?.pid).toBe(601);
    await expect(supervisor.restart()).rejects.toThrow('owned by another host');
    await supervisor.stop();
    expect(supervisor.getState().phase).toBe('stopped');
  });

  it('attaches only when the occupied Host identity matches the runtime', async () => {
    const owner = { instanceId: 'daemon-host', pid: 620, mode: 'daemon' as const };
    const runtime = {
      schemaVersion: 1 as const,
      phase: 'running' as const,
      pid: 621,
      updatedAtMs: 1,
      issues: [],
      supervisor: { ...owner, launchMode: owner.mode },
    };
    const spawn = vi.fn();
    const supervisor = createSupervisor(async () => ({ spawn }), {
      existingRuntimePolicy: 'attach',
      ownership: {
        acquire: vi.fn(async () => ({ status: 'occupied' as const, owner })),
        release: vi.fn(),
      },
      fetchRuntimeState: vi.fn(async () => runtime),
    });

    await supervisor.start();

    expect(spawn).not.toHaveBeenCalled();
    expect(supervisor.getState().runtimeOwnership).toBe('external');
    expect(supervisor.getState().runtime?.pid).toBe(runtime.pid);
  });

  it('fails closed when the occupied Host identity does not match the runtime', async () => {
    const owner = { instanceId: 'daemon-host', pid: 630, mode: 'daemon' as const };
    const runtime = {
      schemaVersion: 1 as const,
      phase: 'running' as const,
      pid: 631,
      updatedAtMs: 1,
      issues: [],
      supervisor: {
        instanceId: 'different-host',
        pid: 632,
        launchMode: 'daemon' as const,
      },
    };
    const supervisor = createSupervisor(async () => ({ spawn: vi.fn() }), {
      existingRuntimePolicy: 'attach',
      ownership: {
        acquire: vi.fn(async () => ({ status: 'occupied' as const, owner })),
        release: vi.fn(),
      },
      fetchRuntimeState: vi.fn(async () => runtime),
    });

    await supervisor.start();

    expect(supervisor.getState().runtimeOwnership).toBeUndefined();
    expect(supervisor.getState().message).toContain('identity does not match');
    expect(supervisor.getState().retryInMs).toBe(1_000);
  });

  it('reacquires ownership before launching after an attached Host disappears', async () => {
    const owner = { instanceId: 'daemon-host', pid: 640, mode: 'daemon' as const };
    const runtime = {
      schemaVersion: 1 as const,
      phase: 'running' as const,
      pid: 641,
      updatedAtMs: 1,
      issues: [],
      supervisor: { ...owner, launchMode: owner.mode },
    };
    const replacement = createRun(642);
    const acquire = vi
      .fn<NonNullable<SupervisorOptions['ownership']>['acquire']>()
      .mockResolvedValueOnce({ status: 'occupied', owner })
      .mockResolvedValueOnce({ status: 'acquired' });
    const inspect = vi.fn(async () => null);
    const fetchRuntimeState = vi.fn().mockResolvedValueOnce(runtime).mockResolvedValue(null);
    const spawn = vi.fn(() => replacement.handle);
    const supervisor = createSupervisor(async () => ({ spawn }), {
      existingRuntimePolicy: 'attach',
      ownership: { acquire, inspect, release: vi.fn() },
      fetchRuntimeState,
      probeIntervalMs: 1_000,
    });

    await supervisor.start();
    expect(supervisor.getState().runtimeOwnership).toBe('external');

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(inspect).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledOnce();
    expect(supervisor.getActiveChild()).toBe(replacement.child);
  });

  it('does not treat a different probe PID as health for its owned child', async () => {
    const run = createRun(701);
    const external = {
      schemaVersion: 1 as const,
      phase: 'running' as const,
      pid: 799,
      updatedAtMs: 1,
      issues: [],
    };
    const fetchRuntimeState = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(external);
    const supervisor = createSupervisor(async () => ({ spawn: () => run.handle }), {
      existingRuntimePolicy: 'attach',
      fetchRuntimeState,
      probeIntervalMs: 1_000,
    });

    await supervisor.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(supervisor.getActiveChild()).toBe(run.child);
    expect(supervisor.getState().runtime).toBeUndefined();
    expect(supervisor.getState().message).toContain('different CLI runtime');
  });

  it('relaunches when an attached external runtime disappears for the full probe threshold', async () => {
    const runtime = {
      schemaVersion: 1 as const,
      phase: 'running' as const,
      pid: 801,
      updatedAtMs: 1,
      issues: [],
    };
    const replacement = createRun(802);
    const fetchRuntimeState = vi.fn().mockResolvedValueOnce(runtime).mockResolvedValue(null);
    const spawn = vi.fn(() => replacement.handle);
    const supervisor = createSupervisor(async () => ({ spawn }), {
      existingRuntimePolicy: 'attach',
      fetchRuntimeState,
      probeIntervalMs: 1_000,
      probeFailureThreshold: 1,
    });

    await supervisor.start();
    expect(supervisor.getState().runtimeOwnership).toBe('external');
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(spawn).toHaveBeenCalledOnce();
    expect(supervisor.getActiveChild()).toBe(replacement.child);
  });
});
