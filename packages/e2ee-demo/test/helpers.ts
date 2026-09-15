import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach } from 'vitest';
import { startDemoHost, type RunningDemoHost } from '../src/host';
import { DemoSession } from '../src/session';

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const children: ChildProcess[] = [];

const dirs: string[] = [];
const hosts: RunningDemoHost[] = [];

afterEach(async () => {
  while (hosts.length > 0) {
    try {
      await hosts.pop()!.close();
    } catch {
      /* already closed for restart tests */
    }
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function buildUi(): void {
  const result = spawnSync('pnpm', ['exec', 'vite', 'build'], {
    cwd: join(here, '..'),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`vite-build-failed:${result.stdout}${result.stderr}`);
  }
}

export async function spawnCli(dataDir: string): Promise<{ baseUrl: string; child: ChildProcess }> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      tsxLoader,
      join(here, '../src/cli.ts'),
      '--data-dir',
      dataDir,
      '--port',
      '0',
      '--test',
    ],
    { cwd: join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  children.push(child);
  const output = await new Promise<string>((resolve, reject) => {
    let text = '';
    child.stdout?.on('data', (chunk) => {
      text += String(chunk);
      if (text.includes('listening')) resolve(text);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!text.includes('listening')) reject(new Error(`cli-exit-${code}:${text}`));
    });
  });
  const match = output.match(/e2ee-demo listening (http:\/\/127\.0\.0\.1:\d+)/);
  if (!match?.[1]) throw new Error(`cli-url-missing:${output}`);
  return { baseUrl: match[1], child };
}

export function tempDir(prefix = 'e2ee-demo-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export async function launchHost(options?: {
  now?: () => number;
  dataDir?: string;
}): Promise<RunningDemoHost> {
  const host = await startDemoHost({
    dataDir: options?.dataDir ?? tempDir('e2ee-demo-host-'),
    host: '127.0.0.1',
    port: 0,
    testMode: true,
    wallClock: options?.now,
  });
  hosts.push(host);
  return host;
}

export async function session(
  host: { baseUrl: string },
  account: string,
  now?: () => number
): Promise<DemoSession> {
  const client = new DemoSession({
    baseUrl: host.baseUrl,
    clientDir: tempDir(`e2ee-demo-${account}-`),
    account,
    now,
    testMode: true,
  });
  await client.start();
  return client;
}

export async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

export function frameRecord(record: Uint8Array): Uint8Array {
  const framed = new Uint8Array(4 + record.length);
  new DataView(framed.buffer).setUint32(0, record.length, false);
  framed.set(record, 4);
  return framed;
}

export function findSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
