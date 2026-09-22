import { describe, expect, it } from 'vitest';
import { Either } from 'effect';
import * as PureSnapshot from '../src/pure/ledger-snapshot';
import { Ledger, LedgerError } from '../src/ledger';
import { decodeSnapshotCbor, encodeSnapshotCbor, encodeCbor } from '../src/ledger/cbor';
import { encodeSignedRecord } from '../src/ledger/schema';
import { createNodeSignatureVerifyExecutor } from '../src/ledger/node-sig-pool';
import {
  commitEpochKey,
  headAttestationSigningBytes,
  snapshotSigningBytes,
} from '../src/ledger/crypto';
import { sealHistoryPacket } from '../src/ledger/keys';
import { encodeSignedSnapshot } from '../src/ledger/snapshot';
import {
  admitDeviceOp,
  append,
  ed25519,
  findMembership,
  random,
  signGenesis,
  signJoin,
  type DeviceKeys,
} from './ledger-fixtures';

async function signSnapshot(ledger: Awaited<ReturnType<typeof Ledger.verify>>, signer: DeviceKeys) {
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

it('pure snapshot parsing owns bytes but does not establish signature trust', async () => {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const { snapshot, trust } = await signSnapshot(created.ledger, owner);
  const saved = new Uint8Array(snapshot);
  const parsed = PureSnapshot.parseSignedSnapshot(snapshot);
  if (Either.isLeft(parsed)) throw new Error('signed fixture must parse');
  snapshot.fill(0);
  expect(PureSnapshot.encodeSignedSnapshot(parsed.right.bodyBytes, parsed.right.signature)).toEqual(
    Either.right(saved)
  );
  const state = PureSnapshot.snapshotStateFromParsed(parsed.right);
  expect(Either.isRight(state)).toBe(true);
  const forged = new Uint8Array(saved);
  forged[forged.length - 1] = forged[forged.length - 1]! ^ 1;
  // Structural validity must never be mistaken for cryptographic acceptance.
  expect(Either.isRight(PureSnapshot.decodeSignedSnapshot(forged))).toBe(true);
  await expect(Ledger.verifySnapshot({ snapshot: forged, trust })).rejects.toMatchObject({
    code: 'bad-signature',
  });
  for (const bytes of [
    new Uint8Array(),
    Uint8Array.of(0xff),
    saved.subarray(0, saved.length - 1),
  ]) {
    expect(PureSnapshot.parseSignedSnapshot(bytes)).toMatchObject({ _tag: 'Left' });
  }
});

async function mixedLedger() {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const applicant = await ed25519();
  const join = await signJoin(created.anchor, applicant);
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
  return {
    owner,
    applicant,
    applicantUserId: join.userId,
    created,
    ledger: rotated.ledger,
    records: [created.record, admitted.record, rotated.record],
  };
}

describe('signed snapshot bootstrap', () => {
  it.each(['machine', 'recovery'] as const)(
    'rejects a signed snapshot granting management to %s',
    async (kind) => {
      const owner = await ed25519();
      const created = await signGenesis(owner);
      const device = await ed25519();
      const added = await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, device, kind, false)
      );
      const signed = await signSnapshot(added.ledger, owner);
      const root = decodeSnapshotCbor(signed.snapshot) as unknown[];
      const body = root[0] as unknown[];
      const auth = body[5] as unknown[];
      const rows = auth[2] as unknown[][];
      const row = rows.find((candidate) =>
        Buffer.from(candidate[0] as Uint8Array).equals(Buffer.from(device.publicKey))
      )!;
      row[4] = true;
      const bytes = encodeSnapshotCbor(body as never);
      const snapshot = encodeSignedSnapshot(bytes, await owner.sign(snapshotSigningBytes(bytes)));
      await expect(Ledger.verifySnapshot({ trust: signed.trust, snapshot })).rejects.toMatchObject({
        code: 'canonical',
      });
    }
  );

  it('imports a valid guest snapshot retaining machines and inactive personal management flags after demotion', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const member = await ed25519();
    const id = random(16);
    let { ledger } = await append(created.ledger, owner, {
      type: 'admitMember',
      membershipId: id,
      request: await signJoin(created.anchor, member),
    });
    ({ ledger } = await append(ledger, owner, {
      type: 'setRole',
      membershipId: id,
      role: 'admin',
    }));
    const machine = await ed25519(),
      personal = await ed25519();
    ({ ledger } = await append(
      ledger,
      member,
      await admitDeviceOp(created.anchor, id, machine, 'machine', false)
    ));
    ({ ledger } = await append(
      ledger,
      member,
      await admitDeviceOp(created.anchor, id, personal, 'personal', true)
    ));
    ({ ledger } = await append(ledger, owner, {
      type: 'setRole',
      membershipId: id,
      role: 'guest',
    }));
    const signed = await signSnapshot(ledger, owner);
    const restored = await Ledger.verifySnapshot(signed);
    expect(restored.state).toEqual(ledger.state);
  });
  it('snapshot plus suffix matches full-history audit', async () => {
    const { owner, created, ledger, records } = await mixedLedger();
    const extra = await ed25519();
    const suffixOp = await append(
      ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, extra, 'personal', true)
    );
    const { snapshot, trust } = await signSnapshot(ledger, owner);
    const joined = await Ledger.verifySnapshot({
      trust,
      snapshot,
      suffix: [suffixOp.record],
    });
    const audited = await Ledger.verify({
      anchor: created.anchor,
      records: [...records, suffixOp.record],
    });
    expect(joined.origin).toBe('snapshot');
    expect(joined.length).toBe(audited.length);
    expect(joined.head).toEqual(audited.head);
    expect(joined.state.epoch.number).toBe(audited.state.epoch.number);
    expect(joined.state.members.size).toBe(audited.state.members.size);
    expect(joined.state.devices.size).toBe(audited.state.devices.size);
    expect(joined.hashAt(0)).toEqual(created.anchor);
    expect(() => joined.hashAt(1)).toThrowError(LedgerError);
    const peer = await ed25519();
    const cmp = Ledger.compareNotes(
      joined.comparisonNote(peer.publicKey),
      audited.comparisonNote(extra.publicKey),
      { originalEndorser: owner.publicKey, confirmedNoteSigners: [extra.publicKey] }
    );
    expect(cmp.kind).toBe('agree');
    if (cmp.kind === 'agree') expect(cmp.independent).toBe(true);
  });

  it('rejects wrong genesis, endorser, head, and signatures', async () => {
    const { owner, ledger } = await mixedLedger();
    const { snapshot, trust } = await signSnapshot(ledger, owner);
    const other = await ed25519();
    const fakeGenesis = random(32);
    const fakeGenesisSig = await owner.sign(headAttestationSigningBytes(fakeGenesis, trust.head));
    await expect(
      Ledger.verifySnapshot({
        trust: { ...trust, genesis: fakeGenesis, headSignature: fakeGenesisSig },
        snapshot,
      })
    ).rejects.toMatchObject({ code: 'wrong-anchor' });
    await expect(
      Ledger.verifySnapshot({
        trust: { ...trust, endorser: other.publicKey },
        snapshot,
      })
    ).rejects.toMatchObject({ code: 'bad-signature' });
    const wrongHead = random(32);
    const wrongHeadSig = await owner.sign(headAttestationSigningBytes(trust.genesis, wrongHead));
    await expect(
      Ledger.verifySnapshot({
        trust: { ...trust, head: wrongHead, headSignature: wrongHeadSig },
        snapshot,
      })
    ).rejects.toMatchObject({ code: 'wrong-anchor' });
    const badSnap = Uint8Array.from(snapshot);
    const snapLast = badSnap.at(-1);
    if (snapLast === undefined) throw new Error('empty-snapshot');
    badSnap[badSnap.byteLength - 1] = snapLast ^ 1;
    await expect(Ledger.verifySnapshot({ trust, snapshot: badSnap })).rejects.toMatchObject({
      code: 'bad-signature',
    });
  });

  it('rejects a correct head paired with uncovered mutated state', async () => {
    const { owner, ledger } = await mixedLedger();
    const { snapshot, trust } = await signSnapshot(ledger, owner);
    const root = decodeSnapshotCbor(snapshot) as unknown[];
    const body = root[0] as unknown[];
    const auth = [...(body[5] as unknown[])];
    auth[5] = !auth[5];
    const tamperedBody = [...body];
    tamperedBody[5] = auth;
    const bodyBytes = encodeSnapshotCbor(tamperedBody as never);
    const proposal = ledger.prepareSnapshot(owner.publicKey);
    const tampered = encodeSignedSnapshot(bodyBytes, await owner.sign(proposal.signingBytes));
    await expect(Ledger.verifySnapshot({ trust, snapshot: tampered })).rejects.toMatchObject({
      code: 'bad-signature',
    });
  });

  it('accepts a trusted endorser’s structurally valid false state as uncompared', async () => {
    const { owner, ledger } = await mixedLedger();
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
    const joined = await Ledger.verifySnapshot({ trust: honest.trust, snapshot: falseSnap });
    expect(joined.origin).toBe('snapshot');
    expect(joined.state.epoch.rotationRequired).not.toBe(ledger.state.epoch.rotationRequired);
    const local = joined.comparisonNote(owner.publicKey);
    const remote = ledger.comparisonNote(owner.publicKey);
    const cmp = Ledger.compareNotes(local, remote, { originalEndorser: owner.publicKey });
    expect(cmp.kind).toBe('conflict');
  });

  it('does not treat the original endorser re-note as independent comparison', async () => {
    const { owner, ledger } = await mixedLedger();
    const { snapshot, trust } = await signSnapshot(ledger, owner);
    const joined = await Ledger.verifySnapshot({ trust, snapshot });
    const local = joined.comparisonNote(owner.publicKey);
    const remote = ledger.comparisonNote(owner.publicKey);
    const cmp = Ledger.compareNotes(local, remote, { originalEndorser: owner.publicKey });
    expect(cmp.kind).toBe('agree');
    if (cmp.kind === 'agree') expect(cmp.independent).toBe(false);
  });

  it('does not treat a different public key as independent without out-of-band confirmation', async () => {
    const { owner, ledger } = await mixedLedger();
    const { snapshot, trust } = await signSnapshot(ledger, owner);
    const joined = await Ledger.verifySnapshot({ trust, snapshot });
    const stranger = await ed25519();
    const cmp = Ledger.compareNotes(
      joined.comparisonNote(stranger.publicKey),
      ledger.comparisonNote(stranger.publicKey),
      { originalEndorser: owner.publicKey }
    );
    expect(cmp.kind).toBe('agree');
    if (cmp.kind === 'agree') expect(cmp.independent).toBe(false);
  });

  it('does not treat the endorser’s second device as independent', async () => {
    const { owner, created, ledger } = await mixedLedger();
    const tablet = await ed25519();
    const admitted = await append(
      ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, tablet, 'personal', true)
    );
    const { snapshot, trust } = await signSnapshot(admitted.ledger, owner);
    const joined = await Ledger.verifySnapshot({ trust, snapshot });
    const cmp = Ledger.compareNotes(
      joined.comparisonNote(tablet.publicKey),
      admitted.ledger.comparisonNote(tablet.publicKey),
      { originalEndorser: owner.publicKey }
    );
    expect(cmp.kind).toBe('agree');
    if (cmp.kind === 'agree') expect(cmp.independent).toBe(false);
  });

  it('conflicts when a trusted endorser signs the true head with a fake length', async () => {
    const { owner, created, ledger } = await mixedLedger();
    const extra = await ed25519();
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
    const joined = await Ledger.verifySnapshot({ trust: honest.trust, snapshot: falseSnap });
    expect(joined.head).toEqual(ledger.head);
    expect(joined.length).toBe(ledger.length + 1);
    const local = joined.comparisonNote(extra.publicKey);
    const remote = ledger.comparisonNote(extra.publicKey);
    const cmp = Ledger.compareNotes(local, remote, {
      originalEndorser: owner.publicKey,
      confirmedNoteSigners: [extra.publicKey],
    });
    expect(cmp.kind).toBe('conflict');

    const suffix = await append(
      ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, extra, 'personal', true)
    );
    const afterLocal = await joined.extend([suffix.record]);
    const afterRemote = suffix.ledger;
    expect(afterLocal.head).toEqual(afterRemote.head);
    const after = Ledger.compareNotes(
      afterLocal.comparisonNote(extra.publicKey),
      afterRemote.comparisonNote(extra.publicKey),
      { originalEndorser: owner.publicKey, confirmedNoteSigners: [extra.publicKey] }
    );
    expect(after.kind).toBe('conflict');
  });

  it('rejects a claimed snapshot length that would allocate past the bound', async () => {
    const { owner, ledger } = await mixedLedger();
    const honest = await signSnapshot(ledger, owner);
    const root = decodeSnapshotCbor(honest.snapshot) as unknown[];
    const body = [...(root[0] as unknown[])];
    body[2] = Number.MAX_SAFE_INTEGER;
    const bodyBytes = encodeSnapshotCbor(body as never);
    const huge = encodeSignedSnapshot(bodyBytes, await owner.sign(snapshotSigningBytes(bodyBytes)));
    const started = Date.now();
    await expect(
      Ledger.verifySnapshot({ trust: honest.trust, snapshot: huge })
    ).rejects.toMatchObject({ code: 'oversize' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('treats different lengths as pending-sync, not a fork', async () => {
    const { owner, created, ledger } = await mixedLedger();
    const extra = await ed25519();
    const longer = await append(
      ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, extra, 'personal', true)
    );
    const { snapshot, trust } = await signSnapshot(ledger, owner);
    const joined = await Ledger.verifySnapshot({ trust, snapshot });
    const cmp = Ledger.compareNotes(
      joined.comparisonNote(extra.publicKey),
      longer.ledger.comparisonNote(extra.publicKey),
      { originalEndorser: owner.publicKey }
    );
    expect(cmp).toMatchObject({ kind: 'pending-sync' });
  });

  it('conflicts at the same claimed length with different heads', async () => {
    const { owner, created, ledger } = await mixedLedger();
    const left = await ed25519();
    const right = await ed25519();
    const a = await append(
      ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, left, 'personal', false)
    );
    const b = await append(
      ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, right, 'personal', false)
    );
    expect(a.ledger.length).toBe(b.ledger.length);
    expect(a.ledger.head).not.toEqual(b.ledger.head);
    const cmp = Ledger.compareNotes(
      a.ledger.comparisonNote(left.publicKey),
      b.ledger.comparisonNote(right.publicKey),
      { originalEndorser: owner.publicKey, confirmedNoteSigners: [right.publicKey] }
    );
    expect(cmp.kind).toBe('conflict');
  });

  it('rejects guest and member snapshot endorsement', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const member = await ed25519();
    const memberJoin = await signJoin(created.anchor, member);
    const admitted = await append(created.ledger, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request: memberJoin,
    });
    expect(() => admitted.ledger.prepareSnapshot(member.publicKey)).toThrowError(LedgerError);
    const guest = await ed25519();
    const guestJoin = await signJoin(created.anchor, guest);
    const guestAdmitted = await append(admitted.ledger, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request: guestJoin,
    });
    const guestId = findMembership(guestAdmitted.ledger, guestJoin.userId);
    const asGuest = await append(guestAdmitted.ledger, owner, {
      type: 'setRole',
      membershipId: guestId,
      role: 'guest',
    });
    expect(() => asGuest.ledger.prepareSnapshot(guest.publicKey)).toThrowError(LedgerError);
  });

  it('replays used membership ids after snapshot start', async () => {
    const { owner, created, ledger, applicantUserId } = await mixedLedger();
    const membershipId = findMembership(ledger, applicantUserId);
    const removed = await append(ledger, owner, { type: 'removeMember', membershipId });
    const { snapshot, trust } = await signSnapshot(removed.ledger, owner);
    const joined = await Ledger.verifySnapshot({ trust, snapshot });
    const proposal = joined.prepare(
      {
        type: 'admitMember',
        membershipId,
        request: await signJoin(created.anchor, await ed25519()),
      },
      owner.publicKey
    );
    await expect(
      joined.finalize(proposal, await owner.sign(proposal.signingBytes))
    ).rejects.toMatchObject({ code: 'replay' });
  });

  it('leaves the original view unchanged when a suffix fails', async () => {
    const { owner, created, ledger } = await mixedLedger();
    const { snapshot, trust } = await signSnapshot(ledger, owner);
    const joined = await Ledger.verifySnapshot({ trust, snapshot });
    const before = joined.head;
    const extra = await ed25519();
    const good = await append(
      ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, extra, 'personal', true)
    );
    const damaged = Uint8Array.from(good.record);
    const recLast = damaged.at(-1);
    if (recLast === undefined) throw new Error('empty-record');
    damaged[damaged.byteLength - 1] = recLast ^ 1;
    await expect(joined.extend([damaged])).rejects.toMatchObject({ code: 'bad-signature' });
    expect(joined.head).toEqual(before);
    expect(joined.length).toBe(ledger.length);
  });
});

describe('device possession binding characterization', () => {
  it('rejects a copied proof for another membership without consuming its keys', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const bob = await ed25519();
    const join = await signJoin(created.anchor, bob);
    const bobId = random(16);
    const admitted = await append(created.ledger, owner, {
      type: 'admitMember',
      membershipId: bobId,
      request: join,
    });
    const phone = await ed25519();
    const proof = await admitDeviceOp(
      created.anchor,
      created.membershipId,
      phone,
      'personal',
      false
    );
    await expect(append(admitted.ledger, bob, proof)).rejects.toMatchObject({ code: 'bad-proof' });
    const proposal = admitted.ledger.prepare(proof, bob.publicKey);
    const attackRecord = encodeSignedRecord(
      proposal.bodyBytes,
      await bob.sign(proposal.signingBytes)
    );
    const records = [created.record, admitted.record, attackRecord];
    await expect(Ledger.verify({ anchor: created.anchor, records })).rejects.toMatchObject({
      code: 'bad-proof',
      position: 2,
    });
    await expect(
      Ledger.verify({
        anchor: created.anchor,
        records,
        executor: createNodeSignatureVerifyExecutor(),
      })
    ).rejects.toMatchObject({ code: 'bad-proof', position: 2 });
    const accepted = await append(admitted.ledger, owner, proof);
    const bound = accepted.ledger.state.devices.get(Buffer.from(phone.publicKey).toString('hex'));
    expect(bound?.membershipId).toEqual(created.membershipId);
  });

  it('rejects v1 proofs instead of accepting an unbound fallback', async () => {
    const owner = await ed25519(),
      phone = await ed25519();
    const created = await signGenesis(owner);
    const op = await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', false);
    const domain = new TextEncoder().encode('lody-e2ee/possess/v1\0');
    const payload = encodeCbor([created.anchor, phone.publicKey, phone.enc, 0, false]);
    const bytes = new Uint8Array(domain.length + payload.length);
    bytes.set(domain);
    bytes.set(payload, domain.length);
    const old = { ...op, possessionSignature: await phone.sign(bytes) };
    await expect(append(created.ledger, owner, old)).rejects.toMatchObject({ code: 'bad-proof' });
  });

  it('lets an Owner personal device without canManage admit a managing device (current spec §8.3)', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const tablet = await ed25519();
    const withoutManage = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, tablet, 'personal', false)
    );
    const phone = await ed25519();
    const promoted = await append(
      withoutManage.ledger,
      tablet,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', true)
    );
    const row = promoted.ledger.state.devices.get(Buffer.from(phone.publicKey).toString('hex'));
    expect(row?.canManage).toBe(true);
  });
});
