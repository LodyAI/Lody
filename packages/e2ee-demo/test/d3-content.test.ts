import { describe, expect, it } from 'vitest';
import { readFlock, readLoro, writeFlock, writeLoro } from '../src/content-session';
import { launchHost, session } from './helpers';

describe('D3 Loro and Flock encrypted collab', () => {
  it('writes encrypted Loro text that a second client can bootstrap', async () => {
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
});
