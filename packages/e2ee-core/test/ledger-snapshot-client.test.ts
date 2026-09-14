import { describe, expect, it } from 'vitest';
import { ControlFreshnessLease } from '@lody/e2ee-core';
import { Ledger, LedgerClient, MemoryLedgerStore, MemoryLedgerStream } from '../src/ledger';
import { decodeSnapshotCbor, encodeSnapshotCbor } from '../src/ledger/cbor';
import { commitEpochKey, snapshotSigningBytes } from '../src/ledger/crypto';
import { sealHistoryPacket } from '../src/ledger/keys';
import { encodeSignedSnapshot } from '../src/ledger/snapshot';
import {
  admitDeviceOp,
  append,
  ed25519,
  hex,
  random,
  signGenesis,
  signJoin,
  type DeviceKeys,
} from './ledger-fixtures';

async function signSnapshot(ledger: Ledger, signer: DeviceKeys) {
  const proposal = ledger.prepareSnapshot(signer.publicKey);
  const snapshot = await Ledger.finalizeSnapshot(
    proposal,
    await signer.sign(proposal.signingBytes)
  );
  const headSignature = await signer.sign(proposal.headAttestationSigningBytes);
  return {
    snapshot,
    trust: {
      genesis: proposal.genesis,
      endorser: signer.publicKey,
      head: proposal.head,
      headSignature,
    },
  };
}

async function seeded() {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const member = await ed25519();
  const join = await signJoin(created.anchor, member);
  const admitted = await append(created.ledger, owner, {
    type: 'admitMember',
    membershipId: random(16),
    request: join,
  });
  const nextKey = random(32);
  const packet = sealHistoryPacket(nextKey, created.secret, created.anchor, 1);
  const commitment = await commitEpochKey(created.anchor, 1, nextKey);
  const rotated = await append(admitted.ledger, owner, {
    type: 'publishEpoch',
    epoch: 1,
    commitment,
    previousEpochKey: packet,
  });
  const stream = new MemoryLedgerStream();
  stream.records = [created.record, admitted.record, rotated.record];
  const ownerStore = new MemoryLedgerStore();
  const ownerClient = await LedgerClient.open(created.record, ownerStore, stream);
  await ownerClient.read();
  return {
    owner,
    member,
    created,
    ledger: rotated.ledger,
    stream,
    ownerClient,
    records: [created.record, admitted.record, rotated.record],
  };
}

describe('S3 snapshot LedgerClient', () => {
  it('lets two independently keyed clients agree at the same position', async () => {
    const { owner, member, created, ledger, stream, ownerClient } = await seeded();
    const { snapshot, trust } = await signSnapshot(ledger, owner);
    const joiner = await LedgerClient.openFromSnapshot({
      trust,
      snapshot,
      store: new MemoryLedgerStore(),
      stream,
    });
    const extra = await ed25519();
    const suffix = await append(
      ledger,
      owner,
      await admitDeviceOp(created.anchor, extra, 'personal', true)
    );
    await ownerClient.submit(suffix.record);
    const joined = await joiner.read();
    const ownerView = await ownerClient.read();
    expect(joined.origin).toBe('snapshot');
    expect(joined.length).toBe(ownerView.length);
    expect(joined.head).toEqual(ownerView.head);
    const cmp = Ledger.compareNotes(
      joined.comparisonNote(member.publicKey),
      ownerView.comparisonNote(extra.publicKey),
      { originalEndorser: owner.publicKey }
    );
    expect(cmp.kind).toBe('agree');
    if (cmp.kind === 'agree') expect(cmp.independent).toBe(true);
  });

  it('reports conflict when the inviter and an honest member diverge, without picking a side', async () => {
    const { owner, member, ledger, stream, ownerClient } = await seeded();
    const honest = await signSnapshot(ledger, owner);
    const root = decodeSnapshotCbor(honest.snapshot) as unknown[];
    const body = [...(root[0] as unknown[])];
    const auth = [...(body[5] as unknown[])];
    auth[5] = !auth[5];
    body[5] = auth;
    const bodyBytes = encodeSnapshotCbor(body as never);
    const falseSnap = encodeSignedSnapshot(
      bodyBytes,
      await owner.sign(snapshotSigningBytes(bodyBytes))
    );
    const joiner = await LedgerClient.openFromSnapshot({
      trust: honest.trust,
      snapshot: falseSnap,
      store: new MemoryLedgerStore(),
      stream,
    });
    const joined = await joiner.read();
    const honestView = await ownerClient.read();
    const before = joined.head;
    const cmp = Ledger.compareNotes(
      joined.comparisonNote(member.publicKey),
      honestView.comparisonNote(owner.publicKey),
      { originalEndorser: owner.publicKey }
    );
    expect(cmp.kind).toBe('conflict');
    expect((await joiner.read()).head).toEqual(before);
    expect((await ownerClient.read()).head).toEqual(honestView.head);
  });

  it('treats different positions as pending-sync and inviter re-notes as not independent', async () => {
    const { owner, created, ledger, stream, ownerClient } = await seeded();
    const { snapshot, trust } = await signSnapshot(ledger, owner);
    const joiner = await LedgerClient.openFromSnapshot({
      trust,
      snapshot,
      store: new MemoryLedgerStore(),
      stream,
    });
    const behind = await joiner.read();
    const extra = await ed25519();
    const suffix = await append(
      ledger,
      owner,
      await admitDeviceOp(created.anchor, extra, 'personal', true)
    );
    await ownerClient.submit(suffix.record);
    const ahead = await ownerClient.read();
    const pending = Ledger.compareNotes(
      behind.comparisonNote(extra.publicKey),
      ahead.comparisonNote(extra.publicKey),
      { originalEndorser: owner.publicKey }
    );
    expect(pending.kind).toBe('pending-sync');
    const caughtUp = await joiner.read();
    const sameEndorser = Ledger.compareNotes(
      caughtUp.comparisonNote(owner.publicKey),
      ahead.comparisonNote(owner.publicKey),
      { originalEndorser: owner.publicKey }
    );
    expect(sameEndorser.kind).toBe('agree');
    if (sameEndorser.kind === 'agree') expect(sameEndorser.independent).toBe(false);
  });

  it('keeps CAS conflict, revoke, and 15-minute freshness after snapshot join', async () => {
    const { owner, created, ledger, stream, ownerClient } = await seeded();
    const { snapshot, trust } = await signSnapshot(ledger, owner);
    const joiner = await LedgerClient.openFromSnapshot({
      trust,
      snapshot,
      store: new MemoryLedgerStore(),
      stream,
    });
    const phone = await ed25519();
    const laptop = await ed25519();
    const recA = (
      await append(ledger, owner, await admitDeviceOp(created.anchor, phone, 'personal', true))
    ).record;
    const recB = (
      await append(ledger, owner, await admitDeviceOp(created.anchor, laptop, 'personal', false))
    ).record;
    const first = await ownerClient.submit(recA);
    expect(first.status).toBe('committed');
    const second = await joiner.submit(recB);
    expect(second.status).toBe('conflict');
    const afterConflict = await joiner.read();
    expect(afterConflict.head).toEqual(first.ledger.head);
    expect(afterConflict.state.devices.has(hex(phone.publicKey))).toBe(true);

    const revoked = await append(first.ledger, owner, {
      type: 'revokeDevice',
      target: phone.publicKey,
    });
    await ownerClient.submit(revoked.record);
    const afterRevoke = await joiner.read();
    expect(afterRevoke.state.devices.has(hex(phone.publicKey))).toBe(false);

    const genesis = hex(created.anchor);
    const head = hex(afterRevoke.head);
    let now = 1000;
    const lease = new ControlFreshnessLease(
      genesis,
      {
        genesis,
        head,
        length: afterRevoke.length,
        observedAt: 1000,
        expiresAt: 1000 + 15 * 60 * 1000,
      },
      () => now
    );
    lease.assert({ head, length: afterRevoke.length });
    now = 1000 + 15 * 60 * 1000;
    expect(() => lease.assert({ head, length: afterRevoke.length })).toThrow('freshness-expired');
  });

  it('refuses a shorter or swapped-Org snapshot over an accepted journal', async () => {
    const { owner, created, ledger, stream } = await seeded();
    const { snapshot, trust } = await signSnapshot(ledger, owner);
    const store = new MemoryLedgerStore();
    const first = await LedgerClient.openFromSnapshot({ trust, snapshot, store, stream });
    const extra = await ed25519();
    const suffix = await append(
      ledger,
      owner,
      await admitDeviceOp(created.anchor, extra, 'personal', true)
    );
    await first.submit(suffix.record);
    await expect(
      LedgerClient.openFromSnapshot({ trust, snapshot, store, stream })
    ).rejects.toMatchObject({ code: 'replay' });
    const otherOwner = await ed25519();
    const other = await signGenesis(otherOwner);
    const otherSnap = await signSnapshot(other.ledger, otherOwner);
    await expect(
      LedgerClient.openFromSnapshot({
        trust: otherSnap.trust,
        snapshot: otherSnap.snapshot,
        store,
        stream,
      })
    ).rejects.toMatchObject({ code: 'wrong-anchor' });
    const restarted = await LedgerClient.openJournal(trust.genesis, store, stream);
    const view = await restarted.read();
    expect(view.length).toBeGreaterThan(ledger.length);
  });

  it('refuses a second snapshot with the same head but different authorized state', async () => {
    const { owner, ledger, stream } = await seeded();
    const honest = await signSnapshot(ledger, owner);
    const root = decodeSnapshotCbor(honest.snapshot) as unknown[];
    const body = [...(root[0] as unknown[])];
    const auth = [...(body[5] as unknown[])];
    auth[5] = !auth[5];
    body[5] = auth;
    const bodyBytes = encodeSnapshotCbor(body as never);
    const falseSnap = encodeSignedSnapshot(
      bodyBytes,
      await owner.sign(snapshotSigningBytes(bodyBytes))
    );
    const store = new MemoryLedgerStore();
    await LedgerClient.openFromSnapshot({
      trust: honest.trust,
      snapshot: falseSnap,
      store,
      stream,
    });
    const same = await LedgerClient.openFromSnapshot({
      trust: honest.trust,
      snapshot: falseSnap,
      store,
      stream,
    });
    const keptFalse = await same.read();
    expect(keptFalse.head).toEqual(ledger.head);
    expect(keptFalse.state.epoch.rotationRequired).not.toBe(ledger.state.epoch.rotationRequired);
    await expect(
      LedgerClient.openFromSnapshot({
        trust: honest.trust,
        snapshot: honest.snapshot,
        store,
        stream,
      })
    ).rejects.toMatchObject({ code: 'replay' });
    const still = await LedgerClient.openJournal(honest.trust.genesis, store, stream);
    const view = await still.read();
    expect(view.state.epoch.rotationRequired).toBe(keptFalse.state.epoch.rotationRequired);
    expect(view.head).toEqual(keptFalse.head);
  });
});
