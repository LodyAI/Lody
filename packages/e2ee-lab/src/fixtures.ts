import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportDevice, generateDevice, importDevice } from './platform/device';
import { HonestClient } from './actors';
import { startLabBackend, type LabBackend } from './backend';
import { liveEntropy, type Entropy } from '@lody/e2ee-core';
import { prefixedEntropy } from './entropy';
import { LabRuntime } from './runtime';
import { clearContentWrites } from './content-trace';
import type { Failpoint } from './platform/protocol';
import { canPermitEvent, type LabEvent } from './scheduler';

const dirs: string[] = [];
const hosts: LabBackend[] = [];
const clients: HonestClient[] = [];

export function trackDir(dir: string): string {
  dirs.push(dir);
  return dir;
}

export function tempDir(prefix: string): string {
  return trackDir(mkdtempSync(join(tmpdir(), prefix)));
}

export async function cleanupLab(): Promise<void> {
  clearContentWrites();
  LabRuntime.closeAll();
  while (clients.length > 0) {
    try {
      clients.pop()!.close();
    } catch {
      /* already closed */
    }
  }
  while (hosts.length > 0) {
    try {
      await hosts.pop()!.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function setHostFailpoint(host: LabBackend, name: Failpoint): void {
  host.setFailpoint(name);
}

export function setHostNow(host: LabBackend, now: number | null): void {
  host.setNow(now);
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
  fs?: import('./services/fs').LabFsShape;
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
    runtime: input.runtime,
    fs: input.fs,
  });
  await client.start();
  clients.push(client);
  return client;
}

export async function snapshotDevices(
  targets: Record<string, HonestClient>
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, client] of Object.entries(targets)) {
    out[name] = await exportDevice(client.device);
  }
  return out;
}

/**
 * Permit eligible non-matching events until a `match` event is requested and
 * runnable; returns it without permitting so the caller controls its timing.
 */
export async function permitUntil(
  runtime: LabRuntime,
  match: (event: LabEvent) => boolean,
  maxSteps = 512
): Promise<LabEvent> {
  for (let step = 0; step < maxSteps; step++) {
    const eligible = runtime
      .events()
      .filter(
        (event) =>
          event.status === 'requested' &&
          !runtime.paused.has(event.actor) &&
          canPermitEvent(runtime.state, event.eventId)
      );
    const hit = eligible.find(match);
    if (hit) return hit;
    const next = eligible.find((event) => !match(event));
    if (next) {
      runtime.permit(next.eventId);
      continue;
    }
    const requested = runtime.events().filter((e) => e.status === 'requested').length;
    await runtime.whenRequested(requested + 1);
  }
  throw new Error('permit-until-exhausted');
}

/** Permit every eligible event on a timer until the returned stop runs. */
export function drainRuntime(runtime: LabRuntime): () => void {
  const timer = setInterval(() => {
    let guard = 0;
    while (runtime.permitNext() !== null && guard++ < 1024) {
      /* keep pumping while work produces new requests */
    }
  }, 0);
  return () => clearInterval(timer);
}

export async function drainUntil<T>(runtime: LabRuntime, work: Promise<T>): Promise<T> {
  const stop = drainRuntime(runtime);
  try {
    return await work;
  } finally {
    stop();
  }
}
