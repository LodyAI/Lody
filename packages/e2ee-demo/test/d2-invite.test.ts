import { describe, expect, it } from 'vitest';
import { generateDevice, deviceHex } from '../src/device';
import { compareLabel } from '../src/ui/browser-session';
import { launchHost, session } from './helpers';

describe('D2 invite, admin offline owner, digest compare', () => {
  it('lets B request join and A approve; both independently verify the same ledger', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    const bob = await session(host, 'bob');
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    const approved = await alice.approveJoin(join);
    expect(approved.status).toBe('committed');
    await alice.deliverEpochKey(bob.device, 0);
    const aliceView = await alice.readLedger();
    const bobView = await bob.readLedger();
    expect(aliceView.length).toBe(bobView.length);
    expect(Buffer.from(aliceView.head).equals(Buffer.from(bobView.head))).toBe(true);
    await alice.publishNote();
    await bob.publishNote();
    const compared = await bob.compareRemote();
    expect(compared.kind).toBe('agree');
  });

  it('allows Admin to invite while Owner is unused', async () => {
    const host = await launchHost();
    const owner = await session(host, 'owner');
    const admin = await session(host, 'admin');
    const guest = await session(host, 'carol');
    await owner.createSpace();
    const join = await admin.requestJoin(owner.genesisHex!);
    await owner.approveJoin(join, 'admin');
    const manage = await generateDevice();
    const admitted = await admin.admitDevice(manage, 'personal', true);
    expect(admitted.status).toBe('committed');
    admin.device = manage;
    await admin.reauth();
    const request = await guest.requestJoin(owner.genesisHex!);
    const approved = await admin.approveJoin(request);
    expect(approved.status).toBe('committed');
    expect((await owner.readLedger()).state.members.size).toBe(3);
  });

  it('shows inconsistent rather than checked when notes disagree', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    const bob = await session(host, 'bob');
    await alice.createSpace();
    await bob.adoptGenesis(alice.genesisHex!);
    const honest = await alice.publishNote();
    const forged = {
      genesis: honest.genesis,
      length: honest.length,
      head: 'aa'.repeat(32),
      stateDigest: 'bb'.repeat(32),
      noteSigner: deviceHex(bob.device),
    };
    const posted = await bob.fetch(`/v1/spaces/${alice.genesisHex}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(forged),
    });
    expect(posted.ok).toBe(true);
    const compared = await alice.compareRemote();
    expect(compared.kind).toBe('conflict');
    expect(compareLabel(compared.kind)).toBe('inconsistent');
    expect(compareLabel(compared.kind)).not.toBe('checked');
  });
});
