import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCloudflaredNative, type CloudflaredProcess } from './cloudflared-native';

class ControlledChild extends ChildProcess {
  override stdin = new PassThrough();
  override stdout = new PassThrough();
  override stderr = new PassThrough();
  override stdio: [PassThrough, PassThrough, PassThrough, null, null] = [
    this.stdin,
    this.stdout,
    this.stderr,
    null,
    null,
  ];
  signals: Array<NodeJS.Signals | number> = [];
  exitOnSignal = true;
  override kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (this.exitOnSignal) this.emit('close', 0, signal);
    return true;
  }
  log(message: string, level = 'info', error?: string) {
    this.stderr.write(`${JSON.stringify({ message, level, error })}\n`);
  }
}

const launches: Array<Promise<CloudflaredProcess>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const pendingLaunch of launches.splice(0)) {
    const result = await Promise.allSettled([pendingLaunch]);
    const first = result[0];
    if (first?.status === 'fulfilled') await first.value.stop();
  }
});

function launch() {
  const spawned = Promise.withResolvers<ControlledChild>();
  const result = startCloudflaredNative({
    binary: '/managed/cloudflared',
    proxyOrigin: 'http://127.0.0.1:5173',
    signal: new AbortController().signal,
    spawn: () => {
      const child = new ControlledChild();
      spawned.resolve(child);
      return child;
    },
  });
  launches.push(result);
  return { result, spawned: spawned.promise };
}

describe('cloudflared process ownership', () => {
  it('parses split JSON lines and redacts both diagnostic fields on native failure', async () => {
    const run = launch();
    const child = await run.spawned;
    const line = JSON.stringify({ message: '| https://fixture-quick.trycloudflare.com |' });
    child.stderr.write(line.slice(0, 19));
    child.stderr.write(`${line.slice(19)}\n`);
    const handle = await run.result;
    expect(handle.origin).toBe('https://fixture-quick.trycloudflare.com');
    child.log(
      'Unable to reach edge https://example.test/?token=secret',
      'error',
      'dial timeout https://proxy.test/?credential=secret'
    );
    child.emit('close', 1, null);
    const failure = await handle.closed;
    expect(failure?.message).toContain('Unable to reach edge [url]');
    expect(failure?.message).toContain('dial timeout [url]');
    expect(failure?.message).not.toContain('secret');
  });

  it('fails an invalid origin and releases the process', async () => {
    const run = launch();
    const rejected = expect(run.result).rejects.toThrow('Invalid cloudflared JSON output');
    const child = await run.spawned;
    child.log('| https://attacker.test |');
    await rejected;
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('bounds startup and waits for confirmed exit after escalation', async () => {
    vi.useFakeTimers();
    const run = launch();
    const rejected = expect(run.result).rejects.toThrow('Timed out creating a Quick Tunnel');
    const child = await run.spawned;
    child.exitOnSignal = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(child.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    child.emit('close', null, 'SIGKILL');
    await rejected;
  });
});
