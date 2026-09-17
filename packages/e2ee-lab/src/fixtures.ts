import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportDevice, generateDevice, importDevice } from './platform/device';
import { HonestClient } from './actors';
import { startLabBackend, type LabBackend } from './backend';
import { liveEntropy, type Entropy } from '@lody/e2ee-core';
import { prefixedEntropy } from './entropy';
import type { LabRuntime } from './runtime';

const dirs: string[] = [];
const hosts: LabBackend[] = [];

export function trackDir(dir: string): string {
  dirs.push(dir);
  return dir;
}

export function tempDir(prefix: string): string {
  return trackDir(mkdtempSync(join(tmpdir(), prefix)));
}

export async function cleanupLab(): Promise<void> {
  while (hosts.length > 0) {
    try {
      await hosts.pop()!.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export async function launchLab(dataDir?: string): Promise<LabBackend> {
  const host = await startLabBackend({
    dataDir: dataDir ?? tempDir('e2ee-lab-host-'),
    host: '127.0.0.1',
    port: 0,
    testMode: true,
  });
  hosts.push(host);
  return host;
}

export async function labClient(input: {
  host: { baseUrl: string };
  account: string;
  runtime?: LabRuntime;
  entropy?: Entropy;
  device?: string;
  clientDir?: string;
  now?: () => number;
}): Promise<HonestClient> {
  const device = input.device ? await importDevice(input.device) : await generateDevice();
  const client = new HonestClient({
    baseUrl: input.host.baseUrl,
    clientDir: input.clientDir ?? tempDir(`e2ee-lab-${input.account}-`),
    account: input.account,
    testMode: true,
    device,
    now: input.now,
    entropy: prefixedEntropy(input.account, input.entropy ?? liveEntropy),
    fetch: input.runtime?.gatedFetch(input.account),
  });
  await client.start();
  return client;
}

export async function snapshotDevices(
  clients: Record<string, HonestClient>
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, client] of Object.entries(clients)) {
    out[name] = await exportDevice(client.device);
  }
  return out;
}
