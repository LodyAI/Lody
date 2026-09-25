import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startCloudflaredProcess } from './cloudflared-process';

const NativeStarted = z.object({
  pid: z.number(),
  ownerPid: z.number(),
  config: z.string(),
  secret: z.string().optional(),
  electron: z.string().optional(),
});

// Real process/IPC tests, no public network. POSIX shebang fixture stands in for
// the native binary; Windows native execution belongs to platform acceptance.
describe.skipIf(process.platform === 'win32')('cloudflared lifecycle IPC', () => {
  let root: string;
  let binary: string;
  let workerPath: string;
  let parentPath: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'lody-cloudflared-process-test-'));
    binary = join(root, 'native-fixture');
    workerPath = join(root, 'cloudflared-worker.mjs');
    parentPath = join(root, 'parent.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./cloudflared-worker.ts', import.meta.url))],
      outfile: workerPath,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
    });
    await build({
      stdin: {
        contents: `import { startCloudflaredProcess } from './cloudflared-process';
          const [binary, workerPath, proxyOrigin] = process.argv.slice(2);
          const child = await startCloudflaredProcess({ binary, workerPath, proxyOrigin,
            signal: new AbortController().signal });
          process.send({ type: 'ready', origin: child.origin });
          process.on('message', async () => { await child.stop(); process.disconnect(); });`,
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
        loader: 'ts',
      },
      outfile: parentPath,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
    });
    await writeFile(
      binary,
      `#!${process.execPath}
      const net = require('node:net');
      const args = process.argv.slice(2);
      const proxy = new URL(args[args.indexOf('--url') + 1]);
      const socket = net.connect(Number(proxy.port), proxy.hostname);
      socket.on('connect', () => socket.write(JSON.stringify({
        pid: process.pid, ownerPid: process.ppid,
        config: args[args.indexOf('--config') + 1],
        secret: process.env.LODY_AUTH_TOKEN, electron: process.env.ELECTRON_RUN_AS_NODE,
      }) + '\\n'));
      socket.setEncoding('utf8');
      socket.on('data', command => {
        if (command.trim() === 'origin') {
          console.error(JSON.stringify({ level: 'error', message: 'edge https://secret.test/?token=secret unavailable' }));
          console.error(JSON.stringify({ message: '| https://fixture-quick.trycloudflare.com |' }));
        }
        if (command.trim() === 'crash') process.exit(7);
      });
      process.on('SIGTERM', () => process.exit(0));
    `,
      { mode: 0o700 }
    );
  });
  afterAll(async () => {
    await rm(root, { recursive: true });
  });

  async function fixture() {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    let socket: Socket | undefined;
    const connected = once(server, 'connection').then(async ([connection]: [Socket]) => {
      socket = connection;
      let buffer = '';
      for await (const chunk of connection.iterator({ destroyOnReturn: false })) {
        buffer += String(chunk);
        if (buffer.includes('\n')) break;
      }
      connection.resume();
      return { socket: connection, info: NativeStarted.parse(JSON.parse(buffer)) };
    });
    return {
      proxyOrigin: `http://127.0.0.1:${address.port}`,
      connected,
      async close() {
        socket?.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      },
    };
  }

  function exists(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
      throw error;
    }
  }

  it('stops through IPC, waits for native exit and removes the owned config', async () => {
    const local = await fixture();
    const controller = new AbortController();
    const pending = startCloudflaredProcess({
      binary,
      workerPath,
      proxyOrigin: local.proxyOrigin,
      signal: controller.signal,
      env: { LODY_AUTH_TOKEN: 'do-not-inherit', ELECTRON_RUN_AS_NODE: '1' },
    });
    try {
      const { socket, info } = await local.connected;
      expect(info.secret).toBeUndefined();
      expect(info.electron).toBeUndefined(); // Only the Node owner inherits this flag.
      expect(await readFile(info.config, 'utf8')).toBe('{}\n');
      socket.write('origin\n');
      const child = await pending;
      expect(child.origin).toBe('https://fixture-quick.trycloudflare.com');
      expect(child.diagnostic()).toBe('edge [url] unavailable');
      await child.stop();
      await child.stop();
      expect(await child.closed).toBeNull();
      expect(exists(info.pid)).toBe(false);
      expect(exists(info.ownerPid)).toBe(false);
      await expect(access(info.config)).rejects.toThrow();
    } finally {
      controller.abort();
      await Promise.allSettled([pending.then((child) => child.stop())]);
      await local.close();
    }
  });

  it.each(['creating', 'active'])(
    'reaps the native child after SIGKILL of a %s CLI',
    async (phase) => {
      const local = await fixture();
      let parent: ChildProcess | undefined;
      let nativePid: number | undefined;
      let ownerPid: number | undefined;
      try {
        parent = spawn(process.execPath, [parentPath, binary, workerPath, local.proxyOrigin], {
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        const exited = once(parent, 'exit');
        const ready = once(parent, 'message');
        const { socket, info } = await local.connected;
        nativePid = info.pid;
        ownerPid = info.ownerPid;
        const nativeClosed = once(socket, 'close');
        if (phase === 'active') {
          socket.write('origin\n');
          expect((await ready)[0]).toEqual({
            type: 'ready',
            origin: 'https://fixture-quick.trycloudflare.com',
          });
        }
        parent.kill('SIGKILL');
        await exited;
        await nativeClosed;
        // Orphan exit has no child-process handle in the test process. Observe the
        // OS boundary, never sleep to guess that cleanup has completed.
        await expect.poll(() => exists(info.ownerPid)).toBe(false);
        expect(exists(info.pid)).toBe(false);
        await expect(access(info.config)).rejects.toThrow();
        // The unrelated local server is still owned by the test, not the worker.
        const probe = createConnection(Number(new URL(local.proxyOrigin).port), '127.0.0.1');
        await once(probe, 'connect');
        probe.destroy();
      } finally {
        if (parent && parent.exitCode === null && parent.signalCode === null) {
          const exited = once(parent, 'exit');
          parent.kill('SIGKILL');
          await exited;
        }
        if (nativePid && exists(nativePid)) process.kill(nativePid, 'SIGKILL');
        if (ownerPid && exists(ownerPid)) process.kill(ownerPid, 'SIGTERM');
        await local.close();
      }
    }
  );

  it('surfaces a native crash and releases its config instead of restarting', async () => {
    const local = await fixture();
    const controller = new AbortController();
    const pending = startCloudflaredProcess({
      binary,
      workerPath,
      proxyOrigin: local.proxyOrigin,
      signal: controller.signal,
    });
    try {
      const { socket, info } = await local.connected;
      socket.write('origin\n');
      const child = await pending;
      socket.write('crash\n');
      expect((await child.closed)?.message).toContain('cloudflared exited (7)');
      expect(exists(info.ownerPid)).toBe(false);
      await expect(access(info.config)).rejects.toThrow();
    } finally {
      controller.abort();
      await Promise.allSettled([pending.then((child) => child.stop())]);
      await local.close();
    }
  });

  it('reports a missing managed binary', async () => {
    await expect(
      startCloudflaredProcess({
        binary: join(root, 'absent'),
        workerPath,
        proxyOrigin: 'http://127.0.0.1:5173',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('cloudflared could not be started');
  });

  it('keeps Electron Node mode in the owner without inheriting CLI secrets or Node hooks', async () => {
    const entry = join(root, 'environment-worker.mjs');
    await writeFile(
      entry,
      `
      process.send({type:'diagnostic',message:JSON.stringify({
        electron:process.env.ELECTRON_RUN_AS_NODE,
        auth:process.env.LODY_AUTH_TOKEN,
        supervisor:process.env.LODY_SUPERVISOR_TOKEN,
        nodeOptions:process.env.NODE_OPTIONS,
      })});
      process.send({type:'origin',origin:'https://fixture-quick.trycloudflare.com'});
      process.on('message',()=>process.disconnect());
    `
    );
    const child = await startCloudflaredProcess({
      binary,
      workerPath: entry,
      proxyOrigin: 'http://127.0.0.1:5173',
      signal: new AbortController().signal,
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        LODY_AUTH_TOKEN: 'private',
        LODY_SUPERVISOR_TOKEN: 'private',
        NODE_OPTIONS: '--require=/untrusted/hook',
      },
    });
    try {
      expect(child.diagnostic()).toBe(JSON.stringify({ electron: '1' }));
    } finally {
      await child.stop();
    }
  });

  it('cancels pending allocation and awaits native cleanup before rejecting', async () => {
    const local = await fixture();
    const controller = new AbortController();
    const pending = startCloudflaredProcess({
      binary,
      workerPath,
      proxyOrigin: local.proxyOrigin,
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toThrow('cancelled allocation');
    try {
      const { info } = await local.connected;
      controller.abort(new Error('cancelled allocation'));
      await rejected;
      expect(exists(info.pid)).toBe(false);
      expect(exists(info.ownerPid)).toBe(false);
      await expect(access(info.config)).rejects.toThrow();
    } finally {
      controller.abort();
      await Promise.allSettled([pending.then((child) => child.stop())]);
      await local.close();
    }
  });

  it('does not hide owned configuration cleanup failure', async () => {
    const local = await fixture();
    const controller = new AbortController();
    const pending = startCloudflaredProcess({
      binary,
      workerPath,
      proxyOrigin: local.proxyOrigin,
      signal: controller.signal,
    });
    try {
      const { socket, info } = await local.connected;
      socket.write('origin\n');
      const child = await pending;
      // Delete only this fixture's known owned directory to make its required
      // final removal fail deterministically, after the native process exits.
      await rm(dirname(info.config), { recursive: true });
      await expect(child.stop()).rejects.toThrow('ENOENT');
      expect((await child.closed)?.stage).toBe('stop');
      expect(exists(info.pid)).toBe(false);
      expect(exists(info.ownerPid)).toBe(false);
    } finally {
      controller.abort();
      await Promise.allSettled([pending.then((child) => child.stop())]);
      await local.close();
    }
  });

  it('fails a missing worker bundle without a source-loader fallback', async () => {
    await expect(
      startCloudflaredProcess({
        binary,
        workerPath: join(root, 'absent.mjs'),
        proxyOrigin: 'http://127.0.0.1:5173',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('cloudflared lifecycle worker exited (1)');
  });
});
