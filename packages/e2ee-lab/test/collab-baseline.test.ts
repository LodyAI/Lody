import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLoro, writeLoro } from '../../e2ee-demo/src/content-session';
import { HonestClient } from '../src/actors';
import { startLabBackend, type LabBackend } from '../src/backend';
import { emptyScheduler, recordEvent } from '../src/scheduler';

const dirs: string[] = [];
const hosts: LabBackend[] = [];

afterEach(async () => {
  while (hosts.length > 0) {
    try {
      await hosts.pop()!.close();
    } catch {
      /* restart tests close explicitly */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function launch(dataDir?: string): Promise<LabBackend> {
  const host = await startLabBackend({
    dataDir: dataDir ?? tempDir('e2ee-lab-host-'),
    host: '127.0.0.1',
    port: 0,
    testMode: true,
  });
  hosts.push(host);
  return host;
}

async function client(host: { baseUrl: string }, account: string): Promise<HonestClient> {
  const session = new HonestClient({
    baseUrl: host.baseUrl,
    clientDir: tempDir(`e2ee-lab-${account}-`),
    account,
    testMode: true,
  });
  await session.start();
  return session;
}

describe('P1 persistent three-client collaboration', () => {
  it('invites two members, edits, reconnects offline, and resumes after host restart', async () => {
    let scheduler = emptyScheduler();
    const host = await launch();
    const alice = await client(host, 'alice');
    const bob = await client(host, 'bob');
    const carol = await client(host, 'carol');
    await alice.createSpace();
    scheduler = recordEvent(scheduler, {
      actor: 'alice',
      operation: 'create',
      phase: 'cursor-saved',
    }).state;

    const bobJoin = await bob.requestJoin(alice.genesisHex!);
    expect((await alice.approveJoin(bobJoin)).status).toBe('committed');
    await alice.deliverEpochKey(bob.device, 0);
    await bob.readLedger();
    const bobFrames = await bob.readKeyFrames();
    expect(bobFrames.length).toBeGreaterThan(0);
    await bob.receiveEpochKey(alice.device, 0, bobFrames[0]!);

    const carolJoin = await carol.requestJoin(alice.genesisHex!);
    expect((await alice.approveJoin(carolJoin)).status).toBe('committed');
    await carol.readLedger();
    expect((await carol.readLedger()).state.members.size).toBe(3);

    await alice.readLedger();
    await bob.readLedger();
    await writeLoro(alice, 'alice-online');
    expect(await readLoro(bob)).toContain('alice-online');
    await writeLoro(bob, 'bob-edit');
    expect(await readLoro(alice)).toContain('bob-edit');

    const bobDir = bob.clientDir;
    const bobDevice = bob.device;
    const genesis = alice.genesisHex!;
    const bob2 = new HonestClient({
      baseUrl: host.baseUrl,
      clientDir: bobDir,
      account: 'bob',
      testMode: true,
      device: bobDevice,
    });
    await bob2.start();
    await bob2.adoptGenesis(genesis);
    await bob2.readLedger();
    expect(await readLoro(bob2)).toContain('alice-online');
    await writeLoro(bob2, 'bob-reconnect');
    expect(await readLoro(alice)).toContain('bob-reconnect');

    const dataDir = host.dataDir;
    await host.close();
    const restarted = await launch(dataDir);
    const alice2 = new HonestClient({
      baseUrl: restarted.baseUrl,
      clientDir: alice.clientDir,
      account: 'alice',
      testMode: true,
      device: alice.device,
    });
    await alice2.start();
    await alice2.adoptGenesis(genesis);
    const carol2 = new HonestClient({
      baseUrl: restarted.baseUrl,
      clientDir: carol.clientDir,
      account: 'carol',
      testMode: true,
      device: carol.device,
    });
    await carol2.start();
    await carol2.adoptGenesis(genesis);
    expect((await alice2.readLedger()).length).toBeGreaterThanOrEqual(3);
    expect((await carol2.readLedger()).state.members.size).toBe(3);
    expect(await readLoro(alice2)).toContain('bob-reconnect');
    expect(scheduler.events.map((event) => event.eventId)).toEqual(['e1']);
  });
});
