import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { launchHost, tempDir } from './helpers';
import { startDemoHost } from '../src/host';

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

describe('D0 start/stop', () => {
  it('listens on loopback, serves health, and creates a riverrun sqlite file', async () => {
    const host = await launchHost();
    expect(host.baseUrl.startsWith('http://127.0.0.1:')).toBe(true);
    const health = await fetch(`${host.baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');
    const ready = await fetch(`${host.baseUrl}/readyz`);
    const body = (await ready.json()) as { riverrunDbPath: string; riverrun: string };
    expect(body.riverrun.startsWith('http://127.0.0.1:')).toBe(true);
    expect(existsSync(body.riverrunDbPath)).toBe(true);
    expect(existsSync(join(host.dataDir, 'host.sqlite'))).toBe(true);
  });

  it('can start, stop, and start again on a fresh data dir', async () => {
    const dir = tempDir('e2ee-demo-restart-');
    const first = await startDemoHost({ dataDir: dir, host: '127.0.0.1', port: 0, testMode: true });
    expect((await fetch(`${first.baseUrl}/healthz`)).status).toBe(200);
    await first.close();
    const second = await startDemoHost({
      dataDir: dir,
      host: '127.0.0.1',
      port: 0,
      testMode: true,
    });
    expect((await fetch(`${second.baseUrl}/healthz`)).status).toBe(200);
    await second.close();
  });

  it('cli process writes pid and shuts down on SIGTERM', async () => {
    const dir = tempDir('e2ee-demo-cli-');
    const child = spawn(
      process.execPath,
      [
        '--import',
        tsxLoader,
        join(here, '../src/cli.ts'),
        '--data-dir',
        dir,
        '--port',
        '0',
        '--test',
      ],
      { cwd: join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const output = await new Promise<string>((resolve, reject) => {
      let text = '';
      child.stdout.on('data', (chunk) => {
        text += String(chunk);
        if (text.includes('listening')) resolve(text);
      });
      child.on('error', reject);
      setTimeout(() => reject(new Error(`cli-timeout:${text}`)), 15_000);
    });
    expect(output).toContain('http://127.0.0.1:');
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    expect(pid).toBe(child.pid);
    child.kill('SIGTERM');
    const status = await new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code))
    );
    expect(status === 0 || status === null).toBe(true);
  });
});
