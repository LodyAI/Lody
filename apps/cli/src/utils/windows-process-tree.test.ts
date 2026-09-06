import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminateWindowsProcessTree } from './windows-process-tree';

function processFixture(pid = 42): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  return child;
}

afterEach(() => vi.useRealTimers());

describe('terminateWindowsProcessTree', () => {
  it.each([false, true])('requests recursive hidden termination (force=%s)', async (force) => {
    const root = processFixture();
    const helper = processFixture(43);
    const spawnProcess = vi.fn(() => helper);
    const result = terminateWindowsProcessTree(root, force, { spawnProcess });
    expect(spawnProcess).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '42', '/T', ...(force ? ['/F'] : [])],
      { stdio: 'ignore', windowsHide: true }
    );
    helper.emit('close', 0, null);
    await expect(result).resolves.toBeUndefined();
    expect(helper.eventNames()).toEqual([]);
  });

  it.each(['exitCode', 'signalCode'] as const)(
    'does not target an exited root (%s)',
    async (field) => {
      const root = processFixture();
      if (field === 'exitCode') root.exitCode = 0;
      else root.signalCode = 'SIGTERM';
      const spawnProcess = vi.fn();
      await terminateWindowsProcessTree(root, true, { spawnProcess });
      expect(spawnProcess).not.toHaveBeenCalled();
    }
  );

  it.each([
    [1, null],
    [null, 'SIGTERM'],
    [0, 'SIGTERM'],
  ] as const)(
    'rejects unsuccessful helper exit %s/%s even if the root exits',
    async (code, signal) => {
      const root = processFixture();
      const helper = processFixture(43);
      const result = terminateWindowsProcessTree(root, true, { spawnProcess: () => helper });
      root.exitCode = 0;
      helper.emit('close', code, signal);
      await expect(result).rejects.toThrow('did not succeed');
      expect(helper.eventNames()).toEqual([]);
    }
  );

  it('redacts helper errors and synchronous spawn errors', async () => {
    const helper = processFixture();
    const result = terminateWindowsProcessTree(processFixture(), true, {
      spawnProcess: () => helper,
    });
    helper.emit('error', new Error('secret command data'));
    await expect(result).rejects.toThrow('helper failed');
    expect(helper.eventNames()).toEqual([]);
    await expect(
      terminateWindowsProcessTree(processFixture(), true, {
        spawnProcess: () => {
          throw new Error('secret command data');
        },
      })
    ).rejects.toThrow('Could not start Windows process tree termination');
  });

  it('bounds a hung helper and kills only the helper, preserving timeout after synchronous close', async () => {
    vi.useFakeTimers();
    const root = processFixture();
    const helper = processFixture(43);
    helper.kill = vi.fn(() => {
      helper.emit('close', 0, null);
      return true;
    });
    const result = terminateWindowsProcessTree(root, true, {
      spawnProcess: () => helper,
      timeoutMs: 25,
    });
    const rejected = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(root.kill).not.toHaveBeenCalled();
    expect(helper.kill).toHaveBeenCalledWith('SIGKILL');
    expect(helper.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline on successful completion', async () => {
    vi.useFakeTimers();
    const helper = processFixture();
    const result = terminateWindowsProcessTree(processFixture(), false, {
      spawnProcess: () => helper,
    });
    helper.emit('close', 0, null);
    await result;
    expect(vi.getTimerCount()).toBe(0);
    expect(helper.kill).not.toHaveBeenCalled();
  });

  it('rejects invalid ownership before spawning', async () => {
    const spawnProcess = vi.fn();
    await expect(
      terminateWindowsProcessTree(processFixture(0), true, { spawnProcess })
    ).rejects.toThrow('owned process ID');
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
