import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { terminateWindowsChildProcess } from './windows-child-process';

describe.skipIf(process.platform !== 'win32')('Windows child handle integration', () => {
  it('terminates the retained child handle without consulting its cached PID', async () => {
    const child = spawn(
      process.execPath,
      ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }
    );
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
    void exited.catch(() => {});
    try {
      if (!child.stdout) throw new Error('Fixture stdout unavailable');
      await once(child.stdout, 'data', { signal: AbortSignal.timeout(10_000) });
      Object.defineProperty(child, 'pid', {
        get: () => {
          throw new Error('Cached PID was read');
        },
      });
      await terminateWindowsChildProcess(child, true);
      await exited;
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  }, 15_000);
});
