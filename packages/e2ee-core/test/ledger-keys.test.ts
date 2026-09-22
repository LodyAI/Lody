import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import { describe, expect, it } from 'vitest';
import { LedgerError } from '../src/ledger';
import { encodeCbor } from '../src/ledger/cbor';
import { decodeRecord } from '../src/ledger/schema';
import {
  EPOCH_U32_MAX,
  canSendEpoch,
  collectEpochPackets,
  commitEpochKey,
  openEpochEnvelope,
  openHistoryPacket,
  recoverHistory,
  sealEpochEnvelope,
  sealHistoryPacket,
} from '../src/ledger';
import {
  HISTORY_PACKET_BYTES,
  admitDeviceOp,
  append,
  ed25519,
  findMembership,
  hex,
  random,
  signGenesis,
  signJoin,
  type DeviceKeys,
} from './ledger-fixtures';

async function device(): Promise<DeviceKeys & { dh: CryptoKeyPair }> {
  const keys = await ed25519();
  const dh = (await crypto.subtle.generateKey('X25519', false, ['deriveBits'])) as CryptoKeyPair;
  const enc = new Uint8Array(await crypto.subtle.exportKey('raw', dh.publicKey));
  return { ...keys, enc, dh };
}

function genesisCommitment(record: Uint8Array) {
  const decoded = decodeRecord(record);
  if (decoded.body.type !== 'genesis') throw new Error('not-genesis');
  return decoded.body.fields.epochCommitment;
}

describe('P3 key delivery and history unwrap', () => {
  it('rejects epoch numbers that would truncate in uint32 AAD', async () => {
    const genesis = random(32);
    const secret = random(32);
    const previous = random(32);
    await expect(commitEpochKey(genesis, EPOCH_U32_MAX + 1, secret)).rejects.toMatchObject({
      code: 'invalid-operation',
    });
    expect(() => sealHistoryPacket(secret, previous, genesis, EPOCH_U32_MAX + 1)).toThrowError(
      LedgerError
    );
    await expect(commitEpochKey(genesis, EPOCH_U32_MAX, secret)).resolves.toBeInstanceOf(
      Uint8Array
    );
    expect(sealHistoryPacket(secret, previous, genesis, EPOCH_U32_MAX).byteLength).toBe(
      HISTORY_PACKET_BYTES
    );
  });

  it('commits a garbage history packet and then cannot unwrap (accepted availability limit)', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const junk = random(HISTORY_PACKET_BYTES);
    const next = random(32);
    const published = await append(created.ledger, owner, {
      type: 'publishEpoch',
      epoch: 1,
      commitment: await commitEpochKey(created.anchor, 1, next),
      previousEpochKey: junk,
    });
    expect(published.ledger.state.epoch.number).toBe(1);
    await expect(
      recoverHistory({
        genesis: created.anchor,
        latestEpoch: 1,
        latestKey: next,
        packets: collectEpochPackets(
          [created.record, published.record],
          genesisCommitment(created.record)
        ),
      })
    ).rejects.toMatchObject({ code: 'invalid-operation' });
  });

  it('recovers every retained epoch from the latest key only', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    let ledger = created.ledger;
    const records = [created.record];
    const keys = [k0];
    for (let epoch = 1; epoch <= 3; epoch++) {
      const next = random(32);
      const packet = sealHistoryPacket(next, keys[epoch - 1]!, created.anchor, epoch);
      expect(packet.byteLength).toBe(HISTORY_PACKET_BYTES);
      const published = await append(ledger, owner, {
        type: 'publishEpoch',
        epoch,
        commitment: await commitEpochKey(created.anchor, epoch, next),
        previousEpochKey: packet,
      });
      records.push(published.record);
      ledger = published.ledger;
      keys.push(next);
    }
    const packets = collectEpochPackets(records, genesisCommitment(created.record));
    const recovered = await recoverHistory({
      genesis: created.anchor,
      latestEpoch: 3,
      latestKey: keys[3]!,
      packets,
    });
    expect(recovered.size).toBe(4);
    for (let epoch = 0; epoch <= 3; epoch++) expect(recovered.get(epoch)).toEqual(keys[epoch]);
    expect(keys[0]).not.toEqual(keys[3]);

    const bad = new Map(packets);
    const broken = new Uint8Array(packets.get(2)!.packet);
    broken[0] = (broken[0] ?? 0) ^ 0xff;
    bad.set(2, { ...packets.get(2)!, packet: broken });
    await expect(
      recoverHistory({
        genesis: created.anchor,
        latestEpoch: 3,
        latestKey: keys[3]!,
        packets: bad,
      })
    ).rejects.toBeInstanceOf(LedgerError);

    const other = await signGenesis(await device(), random(32));
    await expect(
      recoverHistory({
        genesis: other.anchor,
        latestEpoch: 3,
        latestKey: keys[3]!,
        packets,
      })
    ).rejects.toMatchObject({ code: 'invalid-operation' });
    try {
      openHistoryPacket(keys[3]!, packets.get(3)!.packet, other.anchor, 3);
      throw new Error('cross-org-history-opened');
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).code).toBe('invalid-operation');
    }
  });

  it('HPKE-wraps the current epoch to an admitted device and refuses a revoked recipient', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', true)
    );
    const frame = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    const opened = await openEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientKeyPair: phone.dh,
      frame,
    });
    expect(opened).toEqual(k0);

    const ikm = random(32);
    const entropy = {
      fill(label: string, bytes: Uint8Array) {
        if (label !== 'hpke-dhkem-ikm' || bytes.byteLength !== ikm.byteLength) {
          throw new Error(`entropy-mismatch:${label}`);
        }
        bytes.set(ikm);
        return bytes;
      },
    };
    const sealedA = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
      entropy,
    });
    const sealedB = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
      entropy,
    });
    expect(sealedA).toEqual(sealedB);
    const otherIkm = random(32);
    const sealedC = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
      entropy: {
        fill(label, bytes) {
          if (label !== 'hpke-dhkem-ikm') throw new Error(`entropy-mismatch:${label}`);
          bytes.set(otherIkm);
          return bytes;
        },
      },
    });
    expect(sealedC).not.toEqual(sealedA);
    expect(
      await openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: sealedA,
      })
    ).toEqual(k0);

    const revoked = await append(admitted.ledger, owner, {
      type: 'revokeDevice',
      target: phone.publicKey,
    });
    await expect(
      sealEpochEnvelope({
        state: revoked.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientEncryptionKey: phone.enc,
        epochKey: k0,
        sign: (bytes) => owner.sign(bytes),
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });

    const rotated = await append(admitted.ledger, owner, {
      type: 'publishEpoch',
      epoch: 1,
      commitment: await commitEpochKey(created.anchor, 1, random(32)),
      previousEpochKey: random(HISTORY_PACKET_BYTES),
    });
    await expect(
      openEpochEnvelope({
        state: rotated.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame,
      })
    ).rejects.toMatchObject({ code: 'invalid-operation' });
  });

  it('rejects a stranger-signed epoch envelope whose plaintext does not match the ledger commitment', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', false)
    );
    const attacker = await device();
    const fakeKey = random(32);
    const suite = new CipherSuite({
      kem: new DhkemX25519HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Chacha20Poly1305(),
    });
    const aad = encodeCbor([created.anchor, 0, attacker.publicKey, phone.publicKey]);
    const sealed = await suite.seal(
      {
        recipientPublicKey: await suite.kem.deserializePublicKey(phone.enc),
        info: new TextEncoder().encode('lody-e2ee/hpke-epoch/v1\0'),
      },
      fakeKey,
      aad
    );
    const unsigned = new Uint8Array(aad.byteLength + 32 + 48);
    unsigned.set(aad);
    unsigned.set(new Uint8Array(sealed.enc), aad.byteLength);
    unsigned.set(new Uint8Array(sealed.ct), aad.byteLength + 32);
    const domain = new TextEncoder().encode('lody-e2ee/epoch-env/v1\0');
    const message = new Uint8Array(domain.byteLength + unsigned.byteLength);
    message.set(domain);
    message.set(unsigned, domain.byteLength);
    const frame = new Uint8Array(unsigned.byteLength + 64);
    frame.set(unsigned);
    frame.set(await attacker.sign(message), unsigned.byteLength);
    await expect(
      openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: attacker.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame,
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await commitEpochKey(created.anchor, 0, fakeKey)).not.toEqual(
      created.ledger.state.epoch.keyCommitment
    );
  });

  it('lets an Owner recovery device receive keys but not publish an epoch', async () => {
    const owner = await device();
    const created = await signGenesis(owner, random(32));
    const recovery = await device();
    const withR = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, recovery, 'recovery', false)
    );
    const k0 = created.secret;
    const frame = await sealEpochEnvelope({
      state: withR.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: recovery.publicKey,
      recipientEncryptionKey: recovery.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    const opened = await openEpochEnvelope({
      state: withR.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: recovery.publicKey,
      recipientKeyPair: recovery.dh,
      frame,
    });
    expect(opened).toEqual(k0);
    await expect(
      append(withR.ledger, recovery, {
        type: 'publishEpoch',
        epoch: 1,
        commitment: await commitEpochKey(created.anchor, 1, random(32)),
        previousEpochKey: random(HISTORY_PACKET_BYTES),
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('refuses swapped, truncated, tampered, unadmitted, and post-revoke envelopes', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const laptop = await device();
    await expect(
      sealEpochEnvelope({
        state: created.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientEncryptionKey: phone.enc,
        epochKey: k0,
        sign: (bytes) => owner.sign(bytes),
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });

    const admittedPhone = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', false)
    );
    const admitted = await append(
      admittedPhone.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, laptop, 'personal', false)
    );
    await expect(
      sealEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientEncryptionKey: laptop.enc,
        epochKey: k0,
        sign: (bytes) => owner.sign(bytes),
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });

    const frame = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    await expect(
      openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: laptop.publicKey,
        recipientKeyPair: laptop.dh,
        frame,
      })
    ).rejects.toMatchObject({ code: 'canonical' });
    // phone is an eligible sender, but the frame's AAD and signature name owner.
    await expect(
      openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: phone.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame,
      })
    ).rejects.toMatchObject({ code: 'canonical' });
    await expect(
      openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: frame.subarray(0, frame.byteLength - 1),
      })
    ).rejects.toMatchObject({ code: 'canonical' });

    const tampered = new Uint8Array(frame);
    const flipAt = tampered.byteLength - 65;
    tampered[flipAt] = (tampered[flipAt] ?? 0) ^ 0xff;
    await expect(
      openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: tampered,
      })
    ).rejects.toBeInstanceOf(LedgerError);

    const other = await signGenesis(await device(), random(32));
    await expect(
      openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: other.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame,
      })
    ).rejects.toMatchObject({ code: 'canonical' });
    await expect(
      openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: random(HISTORY_PACKET_BYTES),
      })
    ).rejects.toMatchObject({ code: 'canonical' });

    const honest = await openEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientKeyPair: phone.dh,
      frame,
    });
    expect(honest).toEqual(k0);

    const revoked = await append(admitted.ledger, owner, {
      type: 'revokeDevice',
      target: phone.publicKey,
    });
    await expect(
      openEpochEnvelope({
        state: revoked.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame,
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('lets any active non-recovery device forward the current key; recovery and revoked senders cannot', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const member = await device();
    const request = await signJoin(created.anchor, member);
    const joined = await append(created.ledger, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request,
    });
    const memberMembership = findMembership(joined.ledger, request.userId);
    const laptop = await device();
    const withLaptop = await append(
      joined.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, laptop, 'personal', false)
    );
    const machine = await device();
    const withMachine = await append(
      withLaptop.ledger,
      member,
      await admitDeviceOp(created.anchor, memberMembership, machine, 'machine', false)
    );
    const recovery = await device();
    const admitted = await append(
      withMachine.ledger,
      member,
      await admitDeviceOp(created.anchor, memberMembership, recovery, 'recovery', false)
    );
    const state = admitted.ledger.state;
    expect(canSendEpoch(state, owner.publicKey)).toBe(true);
    expect(canSendEpoch(state, member.publicKey)).toBe(true);
    expect(canSendEpoch(state, machine.publicKey)).toBe(true);
    expect(canSendEpoch(state, recovery.publicKey)).toBe(false);
    expect(canSendEpoch(state, (await device()).publicKey)).toBe(false);

    // A plain member forwards the real key to another member's device.
    const fromMember = await sealEpochEnvelope({
      state,
      genesis: created.anchor,
      epoch: 0,
      sender: member.publicKey,
      recipient: laptop.publicKey,
      recipientEncryptionKey: laptop.enc,
      epochKey: k0,
      sign: (bytes) => member.sign(bytes),
    });
    expect(
      await openEpochEnvelope({
        state,
        genesis: created.anchor,
        epoch: 0,
        sender: member.publicKey,
        recipient: laptop.publicKey,
        recipientKeyPair: laptop.dh,
        frame: fromMember,
      })
    ).toEqual(k0);

    // A machine may forward to its owner's recovery device.
    const fromMachine = await sealEpochEnvelope({
      state,
      genesis: created.anchor,
      epoch: 0,
      sender: machine.publicKey,
      recipient: recovery.publicKey,
      recipientEncryptionKey: recovery.enc,
      epochKey: k0,
      sign: (bytes) => machine.sign(bytes),
    });
    expect(
      await openEpochEnvelope({
        state,
        genesis: created.anchor,
        epoch: 0,
        sender: machine.publicKey,
        recipient: recovery.publicKey,
        recipientKeyPair: recovery.dh,
        frame: fromMachine,
      })
    ).toEqual(k0);

    // A forwarded key that is not the committed key still fails the commitment check.
    await expect(
      openEpochEnvelope({
        state,
        genesis: created.anchor,
        epoch: 0,
        sender: member.publicKey,
        recipient: laptop.publicKey,
        recipientKeyPair: laptop.dh,
        frame: await sealEpochEnvelope({
          state,
          genesis: created.anchor,
          epoch: 0,
          sender: member.publicKey,
          recipient: laptop.publicKey,
          recipientEncryptionKey: laptop.enc,
          epochKey: random(32),
          sign: (bytes) => member.sign(bytes),
        }),
      })
    ).rejects.toMatchObject({ code: 'invalid-operation' });

    // Recovery devices only receive keys, even if the sender forges a personal entry.
    await expect(
      sealEpochEnvelope({
        state,
        genesis: created.anchor,
        epoch: 0,
        sender: recovery.publicKey,
        recipient: laptop.publicKey,
        recipientEncryptionKey: laptop.enc,
        epochKey: k0,
        sign: (bytes) => recovery.sign(bytes),
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
    const recoveryRow = state.devices.get(hex(recovery.publicKey));
    if (!recoveryRow) throw new Error('missing-recovery-device');
    const fakeDevices = new Map(state.devices);
    fakeDevices.set(hex(recovery.publicKey), { ...recoveryRow, kind: 'personal' });
    const forged = await sealEpochEnvelope({
      state: { ...state, devices: fakeDevices },
      genesis: created.anchor,
      epoch: 0,
      sender: recovery.publicKey,
      recipient: laptop.publicKey,
      recipientEncryptionKey: laptop.enc,
      epochKey: k0,
      sign: (bytes) => recovery.sign(bytes),
    });
    await expect(
      openEpochEnvelope({
        state,
        genesis: created.anchor,
        epoch: 0,
        sender: recovery.publicKey,
        recipient: laptop.publicKey,
        recipientKeyPair: laptop.dh,
        frame: forged,
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });

    // A sender revoked before the recipient opens is rejected against the current ledger.
    const revoked = await append(admitted.ledger, member, {
      type: 'revokeDevice',
      target: machine.publicKey,
    });
    expect(canSendEpoch(revoked.ledger.state, machine.publicKey)).toBe(false);
    await expect(
      openEpochEnvelope({
        state: revoked.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: machine.publicKey,
        recipient: recovery.publicKey,
        recipientKeyPair: recovery.dh,
        frame: fromMachine,
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
