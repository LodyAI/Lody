/**
 * Content author authority and snapshot admission through the host gateway.
 * Every test here uses real crypto, real streams-crdt, real sqlite Riverrun and
 * the real lab honest host.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  loroTailOffset,
  putLoroSnapshot,
  readLoro,
  sealLoroSnapshot,
  uploadLoroSnapshot,
  writeLoro,
  type ContentClient,
} from '../src/platform/content-session';
import { deviceHex, generateDevice } from '../src/platform/device';
import { LORO_STREAM } from '../src/platform/protocol';
import { cleanupLab, labClient, launchLab } from '../src/fixtures';
import type { HonestClient } from '../src/actors';

afterEach(() => cleanupLab());

/** Every listed member joins as a writer; only the first receives the epoch key. */
async function orgWithWriters(names: readonly string[]) {
  const host = await launchLab();
  const alice = await labClient({ host, account: 'alice' });
  await alice.createSpace();
  await alice.readLedger();
  const members: Record<string, HonestClient> = {};
  for (const name of names) {
    const member = await labClient({ host, account: name });
    const join = await member.requestJoin(alice.genesisHex!);
    expect((await alice.approveJoin(join)).status).toBe('committed');
    await member.readLedger();
    if (Object.keys(members).length === 0) {
      await alice.deliverEpochKey(member.device, 0);
      const frames = await member.readKeyFrames();
      await member.receiveEpochKey(alice.device, 0, frames[0]!);
    }
    members[name] = member;
  }
  await alice.readLedger();
  return { host, alice, members };
}

async function removeWriter(owner: HonestClient, member: HonestClient) {
  const ledger = await owner.readLedger();
  const row = ledger.state.devices.get(deviceHex(member.device));
  if (!row) throw new Error('member-device-missing');
  return owner.removeMember(row.membershipId);
}

/** Lab ContentClient sealing with identity claims chosen by `bob`, sent over Bob's
 *  credential. Bob's own client "believes" `device` belongs to `victim`'s membership. */
async function forgedIdentityClient(
  bob: HonestClient,
  victim: HonestClient,
  device: HonestClient['device']
): Promise<ContentClient> {
  const truth = (await victim.readLedger()).state;
  const victimRow = truth.devices.get(deviceHex(victim.device))!;
  const devices = new Map(truth.devices);
  devices.set(deviceHex(device), { ...victimRow });
  const lie = { ...truth, devices };
  return {
    baseUrl: bob.baseUrl,
    genesisHex: bob.genesisHex,
    device,
    account: bob.account,
    membershipId: victimRow.membershipId,
    epochKeys: bob.epochKeys,
    canWriteDocument: true,
    currentEpoch: () => bob.currentEpoch(),
    fetch: (input, init) => bob.fetch(input, init),
    contentAuthority: () => ({ state: lie, wasDeviceAdmitted: () => true }),
  };
}

async function rawLoroLog(client: HonestClient): Promise<Uint8Array> {
  const response = await client.fetch(`/ds/${client.genesisHex}/${LORO_STREAM}?offset=-1`);
  expect(response.ok).toBe(true);
  return new Uint8Array(await response.arrayBuffer());
}

async function currentSnapshot(client: HonestClient) {
  const head = await client.fetch(`/ds/${client.genesisHex}/${LORO_STREAM}`, { method: 'HEAD' });
  const offset = head.headers.get('Stream-Snapshot-Offset');
  if (!offset || offset === '-1') return null;
  const got = await client.fetch(
    `/ds/${client.genesisHex}/${LORO_STREAM}/snapshot/${encodeURIComponent(offset)}`
  );
  expect(got.ok).toBe(true);
  return { offset, body: new Uint8Array(await got.arrayBuffer()) };
}

describe('content author identity comes from the verified ledger', () => {
  it('refuses an update signed by a never-admitted key that claims another member', async () => {
    const { alice, members } = await orgWithWriters(['bob']);
    const bob = members['bob']!;
    await writeLoro(alice, 'alice-base');
    const ghost = await generateDevice();
    expect((await alice.readLedger()).state.devices.has(deviceHex(ghost))).toBe(false);

    await writeLoro(await forgedIdentityClient(bob, alice, ghost), 'forged-as-alice');
    expect(Buffer.from(await rawLoroLog(alice)).includes(Buffer.from(ghost.publicKey))).toBe(true);
    expect(await readLoro(alice).catch(() => 'refused')).not.toContain('forged-as-alice');
  });

  it('derives snapshot authors from the verified signer even when local caller identity lies', async () => {
    const { alice, members } = await orgWithWriters(['bob']);
    const bob = members['bob']!;
    const forged = await forgedIdentityClient(bob, alice, bob.device);
    await uploadLoroSnapshot(forged, 'snapshot-from-bob');
    expect(await currentSnapshot(alice)).not.toBeNull();
    const ledger = await alice.readLedger();
    expect(ledger.contentIdentity(deviceHex(bob.device))).toMatchObject({
      kind: 'member',
      device: deviceHex(bob.device),
      memberInstance: Buffer.from(
        ledger.state.devices.get(deviceHex(bob.device))!.membershipId
      ).toString('hex'),
    });
    expect(ledger.contentIdentity(deviceHex(bob.device))).not.toEqual(
      ledger.contentIdentity(deviceHex(alice.device))
    );
  });

  it('keeps honest authors, including a later-revoked device, readable', async () => {
    const { alice, members } = await orgWithWriters(['bob']);
    const bob = members['bob']!;
    await writeLoro(bob, 'bob-history');
    expect((await removeWriter(alice, bob)).status).toBe('committed');
    expect(await readLoro(alice)).toContain('bob-history');
  });
});

describe('host snapshot admission offsets', () => {
  it('refuses offsets Riverrun cannot accept, so one writer cannot pin current', async () => {
    const { alice, members } = await orgWithWriters(['bob']);
    const bob = members['bob']!;
    await writeLoro(alice, 'alice-base');
    const tail = await loroTailOffset(alice);
    for (const offset of ['9007199254740991', 'x']) {
      const poison = await sealLoroSnapshot(bob, offset, 'poison');
      const poisoned = await putLoroSnapshot(bob, offset, poison);
      expect(poisoned.status).toBe(400);
      expect(await poisoned.json()).toEqual({ error: 'snapshot-offset-out-of-range' });
    }
    const honest = await sealLoroSnapshot(alice, tail, 'honest');
    expect((await putLoroSnapshot(alice, tail, honest)).ok).toBe(true);
    expect((await currentSnapshot(alice))!.offset).toBe(tail);
  });

  it('never moves current back when an older admitted snapshot is replayed', async () => {
    const { host, alice, members } = await orgWithWriters(['bob', 'carol']);
    const bob = members['bob']!;
    const carol = members['carol']!;
    const start = 1_900_000_000_000;
    host.setNow(start);
    for (const client of [alice, bob, carol]) await client.reauth();

    await writeLoro(alice, 'one');
    const t1 = await loroTailOffset(alice);
    const s1 = await sealLoroSnapshot(bob, t1, 'bob-snapshot');
    expect((await putLoroSnapshot(bob, t1, s1)).ok).toBe(true);
    await writeLoro(alice, 'two');
    const t2 = await loroTailOffset(alice);
    const s2 = await sealLoroSnapshot(alice, t2, 'alice-snapshot');
    expect((await putLoroSnapshot(alice, t2, s2)).ok).toBe(true);

    expect((await removeWriter(alice, bob)).status).toBe('committed');
    host.setNow(start + 20 * 60 * 1000);
    await carol.reauth();
    await alice.reauth();

    // Carol never signed s1: identical bytes are not her credential.
    expect((await putLoroSnapshot(carol, t1, s1)).ok).toBe(false);
    // Alice's exact retry of the current snapshot stays idempotent.
    expect((await putLoroSnapshot(alice, t2, s2)).ok).toBe(true);
    const now = await currentSnapshot(alice);
    expect(now!.offset).toBe(t2);
    expect(now!.body).toEqual(s2);
  });
});
