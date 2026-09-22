import { ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { access, readFile } from 'node:fs/promises';
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
  const controller = new AbortController();
  let resolveSpawn: (value: {
    child: ControlledChild;
    args: string[];
    options: SpawnOptionsWithoutStdio;
  }) => void = () => {};
  const spawned = new Promise<{
    child: ControlledChild;
    args: string[];
    options: SpawnOptionsWithoutStdio;
  }>((resolve) => {
    resolveSpawn = resolve;
  });
  const result = startCloudflaredNative({
    binary: '/managed/cloudflared',
    proxyOrigin: 'http://127.0.0.1:5173',
    signal: controller.signal,
    env: {
      HTTPS_PROXY: 'http://proxy.test',
      TUNNEL_TOKEN: 'must-not-inherit',
      LODY_AUTH_TOKEN: 'must-not-inherit',
    },
    spawn: (_binary, args, options) => {
      const child = new ControlledChild();
      resolveSpawn({ child, args, options });
      return child;
    },
  });
  launches.push(result);
  return { result, spawned, controller };
}

describe('cloudflared process ownership', () => {
  it('isolates configuration and returns only the allocated Quick origin', async () => {
    const run = launch();
    const { child, args, options } = await run.spawned;
    const config = args[args.indexOf('--config') + 1];
    if (!config) throw new Error('No explicit cloudflared config');
    expect(await readFile(config, 'utf8')).toBe('{}\n');
    expect(options.env).toEqual({ HTTPS_PROXY: 'http://proxy.test' });
    child.log('Requesting new quick Tunnel on trycloudflare.com...');
    const line = JSON.stringify({ message: '|  https://fixture-quick.trycloudflare.com  |' });
    child.stderr.write(line.slice(0, 19));
    child.stderr.write(`${line.slice(19)}\n`);
    const handle = await run.result;
    expect(handle.origin).toBe('https://fixture-quick.trycloudflare.com');
    await handle.stop();
    await handle.stop();
    expect(await handle.closed).toBeNull();
    expect(child.signals).toEqual(['SIGTERM']);
    await expect(access(config)).rejects.toThrow();
  });

  it('reports an unexpected exit instead of starting another child', async () => {
    const run = launch();
    const { child } = await run.spawned;
    child.log('| https://fixture-quick.trycloudflare.com |');
    const handle = await run.result;
    child.log(
      'Unable to reach edge https://example.test/?token=secret',
      'error',
      'dial timeout https://proxy.test/?credential=secret'
    );
    child.emit('close', 1, null);
    const failure = await handle.closed;
    expect(failure?.stage).toBe('connection');
    expect(failure?.message).toContain('Unable to reach edge [url]');
    expect(failure?.message).toContain('dial timeout [url]');
    expect(failure?.message).not.toContain('secret');
    expect(child.signals).toEqual([]);
  });

  it('cleans up when cancelled before address allocation and cannot publish a late URL', async () => {
    const run = launch();
    const rejected = expect(run.result).rejects.toThrow('cancelled');
    const { child, options } = await run.spawned;
    run.controller.abort(new Error('cancelled'));
    child.log('| https://too-late.trycloudflare.com |');
    await rejected;
    expect(child.signals).toEqual(['SIGTERM']);
    if (typeof options.cwd !== 'string') throw new Error('Missing owned directory');
    await expect(access(options.cwd)).rejects.toThrow();
  });

  it('fails an invalid origin and releases the process', async () => {
    const run = launch();
    const rejected = expect(run.result).rejects.toThrow('Invalid cloudflared JSON output');
    const { child } = await run.spawned;
    child.log('| https://attacker.test |');
    await rejected;
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('bounds startup and waits for confirmed exit after escalation', async () => {
    vi.useFakeTimers();
    const run = launch();
    const rejected = expect(run.result).rejects.toThrow('Timed out creating a Quick Tunnel');
    const { child } = await run.spawned;
    child.exitOnSignal = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(child.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    child.emit('close', null, 'SIGKILL');
    await rejected;
  });
});
