import { Deferred, Effect, Layer } from 'effect';
import { ScheduleDriver } from './driver';
import { runLabPromise } from './services/run';
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
import type { LabFetch } from './services/http';
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
  await LabRuntime.disposeAll();
  while (clients.length > 0) {
    try {
      await clients.pop()!.close();
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
  fetch?: LabFetch;
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
    fetch: input.fetch ?? input.runtime?.gatedFetch(input.account),
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

/** Event-driven drain. Await the returned stop to release its scoped queue/fibers. */
export function drainRuntime(runtime: LabRuntime): () => Promise<void> {
  const stopped = Deferred.makeUnsafe<void>();
  const lifetime = runLabPromise(Deferred.await(stopped), Layer.empty);
  const driving = new ScheduleDriver(runtime, 'record').drive(lifetime).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error })
  );
  const stop = async () => {
    Deferred.doneUnsafe(stopped, Effect.void);
    const outcome = await driving;
    if (!outcome.ok) throw outcome.error;
  };
  runtime.addFinalizer(Effect.promise(stop));
  return stop;
}

export function drainUntil<T>(runtime: LabRuntime, work: Promise<T>): Promise<T> {
  return new ScheduleDriver(runtime, 'record').drive(work);
}
