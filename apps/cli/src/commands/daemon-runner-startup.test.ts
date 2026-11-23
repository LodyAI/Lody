import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliRunResult, SupervisorState } from '@lody/cli-supervisor';
import { EXIT_CODE_RETRYABLE_STARTUP } from '@/lib/machine-lifecycle';
import {
  describeDaemonWorkerStartupFailure,
  isDaemonWorkerReady,
  isRetryableDaemonWorkerStartupExit,
  startManagedWorkerReadinessDeadline,
} from './daemon-runner-startup';

function state(
  runtimeState: SupervisorState['runtime'],
  phase: SupervisorState['phase'] = 'starting'
): SupervisorState {
  return {
    phase,
    desiredState: 'running',
    updatedAtMs: 1,
    runtime: runtimeState,
  };
}

function makeRuntime(
  startupStage: NonNullable<SupervisorState['runtime']>['startupStage'],
  phase: NonNullable<SupervisorState['runtime']>['phase'] = 'running'
): NonNullable<SupervisorState['runtime']> {
  return {
    schemaVersion: 1,
    phase,
    startupStage,
    pid: 42,
    updatedAtMs: 1,
    issues: [],
  };
}

describe('daemon runner startup handshake', () => {
  it('waits for the worker local-ready boundary', () => {
    expect(isDaemonWorkerReady(state(undefined))).toBe(false);
    expect(isDaemonWorkerReady(state(makeRuntime('fleet-start', 'starting')))).toBe(false);
    expect(isDaemonWorkerReady(state(makeRuntime('ready', 'fatal'), 'fatal'))).toBe(false);
    expect(isDaemonWorkerReady(state(makeRuntime('ready', 'degraded'), 'degraded'))).toBe(true);
  });

  it('returns the worker stderr for a failed initial launch', () => {
    const result: CliRunResult = {
      code: 1,
      stdout: 'less useful output',
      stderr: 'Local workspace catalog is unavailable',
    };

    expect(describeDaemonWorkerStartupFailure(result)).toBe(
      'Local workspace catalog is unavailable'
    );
  });

  it('keeps the launch pending for an explicitly retryable startup exit', () => {
    expect(
      isRetryableDaemonWorkerStartupExit({
        code: EXIT_CODE_RETRYABLE_STARTUP,
        stdout: '',
        stderr: 'temporary dependency failure',
      })
    ).toBe(true);
    expect(
      isRetryableDaemonWorkerStartupExit({
        code: 1,
        stdout: '',
        stderr: 'permanent startup failure',
      })
    ).toBe(false);
  });

  it('bounds startup output and falls back to the exit reason', () => {
    const longError = `prefix-${'x'.repeat(2_100)}-useful-tail`;
    const described = describeDaemonWorkerStartupFailure({
      code: 1,
      stdout: '',
      stderr: longError,
    });
    expect(described.startsWith('…')).toBe(true);
    expect(described).toHaveLength(2_001);
    expect(described.endsWith('useful-tail')).toBe(true);

    expect(
      describeDaemonWorkerStartupFailure({
        code: null,
        signal: 'SIGTERM',
        stdout: '',
        stderr: '',
      })
    ).toBe('CLI worker exited from signal SIGTERM before becoming ready');
  });
});

describe('managed candidate readiness deadline', () => {
  afterEach(() => vi.useRealTimers());

  it('bounds a hung candidate even when its shutdown IPC never completes', async () => {
    vi.useFakeTimers();
    let phase = 'observing';
    let alive = true;
    const deadline = startManagedWorkerReadinessDeadline({
      timeoutMs: 180_000,
      shutdownGraceMs: 8_000,
      requestShutdown: () => new Promise<void>(() => {}),
      terminate: async () => {
        alive = false;
      },
      onExpired: () => {
        phase = 'blocked';
      },
      onTerminationFailure: () => {
        phase = 'blocked';
      },
    });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(deadline.expired).toBe(true);
    expect(phase).toBe('blocked');
    expect(alive).toBe(true);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(alive).toBe(false);
    deadline.clear();
    expect(deadline.expired).toBe(true); // Late ready is still ineligible to commit.
  });

  it('clears the deadline for a committed candidate or a fully stopped exact child', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const ready = startManagedWorkerReadinessDeadline({
      timeoutMs: 180_000,
      shutdownGraceMs: 8_000,
      requestShutdown: () => {
        events.push('shutdown');
      },
      terminate: async () => {
        events.push('terminate');
      },
      onExpired: () => {
        events.push('expired');
      },
      onTerminationFailure: () => {
        events.push('blocked');
      },
    });
    await vi.advanceTimersByTimeAsync(179_999);
    ready.clear();
    await vi.advanceTimersByTimeAsync(188_000);
    expect(events).toEqual([]);
    const draining = startManagedWorkerReadinessDeadline({
      timeoutMs: 180_000,
      shutdownGraceMs: 8_000,
      requestShutdown: () => {
        events.push('drained-and-stopped');
        draining.clear();
      },
      terminate: async () => {
        events.push('terminate');
      },
      onExpired: () => {
        events.push('expired');
      },
      onTerminationFailure: () => {
        events.push('blocked');
      },
    });
    await vi.advanceTimersByTimeAsync(188_000);
    expect(events).toEqual(['expired', 'drained-and-stopped']);
  });

  it('reports unconfirmed containment instead of treating a failed force stop as recovery', async () => {
    vi.useFakeTimers();
    const failures: unknown[] = [];
    const failure = new Error('owned candidate group survived');
    const deadline = startManagedWorkerReadinessDeadline({
      timeoutMs: 180_000,
      shutdownGraceMs: 8_000,
      requestShutdown: () => {
        throw new Error('IPC closed');
      },
      terminate: async () => {
        throw failure;
      },
      onExpired: () => {},
      onTerminationFailure: (error) => {
        failures.push(error);
      },
    });
    await vi.advanceTimersByTimeAsync(188_000);
    expect(deadline.expired).toBe(true);
    expect(failures).toEqual([failure]);
    deadline.clear();
  });
});
