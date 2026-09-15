import { describe, expect, it } from 'vitest';
import {
  assertSnapshotCiphertext,
  bootstrapLoroFromSnapshot,
  readFlock,
  readLoro,
  uploadLoroSnapshot,
  writeFlock,
  writeLoro,
} from '../src/content-session';
import { launchHost, session, tempDir } from './helpers';
import { DemoSession } from '../src/session';

describe('D3 Loro and Flock encrypted collab', () => {
  it('writes encrypted Loro text that a second client can read from the live log', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    const bob = await session(host, 'bob');
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    await alice.approveJoin(join);
    await alice.deliverEpochKey(bob.device, 0);
    const frames = await bob.readKeyFrames();
    expect(frames.length).toBeGreaterThan(0);
    await bob.receiveEpochKey(alice.device, 0, frames[0]!);
    await alice.readLedger();
    await writeLoro(alice, 'hello-e2ee');
    await bob.readLedger();
    const text = await readLoro(bob);
    expect(text).toContain('hello-e2ee');
  });

  it('writes encrypted Flock data that a second client can read', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    const bob = await session(host, 'bob');
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    await alice.approveJoin(join);
    await alice.deliverEpochKey(bob.device, 0);
    const frames = await bob.readKeyFrames();
    await bob.receiveEpochKey(alice.device, 0, frames[0]!);
    await alice.readLedger();
    await writeFlock(alice, 'flock-secret');
    await bob.readLedger();
    expect(await readFlock(bob)).toContain('flock-secret');
  });

  it('uploads a snapshot, survives host restart, and bootstraps a brand-new client from admitted ciphertext', async () => {
    const dir = tempDir('e2ee-demo-snap-');
    const host = await launchHost({ dataDir: dir });
    const alice = await session(host, 'alice');
    await alice.createSpace();
    await alice.readLedger();
    await uploadLoroSnapshot(alice, 'snapshot-secret');
    const cipher = await assertSnapshotCiphertext(alice, 'snapshot-secret');
    expect(cipher.byteLength).toBeGreaterThan(0);
    const genesisHex = alice.genesisHex!;
    const device = alice.device;
    const clientDir = alice.clientDir;
    await host.close();

    const restarted = await launchHost({ dataDir: dir });
    const fresh = new DemoSession({
      baseUrl: restarted.baseUrl,
      clientDir,
      account: 'alice',
      testMode: true,
      device,
    });
    await fresh.start();
    await fresh.adoptGenesis(genesisHex);
    await fresh.readLedger();
    const bootstrapped = await bootstrapLoroFromSnapshot(fresh, 'snapshot-secret');
    expect(bootstrapped.text).toContain('snapshot-secret');
    expect(bootstrapped.fetches.some((entry) => entry.includes('/bootstrap'))).toBe(true);
  });
});
