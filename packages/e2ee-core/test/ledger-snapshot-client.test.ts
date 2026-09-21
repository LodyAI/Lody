import { describe, expect, it } from 'vitest';
import { ControlFreshnessLease } from '@lody/e2ee-core';
import {
  Ledger,
  LedgerClient,
  MemoryLedgerStore,
  MemoryLedgerStream,
  type LedgerStream,
} from '../src/ledger';
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
      await admitDeviceOp(created.anchor, created.membershipId, extra, 'personal', true)
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
      { originalEndorser: owner.publicKey, confirmedNoteSigners: [extra.publicKey] }
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

  it('keeps a same-head length conflict after journal reopen', async () => {
    const { owner, member, ledger, stream, ownerClient } = await seeded();
    const honest = await signSnapshot(ledger, owner);
    const root = decodeSnapshotCbor(honest.snapshot) as unknown[];
    const body = [...(root[0] as unknown[])];
    const auth = [...(body[5] as unknown[])];
    auth[5] = !auth[5];
    body[2] = (body[2] as number) + 1;
    body[5] = auth;
    const bodyBytes = encodeSnapshotCbor(body as never);
    const falseSnap = encodeSignedSnapshot(
      bodyBytes,
      await owner.sign(snapshotSigningBytes(bodyBytes))
    );
    const store = new MemoryLedgerStore();
    const joiner = await LedgerClient.openFromSnapshot({
      trust: honest.trust,
      snapshot: falseSnap,
      store,
      stream,
    });
    const honestView = await ownerClient.read();
    const first = Ledger.compareNotes(
      (await joiner.read()).comparisonNote(member.publicKey),
      honestView.comparisonNote(owner.publicKey),
      { originalEndorser: owner.publicKey }
    );
    expect(first.kind).toBe('conflict');
    const reopened = await LedgerClient.openJournal(honest.trust.genesis, store, stream);
    const again = Ledger.compareNotes(
      (await reopened.read()).comparisonNote(member.publicKey),
      honestView.comparisonNote(owner.publicKey),
      { originalEndorser: owner.publicKey }
    );
    expect(again.kind).toBe('conflict');
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
      await admitDeviceOp(created.anchor, created.membershipId, extra, 'personal', true)
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
      await append(
        ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', true)
      )
    ).record;
    const recB = (
      await append(
        ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, laptop, 'personal', false)
      )
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
      await admitDeviceOp(created.anchor, created.membershipId, extra, 'personal', true)
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

  it('rejects a wrong-parent record after the authenticated snapshot boundary', async () => {
    const owner = await ed25519();
    const g = await signGenesis(owner);
    const first = await append(
      g.ledger,
      owner,
      await admitDeviceOp(g.anchor, g.membershipId, await ed25519(), 'personal', true)
    );
    const { snapshot, trust } = await signSnapshot(first.ledger, owner);
    const fork = await append(
      g.ledger,
      owner,
      await admitDeviceOp(g.anchor, g.membershipId, await ed25519(), 'personal', true)
    );
    const suffix = await append(
      first.ledger,
      owner,
      await admitDeviceOp(g.anchor, g.membershipId, await ed25519(), 'personal', true)
    );

    const stream = new MemoryLedgerStream();
    stream.records = [g.record, first.record, fork.record];
    const samePage = new MemoryLedgerStore();
    const samePageClient = await LedgerClient.openFromSnapshot({
      trust,
      snapshot,
      stream,
      store: samePage,
    });
    const beforeSame = samePage.journal?.offset;
    await expect(samePageClient.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    expect(samePage.journal?.offset).toBe(beforeSame);

    stream.pageSize = 1;
    const cross = new MemoryLedgerStore();
    const crossClient = await LedgerClient.openFromSnapshot({
      trust,
      snapshot,
      stream,
      store: cross,
    });
    await expect(crossClient.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    expect(cross.journal?.offset).toBe('opaque:2/+');
    expect(cross.journal?.snapshotBound).toBe(true);

    const sequential = new MemoryLedgerStream();
    sequential.records = [g.record, first.record];
    const store = new MemoryLedgerStore();
    const client = await LedgerClient.openFromSnapshot({
      trust,
      snapshot,
      stream: sequential,
      store,
    });
    const joined = await client.read();
    expect(joined.length).toBe(first.ledger.length);
    const boundOffset = store.journal?.offset;
    sequential.records.push(fork.record);
    await expect(client.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    expect(store.journal?.offset).toBe(boundOffset);

    const restarted = await LedgerClient.openJournal(trust.genesis, store, sequential);
    await expect(restarted.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    expect(store.journal?.offset).toBe(boundOffset);

    sequential.records.push(suffix.record);
    await expect(client.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    expect(store.journal?.records).toHaveLength(0);
    expect(store.journal?.offset).toBe(boundOffset);

    const missing = new MemoryLedgerStream();
    missing.records = [fork.record];
    const missingStore = new MemoryLedgerStore();
    const missingClient = await LedgerClient.openFromSnapshot({
      trust,
      snapshot,
      stream: missing,
      store: missingStore,
    });
    const missingOffset = missingStore.journal?.offset;
    await expect(missingClient.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    expect(missingStore.journal?.offset).toBe(missingOffset);

    const honest = new MemoryLedgerStream();
    honest.records = [g.record, first.record, suffix.record];
    const honestStore = new MemoryLedgerStore();
    const honestClient = await LedgerClient.openFromSnapshot({
      trust,
      snapshot,
      stream: honest,
      store: honestStore,
    });
    const view = await honestClient.read();
    expect(view.head).toEqual(suffix.ledger.head);
    expect(view.length).toBe(suffix.ledger.length);
    expect(view.origin).toBe('snapshot');
  });

  it('rejects a foreign genesis after the authenticated snapshot boundary', async () => {
    const owner = await ed25519();
    const g = await signGenesis(owner);
    const first = await append(
      g.ledger,
      owner,
      await admitDeviceOp(g.anchor, g.membershipId, await ed25519(), 'personal', true)
    );
    const { snapshot, trust } = await signSnapshot(first.ledger, owner);
    const suffix = await append(
      first.ledger,
      owner,
      await admitDeviceOp(g.anchor, g.membershipId, await ed25519(), 'personal', true)
    );
    const foreign = await signGenesis(await ed25519());

    const sequential = new MemoryLedgerStream();
    sequential.records = [g.record, first.record];
    const store = new MemoryLedgerStore();
    const client = await LedgerClient.openFromSnapshot({
      trust,
      snapshot,
      stream: sequential,
      store,
    });
    const joined = await client.read();
    expect(joined.length).toBe(first.ledger.length);
    const before = store.journal?.offset;
    sequential.records.push(foreign.record);
    await expect(client.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    expect(store.journal?.offset).toBe(before);
    expect(store.journal?.records).toHaveLength(0);

    const restarted = await LedgerClient.openJournal(trust.genesis, store, sequential);
    await expect(restarted.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    expect(store.journal?.offset).toBe(before);

    sequential.records.push(suffix.record);
    await expect(client.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    expect(store.journal?.offset).toBe(before);
    expect(store.journal?.records).toHaveLength(0);

    const samePage = new MemoryLedgerStream();
    samePage.records = [g.record, first.record, foreign.record];
    const sameStore = new MemoryLedgerStore();
    const sameClient = await LedgerClient.openFromSnapshot({
      trust,
      snapshot,
      stream: samePage,
      store: sameStore,
    });
    const beforeSame = sameStore.journal?.offset;
    await expect(sameClient.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    expect(sameStore.journal?.offset).toBe(beforeSame);

    samePage.pageSize = 1;
    const cross = new MemoryLedgerStore();
    const crossClient = await LedgerClient.openFromSnapshot({
      trust,
      snapshot,
      stream: samePage,
      store: cross,
    });
    await expect(crossClient.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    expect(cross.journal?.offset).toBe('opaque:2/+');
    expect(cross.journal?.snapshotBound).toBe(true);

    const missing = new MemoryLedgerStream();
    missing.records = [foreign.record];
    const missingStore = new MemoryLedgerStore();
    const missingClient = await LedgerClient.openFromSnapshot({
      trust,
      snapshot,
      stream: missing,
      store: missingStore,
    });
    const missingOffset = missingStore.journal?.offset;
    await expect(missingClient.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    expect(missingStore.journal?.offset).toBe(missingOffset);

    const emptyFinal = new MemoryLedgerStream();
    const emptyStore = new MemoryLedgerStore();
    const emptyClient = await LedgerClient.openFromSnapshot({
      trust,
      snapshot,
      stream: emptyFinal,
      store: emptyStore,
    });
    const emptyView = await emptyClient.read();
    expect(emptyView.length).toBe(first.ledger.length);
    expect(emptyView.origin).toBe('snapshot');
    expect(emptyStore.journal?.offset).toBe(emptyFinal.initialOffset);

    const prefix = new MemoryLedgerStream();
    prefix.records = [foreign.record, g.record, first.record, suffix.record];
    const prefixStore = new MemoryLedgerStore();
    const prefixClient = await LedgerClient.openFromSnapshot({
      trust,
      snapshot,
      stream: prefix,
      store: prefixStore,
    });
    const prefixView = await prefixClient.read();
    expect(prefixView.head).toEqual(suffix.ledger.head);
    expect(prefixView.length).toBe(suffix.ledger.length);
  });

  it('rejects a duplicate known record after the authenticated snapshot boundary', async () => {
    const owner = await ed25519();
    const g = await signGenesis(owner);
    const first = await append(
      g.ledger,
      owner,
      await admitDeviceOp(g.anchor, g.membershipId, await ed25519(), 'personal', true)
    );
    const { snapshot, trust } = await signSnapshot(first.ledger, owner);
    const suffix = await append(
      first.ledger,
      owner,
      await admitDeviceOp(g.anchor, g.membershipId, await ed25519(), 'personal', true)
    );

    const stream = new MemoryLedgerStream();
    stream.records = [g.record, first.record];
    const store = new MemoryLedgerStore();
    const client = await LedgerClient.openFromSnapshot({
      trust,
      snapshot,
      stream,
      store,
    });
    await client.read();
    const before = store.journal?.offset;
    stream.records.push(g.record);
    await expect(client.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    expect(store.journal?.offset).toBe(before);
    expect(store.journal?.records).toHaveLength(0);

    stream.records.push(suffix.record);
    await expect(client.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    expect(store.journal?.offset).toBe(before);
    expect(store.journal?.records).toHaveLength(0);
  });

  it('rejects missing snapshot boundary when junk is followed by an empty final page', async () => {
    const owner = await ed25519();
    const g = await signGenesis(owner);
    const first = await append(
      g.ledger,
      owner,
      await admitDeviceOp(g.anchor, g.membershipId, await ed25519(), 'personal', true)
    );
    const { snapshot, trust } = await signSnapshot(first.ledger, owner);
    const foreign = await signGenesis(await ed25519());
    const fork = await append(
      g.ledger,
      owner,
      await admitDeviceOp(g.anchor, g.membershipId, await ed25519(), 'personal', true)
    );

    const pagedJunk = (junk: Uint8Array): LedgerStream => ({
      initialOffset: 'empty:/+',
      async readAfter(offset: string) {
        if (offset === 'empty:/+') {
          return { records: [junk], nextOffset: 'after-junk', upToDate: false };
        }
        if (offset === 'after-junk') {
          return { records: [], nextOffset: 'after-junk', upToDate: true };
        }
        throw new Error(`unexpected-offset:${offset}`);
      },
      async appendCas() {
        return 'unsupported';
      },
    });

    for (const junk of [foreign.record, fork.record]) {
      const store = new MemoryLedgerStore();
      const client = await LedgerClient.openFromSnapshot({
        trust,
        snapshot,
        stream: pagedJunk(junk),
        store,
      });
      const before = store.journal?.offset;
      await expect(client.read()).rejects.toMatchObject({ code: 'wrong-parent' });
      expect(store.journal?.offset).toBe(before);
      expect(store.journal?.snapshotBound).toBeUndefined();
      expect(store.journal?.records).toHaveLength(0);
    }
  });
});
