import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateDevice } from '../src/platform/device';
import { HonestClient } from '../src/actors';
import { startLabBackend, type LabBackend } from '../src/backend';
import { firstDivergence } from '../src/replay';
import { emptyScheduler, recordEvent, type LabEvent } from '../src/scheduler';

const dirs: string[] = [];
const hosts: LabBackend[] = [];

afterEach(async () => {
  while (hosts.length > 0) {
    try {
      await hosts.pop()!.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function casRace(): Promise<{ events: readonly LabEvent[]; statuses: string[] }> {
  const host = await startLabBackend({
    dataDir: tempDir('e2ee-lab-cas-'),
    host: '127.0.0.1',
    port: 0,
    testMode: true,
  });
  hosts.push(host);
  const alice = new HonestClient({
    baseUrl: host.baseUrl,
    clientDir: tempDir('e2ee-lab-cas-alice-'),
    account: 'alice',
    testMode: true,
  });
  await alice.start();
  const twin = new HonestClient({
    baseUrl: host.baseUrl,
    clientDir: tempDir('e2ee-lab-cas-twin-'),
    account: 'alice',
    testMode: true,
  });
  await twin.start();
  await alice.createSpace();
  twin.device = alice.device;
  await twin.reauth();
  await twin.adoptGenesis(alice.genesisHex!);
  let scheduler = emptyScheduler();
  scheduler = recordEvent(scheduler, {
    actor: 'alice',
    operation: 'submit',
    phase: 'request-queued',
  }).state;
  scheduler = recordEvent(scheduler, {
    actor: 'twin',
    operation: 'submit',
    phase: 'request-queued',
  }).state;
  const extra = await generateDevice();
  const other = await generateDevice();
  const results = await Promise.allSettled([
    alice.admitDevice(extra, 'personal', false),
    twin.admitDevice(other, 'personal', false),
  ]);
  const statuses = results.map((row) =>
    row.status === 'fulfilled' ? row.value.status : 'rejected'
  );
  scheduler = recordEvent(scheduler, {
    actor: 'cas',
    operation: 'submit',
    phase: 'one-committed',
  }).state;
  return { events: scheduler.events, statuses };
}

describe('P2 CAS replay across fresh directories', () => {
  it('records the same event shape in three new data dirs and flags a mutated schedule', async () => {
    const runs = [await casRace(), await casRace(), await casRace()];
    for (const run of runs) {
      expect(run.statuses).toContain('committed');
      expect(run.statuses.some((status) => status === 'conflict' || status === 'rejected')).toBe(
        true
      );
    }
    expect(firstDivergence(runs[0]!.events, runs[1]!.events)).toBeNull();
    expect(firstDivergence(runs[0]!.events, runs[2]!.events)).toBeNull();
    const mutated = runs[0]!.events.map((event, index) =>
      index === 0 ? { ...event, actor: 'intruder' } : event
    );
    expect(firstDivergence(runs[0]!.events, mutated)?.index).toBe(0);
  });
});
