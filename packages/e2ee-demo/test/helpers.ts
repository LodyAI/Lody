import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { startDemoHost, type RunningDemoHost } from '../src/host';
import { DemoSession } from '../src/session';

const dirs: string[] = [];
const hosts: RunningDemoHost[] = [];

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix = 'e2ee-demo-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export async function launchHost(options?: { now?: () => number }): Promise<RunningDemoHost> {
  const host = await startDemoHost({
    dataDir: tempDir('e2ee-demo-host-'),
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
