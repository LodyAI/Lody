import { describe, expect, it } from 'vitest';
import { Ledger } from '@lody/e2ee-core';
import { decodeRecord } from '@lody/e2ee-core/ledger';
import { fromHex } from '../src/bytes';
import { generateDevice } from '../src/device';
import { launchHost, session } from './helpers';
import type { ComparisonWire } from '../src/protocol';

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
    await bob.publishNote();
    const extra = await (await import('../src/device')).generateDevice();
    expect((await alice.admitDevice(extra, 'personal', false)).status).toBe('committed');
    await alice.publishNote();
    const response = await alice.fetch(`/v1/spaces/${alice.genesisHex}/notes`);
    const payload = (await response.json()) as {
      notes: Array<{ deviceHex: string; body: string }>;
    };
    expect(payload.notes).toHaveLength(2);
    const notes = payload.notes.map((row) => JSON.parse(row.body) as ComparisonWire);
    const decoded = decodeRecord(alice.genesis!);
    if (decoded.body.type !== 'genesis') throw new Error('not-genesis');
    const comparison = Ledger.compareNotes(
      {
        genesis: fromHex(notes[0]!.genesis),
        length: notes[0]!.length,
        head: fromHex(notes[0]!.head),
        stateDigest: fromHex(notes[0]!.stateDigest),
        noteSigner: fromHex(notes[0]!.noteSigner),
      },
      {
        genesis: fromHex(notes[1]!.genesis),
        length: notes[1]!.length,
        head: fromHex(notes[1]!.head),
        stateDigest: fromHex(notes[1]!.stateDigest),
        noteSigner: fromHex(notes[1]!.noteSigner),
      },
      { originalEndorser: decoded.body.fields.signer }
    );
    expect(comparison.kind).toBe('pending-sync');
    expect(comparison.kind).not.toBe('agree');
  });
});
