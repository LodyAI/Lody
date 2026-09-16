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
    const server = await bob.compareRemote();
    expect(server.kind).toBe('agree');
    expect(compareLabel(server.kind, 'server')).toBe('untrusted');
    expect(compareLabel(server.kind, 'server')).not.toBe('checked');
    const imported = await alice.compareIndependent(await bob.exportNote());
    expect(imported.kind).toBe('agree');
    expect(imported.independent).toBe(true);
    expect(compareLabel(imported.kind, 'independent', true)).toBe('checked');
    const fromOwner = await bob.compareIndependent(await alice.exportNote());
    expect(fromOwner.kind).toBe('agree');
    expect(fromOwner.independent).toBeFalsy();
    expect(compareLabel(fromOwner.kind, 'independent', false)).toBe('untrusted');
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

  it('shows inconsistent rather than checked when independently imported notes disagree', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    const bob = await session(host, 'bob');
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    await alice.approveJoin(join);
    const honest = await alice.exportNote();
    const forged = {
      ...honest,
      head: 'aa'.repeat(32),
      stateDigest: 'bb'.repeat(32),
      noteSigner: deviceHex(bob.device),
    };
    const compared = await alice.compareIndependent(forged);
    expect(compared.kind).toBe('conflict');
    expect(compareLabel(compared.kind, 'independent')).toBe('inconsistent');
    expect(compareLabel(compared.kind, 'independent')).not.toBe('checked');
  });

  it('rejects an outsider posting a copied digest and never labels server notes checked', async () => {
    const host = await launchHost();
    const alice = await session(host, 'alice');
    const outsider = await session(host, 'outsider');
    await alice.createSpace();
    const honest = await alice.exportNote();
    const posted = await outsider.fetch(`/v1/spaces/${alice.genesisHex}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(honest),
    });
    expect(posted.ok).toBe(false);
    const compared = await alice.compareRemote();
    expect(compared.kind).toBe('pending-sync');
    expect(compareLabel(compared.kind, 'server')).not.toBe('checked');
    expect(compareLabel('agree', 'server')).toBe('untrusted');
  });
});
