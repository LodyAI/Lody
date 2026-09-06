import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminateWindowsChildProcess } from './windows-child-process';

function fixture(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, 'pid', {
    get: () => {
      throw new Error('Cached PID was read');
    },
  });
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  return child;
}

afterEach(() => vi.useRealTimers());

describe('terminateWindowsChildProcess', () => {
  it.each([false, true])(
    'uses the retained handle and observes exit without waiting for close (force=%s)',
    async (force) => {
      const child = fixture();
      const result = terminateWindowsChildProcess(child, force);
      expect(child.kill).toHaveBeenCalledWith(force ? 'SIGKILL' : 'SIGTERM');
      child.emit('exit', 0, null);
      await result;
      expect(child.eventNames()).toEqual([]);
    }
  );

  it.each(['exitCode', 'signalCode'] as const)(
    'skips an already exited child (%s)',
    async (field) => {
      const child = fixture();
      if (field === 'exitCode') child.exitCode = 0;
      else child.signalCode = 'SIGTERM';
      await terminateWindowsChildProcess(child, true);
      expect(child.kill).not.toHaveBeenCalled();
    }
  );

  it('handles exit emitted synchronously during kill', async () => {
    const child = fixture();
    child.kill = vi.fn(() => {
      child.emit('exit', 0, null);
      return true;
    });
    await terminateWindowsChildProcess(child, true);
    expect(child.eventNames()).toEqual([]);
  });

  it('waits for exit when kill returns false during an OS exit race', async () => {
    const child = fixture();
    child.kill = vi.fn(() => false);
    const settled = vi.fn();
    const result = terminateWindowsChildProcess(child, true).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.emit('exit', 0, null);
    await result;
    expect(settled).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'times out without retrying a PID or accepting close (kill=%s)',
    async (accepted) => {
      vi.useFakeTimers();
      const child = fixture();
      child.kill = vi.fn(() => accepted);
      const result = terminateWindowsChildProcess(child, true, { timeoutMs: 25 });
      const rejected = expect(result).rejects.toThrow('timed out');
      child.emit('close', 0, null);
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(child.kill).toHaveBeenCalledOnce();
      expect(child.eventNames()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each(['throw', 'event'])('redacts a kill %s and permits a fresh attempt', async (kind) => {
    const child = fixture();
    child.kill = vi.fn(() => {
      if (kind === 'throw') throw new Error('secret');
      child.emit('error', new Error('secret'));
      return false;
    });
    await expect(terminateWindowsChildProcess(child, true)).rejects.toThrow(
      'Windows child termination failed'
    );
    child.kill = vi.fn(() => {
      child.emit('exit', 0, null);
      return true;
    });
    await terminateWindowsChildProcess(child, true);
    expect(child.eventNames()).toEqual([]);
  });

  it('does not accept EINVAL without subsequent terminal lifecycle evidence', async () => {
    vi.useFakeTimers();
    const child = fixture();
    child.kill = vi.fn(() => {
      throw Object.assign(new Error('invalid handle'), { code: 'EINVAL' });
    });
    const termination = terminateWindowsChildProcess(child, true, { timeoutMs: 25 });
    const rejected = expect(termination).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(child.eventNames()).toEqual([]);
  });
  it.each([0, -1, NaN, Infinity, 2_147_483_648])(
    'rejects invalid timeout %s before signaling',
    async (timeoutMs) => {
      const child = fixture();
      await expect(terminateWindowsChildProcess(child, true, { timeoutMs })).rejects.toThrow(
        'bounded'
      );
      expect(child.kill).not.toHaveBeenCalled();
    }
  );
});
