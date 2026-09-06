import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import { afterEach, expect, it, vi } from 'vitest';
import {
  spawnWindowsOwnedProcess,
  spawnOwnedProcess,
  WINDOWS_TARGET_NODE_MODE,
  windowsOwnershipRuntimeRoot,
} from './windows-owned-process';

afterEach(() => vi.useRealTimers());
function fixture() {
  const writes: string[] = [];
  const control = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      callback();
    },
  });
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, control],
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  }) as unknown as ChildProcess;
  const spawnProcess = Object.assign(
    vi.fn(() => child),
    { spawn: spawn.spawn, sync: spawn.sync }
  );
  const errors: Error[] = [];
  child.on('error', (error) => errors.push(error));
  const deps = {
    spawnProcess,
    exists: () => true,
    supervisorPath: 'supervisor.exe',
    launcherPath: 'launcher.js',
    timeoutMs: 25,
  };
  return { child, control, writes, deps, errors };
}

it('requires packaged ownership assets and never launches the target as fallback', () => {
  const f = fixture();
  expect(() =>
    spawnWindowsOwnedProcess('target', [], {}, { ...f.deps, exists: () => false })
  ).toThrow('unavailable');
  expect(f.deps.spawnProcess).not.toHaveBeenCalled();
});

it('preserves target arguments and uses fd3 without passing it to the target', async () => {
  vi.useFakeTimers();
  const f = fixture();
  spawnWindowsOwnedProcess(
    'a file.cmd',
    ['space value', '雪', '& echo bad'],
    { env: { TEST: 'value' }, stdio: 'pipe' },
    f.deps
  );
  expect(f.deps.spawnProcess).toHaveBeenCalledWith(
    'supervisor.exe',
    [
      '--owner-pid',
      String(process.pid),
      '--',
      process.execPath,
      'launcher.js',
      'a file.cmd',
      'space value',
      '雪',
      '& echo bad',
    ],
    expect.objectContaining({
      windowsHide: true,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: { TEST: 'value', ELECTRON_RUN_AS_NODE: '1', [WINDOWS_TARGET_NODE_MODE]: 'null' },
    })
  );
  f.control.push('{"type":"ready","protocol":1}\n');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.writes).toEqual(['start\n']);
  f.control.push('{"type":"prepared","pid":42}\n');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.writes).toEqual(['start\n', 'resume\n']);
  f.control.push('{"type":"started"}\n');
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(f.control.destroyed).toBe(false);
  f.child.emit('exit', 0, null);
  expect(f.control.destroyed).toBe(true);
  expect(f.errors).toEqual([]);
});

it.each(['{"type":"prepared","pid":42}\n', 'bad\n', 'x'.repeat(4097)])(
  'withdraws ownership on malformed protocol',
  async (message) => {
    vi.useFakeTimers();
    const f = fixture();
    spawnWindowsOwnedProcess('target', [], {}, f.deps);
    f.control.push(message);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.errors).toHaveLength(1);
    expect(f.control.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  }
);

it('withdraws ownership when startup never acknowledges', async () => {
  vi.useFakeTimers();
  const f = fixture();
  spawnWindowsOwnedProcess('target', [], {}, f.deps);
  await vi.advanceTimersByTimeAsync(25);
  expect(f.errors).toHaveLength(1);
  expect(f.control.destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('resolves packaged flat and shared-chunk modules to the same asset root', () => {
  expect(windowsOwnershipRuntimeRoot('file:///C:/app/cli/index.js').href).toBe(
    'file:///C:/app/cli/'
  );
  expect(windowsOwnershipRuntimeRoot('file:///C:/app/cli/chunks/shared.js').href).toBe(
    'file:///C:/app/cli/'
  );
});

it('does not expose unowned alternate spawn entrypoints', () => {
  expect(() => spawnOwnedProcess.spawn('target')).toThrow('callable owned process');
  expect(() => spawnOwnedProcess.sync('target')).toThrow('unsupported');
});
