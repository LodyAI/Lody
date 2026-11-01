import { describe, expect, it } from 'vitest';

import {
  AcpStartupProcessError,
  AcpStartupProcessExitError,
  createAcpStartupMonitor,
} from './acp-startup-monitor';

function createFakeMonitoredProcess() {
  const exitListeners = new Set<(exitCode: number | null, signal: NodeJS.Signals | null) => void>();
  const errorListeners = new Set<(error: Error) => void>();

  return {
    processHandle: {
      onExit(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void) {
        exitListeners.add(listener);
        return () => {
          exitListeners.delete(listener);
        };
      },
      onError(listener: (error: Error) => void) {
        errorListeners.add(listener);
        return () => {
          errorListeners.delete(listener);
        };
      },
    },
    emitExit(exitCode: number | null, signal: NodeJS.Signals | null) {
      for (const listener of Array.from(exitListeners)) {
        listener(exitCode, signal);
      }
    },
    emitError(error: Error) {
      for (const listener of Array.from(errorListeners)) {
        listener(error);
      }
    },
  };
}

describe('createAcpStartupMonitor', () => {
  it('rejects startup immediately when the ACP process exits early', async () => {
    const fakeProcess = createFakeMonitoredProcess();
    let stderrTail = '';
    const monitor = createAcpStartupMonitor(fakeProcess.processHandle, {
      sessionId: 'session-1',
      command: 'claude-agent-acp',
      args: [],
      getStderrTail: () => stderrTail,
    });

    stderrTail = `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod'`;
    fakeProcess.emitExit(1, null);

    await expect(monitor.abortPromise).rejects.toThrow(/Cannot find package 'zod'/);
  });

  it('rejects startup when process creation emits an error', async () => {
    const fakeProcess = createFakeMonitoredProcess();
    const monitor = createAcpStartupMonitor(fakeProcess.processHandle, {
      sessionId: 'session-2',
      command: 'claude-agent-acp',
      args: ['--debug'],
    });

    fakeProcess.emitError(new Error('spawn ENOENT'));

    await expect(monitor.abortPromise).rejects.toThrow(/spawn ENOENT/);
  });
  it.each([false, true])(
    'preserves stderr when transport closes first (exit observed: %s)',
    async (exitObserved) => {
      const fakeProcess = createFakeMonitoredProcess();
      const monitor = createAcpStartupMonitor(fakeProcess.processHandle, {
        sessionId: 'synthetic-startup',
        command: 'npx',
        args: [],
        getStderrTail: () => 'npm error EBADDEVENGINES: Node v22.23.1 requires >=22.23.4',
      });
      const disconnected = new Error('write EPIPE');
      // Handle the monitor promise even when the transport wins the startup race.
      const processResult = monitor.abortPromise.catch((error: unknown) => error);
      if (exitObserved) fakeProcess.emitExit(1, null);
      const failure = monitor.resolveError(disconnected);
      expect(failure).toBeInstanceOf(
        exitObserved ? AcpStartupProcessExitError : AcpStartupProcessError
      );
      expect(failure).toHaveProperty('stderrTail', expect.stringContaining('EBADDEVENGINES'));
      expect(failure).toHaveProperty('message', expect.stringContaining('requires >=22.23.4'));
      if (!exitObserved) {
        expect(failure).toHaveProperty('cause', disconnected);
        fakeProcess.emitExit(1, null);
      }
      await processResult;
      monitor.dispose();
    }
  );

  it('keeps protocol, cancellation and unexplained transport errors unchanged', () => {
    const fakeProcess = createFakeMonitoredProcess();
    let stderrTail = 'diagnostic warning';
    const monitor = createAcpStartupMonitor(fakeProcess.processHandle, {
      sessionId: 'synthetic-startup',
      command: 'npx',
      args: [],
      getStderrTail: () => stderrTail,
    });
    for (const error of [
      new Error('Authentication required'),
      new DOMException('ACP connection closed', 'AbortError'),
      Object.assign(new Error('Connection is disposed'), { code: -32603 }),
    ]) {
      expect(monitor.resolveError(error)).toBe(error);
    }
    stderrTail = '';
    const disconnected = new Error('ACP connection closed');
    expect(monitor.resolveError(disconnected)).toBe(disconnected);
    monitor.dispose();
  });
});
