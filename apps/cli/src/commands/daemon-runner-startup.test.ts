import { describe, expect, it } from 'vitest';
import type { CliRunResult, SupervisorState } from '@lody/cli-supervisor';
import { EXIT_CODE_RETRYABLE_STARTUP } from '@/lib/machine-lifecycle';
import {
  describeDaemonWorkerStartupFailure,
  isDaemonWorkerReady,
  isRetryableDaemonWorkerStartupExit,
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
