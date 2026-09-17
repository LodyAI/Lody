import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { cleanupLab, labClient, launchLab, tempDir } from '../src/fixtures';
import { startLabBackend } from '../src/backend';
import { CONTROL_STREAM } from '../src/platform/protocol';

afterEach(() => cleanupLab());

const STREAMS_SHA256 = 'a1314d8fbfaed381505001342d563993ae1f32c0682d9db8252c6f6eb97a391e';
const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

describe('lab host lifecycle', () => {
  it('vendors the continuationOffset streams-crdt tarball', () => {
    const tarball = join(here, '../vendor/streams-crdt.tgz');
    const actual = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    expect(actual).toBe(STREAMS_SHA256);
  });

  it('listens on loopback and creates a riverrun sqlite file', async () => {
    const host = await launchLab();
    expect(host.baseUrl.startsWith('http://127.0.0.1:')).toBe(true);
    expect((await fetch(`${host.baseUrl}/healthz`)).status).toBe(200);
    const ready = await fetch(`${host.baseUrl}/readyz`);
    const body = (await ready.json()) as { riverrunDbPath: string };
    expect(existsSync(body.riverrunDbPath)).toBe(true);
  });

  it('rejects unjoined POST/DELETE on the control stream', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const outsider = await labClient({ host, account: 'outsider' });
    const { genesisHex } = await alice.createSpace();
    const path = `/ds/${genesisHex}/${CONTROL_STREAM}`;
    const before = await alice.fetch(path, { method: 'HEAD' });
    const injected = await outsider.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from([0, 0, 0, 1, 255]),
    });
    const deleted = await outsider.fetch(path, { method: 'DELETE' });
    const after = await alice.fetch(path, { method: 'HEAD' });
    expect(injected.status === 401 || injected.status === 403).toBe(true);
    expect(deleted.status === 401 || deleted.status === 403).toBe(true);
    expect(before.headers.get('stream-next-offset')).toBe(after.headers.get('stream-next-offset'));
    expect((await alice.readLedger()).length).toBe(1);
  });

  it('restarts on the same data directory', async () => {
    const dir = tempDir('e2ee-lab-restart-');
    const first = await startLabBackend({
      dataDir: dir,
      host: '127.0.0.1',
      port: 0,
      testMode: true,
    });
    expect((await fetch(`${first.baseUrl}/healthz`)).status).toBe(200);
    await first.close();
    const second = await startLabBackend({
      dataDir: dir,
      host: '127.0.0.1',
      port: 0,
      testMode: true,
    });
    expect((await fetch(`${second.baseUrl}/healthz`)).status).toBe(200);
    await second.close();
  });

  it('cli process writes pid and shuts down on SIGTERM', async () => {
    const dir = tempDir('e2ee-lab-cli-');
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, join(here, '../src/cli.ts'), '--data-dir', dir, '--port', '0'],
      { cwd: join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const output = await new Promise<string>((resolve, reject) => {
      let text = '';
      child.stdout?.on('data', (chunk) => {
        text += String(chunk);
        if (text.includes('listening')) resolve(text);
      });
      child.on('error', reject);
      child.stderr?.on('data', (chunk) => {
        text += String(chunk);
      });
    });
    expect(output).toContain('http://127.0.0.1:');
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    expect(pid).toBe(child.pid);
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  });

  it('recovers ledger head after kill-after-commit', async () => {
    const dir = tempDir('e2ee-lab-kill-');
    const first = await spawnLab(dir);
    const { HonestClient } = await import('../src/actors');
    const { generateDevice } = await import('../src/platform/device');
    const alice = new HonestClient({
      baseUrl: first.baseUrl,
      clientDir: tempDir('e2ee-lab-kill-alice-'),
      account: 'alice',
      testMode: true,
    });
    await alice.start();
    await alice.createSpace();
    await fetch(`${first.baseUrl}/v1/failpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'kill-after-commit' }),
    });
    await alice.admitDevice(await generateDevice(), 'personal', false).catch(() => undefined);
    await new Promise<void>((resolve) => {
      if (first.child.exitCode !== null) resolve();
      else first.child.on('exit', () => resolve());
    });
    const second = await spawnLab(dir);
    const alice2 = new HonestClient({
      baseUrl: second.baseUrl,
      clientDir: alice.clientDir,
      account: 'alice',
      testMode: true,
      device: alice.device,
    });
    await alice2.start();
    await alice2.adoptGenesis(alice.genesisHex!);
    expect((await alice2.readLedger()).length).toBe(2);
    second.child.kill('SIGTERM');
    await new Promise<void>((resolve) => second.child.on('exit', () => resolve()));
  });
});

async function spawnLab(
  dataDir: string
): Promise<{ baseUrl: string; child: ReturnType<typeof spawn> }> {
  const here = dirname(fileURLToPath(import.meta.url));
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, join(here, '../src/cli.ts'), '--data-dir', dataDir],
    { cwd: join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const output = await new Promise<string>((resolve, reject) => {
    let text = '';
    child.stdout?.on('data', (chunk) => {
      text += String(chunk);
      if (text.includes('listening')) resolve(text);
    });
    child.on('error', reject);
    child.stderr?.on('data', (chunk) => {
      text += String(chunk);
    });
    child.on('exit', (code) => {
      if (!text.includes('listening')) reject(new Error(`cli-exit-${code}:${text}`));
    });
  });
  const match = output.match(/e2ee-lab listening (http:\/\/127\.0\.0\.1:\d+)/);
  if (!match?.[1]) throw new Error(`cli-url-missing:${output}`);
  return { baseUrl: match[1], child };
}
