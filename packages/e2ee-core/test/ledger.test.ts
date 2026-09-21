import { encode } from '@ipld/dag-cbor';
import { beforeAll, describe, expect, it } from 'vitest';
import { Ledger, LedgerError } from '../src/ledger';
import { decodeCbor, encodeCbor, MAX_RECORD_BYTES } from '../src/ledger/cbor';
import {
  HISTORY_PACKET_BYTES,
  commitEpochKey,
  hashRecord,
  type SigningPublicKey,
} from '../src/ledger/crypto';
import {
  encodeGenesisBody,
  encodeSignedRecord,
  joinRequestSigningBytes,
  possessionSigningBytes,
  signingBytesForBody,
  type JoinRequest,
  type Operation,
} from '../src/ledger/schema';

type DeviceKeys = {
  publicKey: SigningPublicKey;
  enc: Uint8Array;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
};

const random = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));

async function ed25519(): Promise<DeviceKeys> {
  const pair = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const x = (await crypto.subtle.generateKey('X25519', false, ['deriveBits'])) as CryptoKeyPair;
  const enc = new Uint8Array(await crypto.subtle.exportKey('raw', x.publicKey));
  return {
    publicKey,
    enc,
    async sign(bytes: Uint8Array) {
      const message = new Uint8Array(bytes.byteLength);
      message.set(bytes);
      return new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, message));
    },
  };
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(LedgerError);
  expect((error as LedgerError).code).toBe(code);
}

async function signGenesis(owner: DeviceKeys, secret: Uint8Array) {
  const userId = random(32);
  const membershipId = random(16);
  const commitment = await commitEpochKey(new Uint8Array(32), 0, secret);
  const bodyBytes = encodeGenesisBody({
    signer: owner.publicKey,
    userId,
    membershipId,
    encryptionPublicKey: owner.enc,
    epochCommitment: commitment,
  });
  const signature = await owner.sign(signingBytesForBody(bodyBytes));
  const record = encodeSignedRecord(bodyBytes, signature);
  const anchor = await hashRecord(record);
  const ledger = await Ledger.verify({ anchor, records: [record] });
  return { ledger, record, anchor, userId, membershipId, secret, commitment };
}

async function signJoin(genesis: Uint8Array, applicant: DeviceKeys): Promise<JoinRequest> {
  const request = {
    requestId: random(16),
    userId: random(32),
    signingPublicKey: applicant.publicKey,
    encryptionPublicKey: applicant.enc,
    expiresAt: null as number | null,
  };
  return {
    ...request,
    signature: await applicant.sign(joinRequestSigningBytes(genesis, request)),
  };
}

async function admitDeviceOp(
  genesis: Uint8Array,
  targetMembershipId: Uint8Array,
  device: DeviceKeys,
  kind: 'personal' | 'machine' | 'recovery',
  canManage: boolean
): Promise<Extract<Operation, { type: 'admitDevice' }>> {
  const possessionSignature = await device.sign(
    possessionSigningBytes({
      genesis,
      targetMembershipId,
      signingPublicKey: device.publicKey,
      encryptionPublicKey: device.enc,
      kind,
      canManage,
    })
  );
  return {
    type: 'admitDevice',
    kind,
    signingPublicKey: device.publicKey,
    encryptionPublicKey: device.enc,
    canManage,
    possessionSignature,
  };
}

async function append(
  ledger: Awaited<ReturnType<typeof Ledger.verify>>,
  signer: DeviceKeys,
  operation: Operation
) {
  const proposal = ledger.prepare(operation, signer.publicKey);
  const record = await ledger.finalize(proposal, await signer.sign(proposal.signingBytes));
  return { ledger: await ledger.extend([record]), record };
}

let owner: DeviceKeys;
let member: DeviceKeys;
let guestDevice: DeviceKeys;
let phone: DeviceKeys;
let recovery: DeviceKeys;
let machine: DeviceKeys;

beforeAll(async () => {
  owner = await ed25519();
  member = await ed25519();
  guestDevice = await ed25519();
  phone = await ed25519();
  recovery = await ed25519();
  machine = await ed25519();
});

describe('ledger CBOR subset', () => {
  it('round-trips canonical arrays and byte strings', () => {
    const value = [1, new Uint8Array([1, 2, 3]), true, null];
    const bytes = encodeCbor(value);
    expect(decodeCbor(bytes)).toEqual(value);
    expect(bytes).toEqual(encode(value));
  });

  it('rejects non-canonical integers, floats, trailing bytes and oversize input', () => {
    const nonCanonicalOne = new Uint8Array([0x18, 0x01]);
    try {
      decodeCbor(nonCanonicalOne);
      throw new Error('expected-canonical');
    } catch (error) {
      expectCode(error, 'canonical');
    }
    try {
      decodeCbor(new Uint8Array([0xfa, 0x3f, 0x80, 0x00, 0x00]));
      throw new Error('expected-canonical');
    } catch (error) {
      expectCode(error, 'canonical');
    }
    const encoded = encodeCbor([1]);
    const trailing = new Uint8Array(encoded.byteLength + 1);
    trailing.set(encoded);
    try {
      decodeCbor(trailing);
      throw new Error('expected-trailing');
    } catch (error) {
      expectCode(error, 'trailing');
    }
    try {
      decodeCbor(new Uint8Array(MAX_RECORD_BYTES + 1));
      throw new Error('expected-oversize');
    } catch (error) {
      expectCode(error, 'oversize');
    }
    try {
      decodeCbor(new Uint8Array([0x82]));
      throw new Error('expected-truncated');
    } catch (error) {
      expectCode(error, 'truncated');
    }
  });
});

describe('ledger verify and permissions', () => {
  it('creates, verifies, extends and rejects mutation of a verified view', async () => {
    const secret = random(32);
    const created = await signGenesis(owner, secret);
    expect(created.ledger.length).toBe(1);
    expect(created.ledger.state.epoch.number).toBe(0);
    expect([...created.ledger.state.members.values()][0]?.role).toBe('owner');

    const mutated = new Uint8Array(created.record);
    const again = await Ledger.verify({ anchor: created.anchor, records: [mutated] });
    mutated.fill(0);
    expect(again.length).toBe(1);
    expect(again.state.devices.size).toBe(1);

    const phoneOp = await admitDeviceOp(
      created.anchor,
      created.membershipId,
      phone,
      'personal',
      true
    );
    const { ledger: withPhone, record: phoneRecord } = await append(created.ledger, owner, phoneOp);
    expect(withPhone.length).toBe(2);
    expect(created.ledger.length).toBe(1);
    expect(created.ledger.state.devices.size).toBe(1);

    const fromZero = await Ledger.verify({
      anchor: created.anchor,
      records: [created.record, phoneRecord],
    });
    expect(fromZero.head).toEqual(withPhone.head);
    expect(fromZero.state.devices.size).toBe(withPhone.state.devices.size);
    expect(withPhone.hashAt(0)).toEqual(created.anchor);
  });

  it('admits members as Member, lets Owner set Guest, and keeps Guest read-only', async () => {
    const created = await signGenesis(owner, random(32));
    const request = await signJoin(created.anchor, guestDevice);
    const admitted = await append(created.ledger, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request,
    });
    const memberId = [...admitted.ledger.state.members.entries()].find(
      ([, value]) => value.role === 'member'
    )![0];
    const membershipId = Uint8Array.from(
      memberId.match(/../g)!.map((byte) => Number.parseInt(byte, 16))
    );
    const guested = await append(admitted.ledger, owner, {
      type: 'setRole',
      membershipId,
      role: 'guest',
    });
    expect([...guested.ledger.state.members.values()].some((value) => value.role === 'guest')).toBe(
      true
    );

    const epochKey = random(32);
    const commitment = await commitEpochKey(created.anchor, 1, epochKey);
    try {
      await append(guested.ledger, guestDevice, {
        type: 'publishEpoch',
        epoch: 1,
        commitment,
        previousEpochKey: random(HISTORY_PACKET_BYTES),
      });
      throw new Error('guest-published');
    } catch (error) {
      expectCode(error, 'unauthorized');
    }

    try {
      await append(
        guested.ledger,
        guestDevice,
        await admitDeviceOp(created.anchor, membershipId, machine, 'machine', false)
      );
      throw new Error('guest-machine');
    } catch (error) {
      expectCode(error, 'unauthorized');
    }
  });

  it('revokes only the named device and keeps devices admitted by it', async () => {
    const created = await signGenesis(owner, random(32));
    const laptop = await ed25519();
    const withLaptop = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, laptop, 'personal', true)
    );
    const withPhone = await append(
      withLaptop.ledger,
      laptop,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', false)
    );
    const revoked = await append(withPhone.ledger, owner, {
      type: 'revokeDevice',
      target: laptop.publicKey,
    });
    expect(revoked.ledger.state.devices.has(hex(laptop.publicKey))).toBe(false);
    expect(revoked.ledger.state.devices.has(hex(phone.publicKey))).toBe(true);
    expect(revoked.ledger.state.devices.has(hex(owner.publicKey))).toBe(true);
    const tablet = await ed25519();
    const still = await append(
      revoked.ledger,
      phone,
      await admitDeviceOp(created.anchor, created.membershipId, tablet, 'personal', false)
    );
    expect(still.ledger.state.devices.has(hex(tablet.publicKey))).toBe(true);
    try {
      await append(
        still.ledger,
        laptop,
        await admitDeviceOp(
          created.anchor,
          created.membershipId,
          await ed25519(),
          'personal',
          false
        )
      );
      throw new Error('revoked-approver-still-signed');
    } catch (error) {
      expectCode(error, 'unauthorized');
    }
  });

  it('lets Owner/Admin recovery devices grant canManage and rejects Member/Guest grants', async () => {
    const created = await signGenesis(owner, random(32));
    const withR = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, recovery, 'recovery', false)
    );
    const restored = await ed25519();
    const recovered = await append(
      withR.ledger,
      recovery,
      await admitDeviceOp(created.anchor, created.membershipId, restored, 'personal', true)
    );
    expect(recovered.ledger.state.devices.get(hex(restored.publicKey))?.canManage).toBe(true);

    const memberJoin = await signJoin(created.anchor, member);
    const withMember = await append(recovered.ledger, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request: memberJoin,
    });
    const memberR = await ed25519();
    const memberWithR = await append(
      withMember.ledger,
      member,
      await admitDeviceOp(
        created.anchor,
        withMember.ledger.state.devices.get(hex(member.publicKey))!.membershipId,
        memberR,
        'recovery',
        false
      )
    );
    const memberPhone = await ed25519();
    try {
      await append(
        memberWithR.ledger,
        memberR,
        await admitDeviceOp(
          created.anchor,
          withMember.ledger.state.devices.get(hex(member.publicKey))!.membershipId,
          memberPhone,
          'personal',
          true
        )
      );
      throw new Error('member-r-manage');
    } catch (error) {
      expectCode(error, 'unauthorized');
    }
  });

  it('publishes a history packet as opaque bytes and applies unilateral owner transfer', async () => {
    const created = await signGenesis(owner, random(32));
    const packet = random(HISTORY_PACKET_BYTES);
    const nextKey = random(32);
    const commitment = await commitEpochKey(created.anchor, 1, nextKey);
    const published = await append(created.ledger, owner, {
      type: 'publishEpoch',
      epoch: 1,
      commitment,
      previousEpochKey: packet,
    });
    expect(published.ledger.state.epoch.number).toBe(1);
    expect(published.ledger.state.epoch.rotationRequired).toBe(false);

    const applicant = await ed25519();
    const joined = await append(published.ledger, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request: await signJoin(created.anchor, applicant),
    });
    const successorId = [...joined.ledger.state.members.entries()].find(
      ([id]) => id !== hex(created.membershipId)
    )![0]!;
    const transferred = await append(joined.ledger, owner, {
      type: 'transferOwner',
      successorMembershipId: fromHex(successorId),
    });
    expect(hex(transferred.ledger.state.owner)).toBe(successorId);
    expect(transferred.ledger.state.members.get(successorId)?.role).toBe('owner');
    expect(transferred.ledger.state.members.get(hex(created.membershipId))?.role).toBe('admin');
    await expect(
      append(transferred.ledger, owner, {
        type: 'removeMember',
        membershipId: fromHex(successorId),
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      append(joined.ledger, owner, {
        type: 'transferOwner',
        successorMembershipId: created.membershipId,
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      append(joined.ledger, owner, {
        type: 'transferOwner',
        successorMembershipId: random(16),
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      append(joined.ledger, applicant, {
        type: 'transferOwner',
        successorMembershipId: created.membershipId,
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('rejects a genesis that does not match the trusted anchor', async () => {
    const created = await signGenesis(owner, random(32));
    try {
      await Ledger.verify({ anchor: random(32), records: [created.record] });
      throw new Error('wrong-anchor-accepted');
    } catch (error) {
      expectCode(error, 'wrong-anchor');
    }
  });

  it('rejects unknown genesis version, flipped signatures, and a failed extend leaves the original view', async () => {
    const created = await signGenesis(owner, random(32));
    const versionBody = encodeCbor([
      2,
      owner.publicKey,
      random(32),
      random(16),
      owner.enc,
      random(32),
    ]);
    const versioned = encodeSignedRecord(
      versionBody,
      await owner.sign(signingBytesForBody(versionBody))
    );
    try {
      await Ledger.verify({ anchor: await hashRecord(versioned), records: [versioned] });
      throw new Error('unknown-version-accepted');
    } catch (error) {
      expectCode(error, 'unknown-version');
    }

    const flipped = new Uint8Array(created.record);
    const last = flipped.byteLength - 1;
    flipped[last] = (flipped[last] ?? 0) ^ 0xff;
    try {
      await Ledger.verify({ anchor: created.anchor, records: [flipped] });
      throw new Error('bad-signature-accepted');
    } catch (error) {
      expectCode(error, 'bad-signature');
    }

    const before = created.ledger.length;
    try {
      await created.ledger.extend([flipped]);
      throw new Error('extend-accepted-bad-sig');
    } catch (error) {
      expectCode(error, 'bad-signature');
    }
    expect(created.ledger.length).toBe(before);
    expect(created.ledger.state.devices.size).toBe(1);

    const published = await append(created.ledger, owner, {
      type: 'publishEpoch',
      epoch: 1,
      commitment: await commitEpochKey(created.anchor, 1, random(32)),
      previousEpochKey: random(HISTORY_PACKET_BYTES),
    });
    const later = new Uint8Array(published.record);
    later[later.byteLength - 1] = (later[later.byteLength - 1] ?? 0) ^ 0xff;
    try {
      await Ledger.verify({
        anchor: created.anchor,
        records: [created.record, later],
      });
      throw new Error('later-signature-accepted');
    } catch (error) {
      expectCode(error, 'bad-signature');
      expect((error as LedgerError).position).toBe(1);
    }
  });

  it('explicit Node-parallel verify still rejects a forged nested possession proof', async () => {
    const created = await signGenesis(owner, random(32));
    const records = [created.record];
    let ledger = created.ledger;
    for (let i = 0; i < 31; i++) {
      const device = await ed25519();
      const next = await append(
        ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, device, 'personal', false)
      );
      records.push(next.record);
      ledger = next.ledger;
    }
    const attacker = await ed25519();
    const forgedOp = await admitDeviceOp(
      created.anchor,
      created.membershipId,
      attacker,
      'personal',
      false
    );
    forgedOp.possessionSignature[0] = (forgedOp.possessionSignature[0] ?? 0) ^ 0xff;
    const proposal = ledger.prepare(forgedOp, owner.publicKey);
    const forgedRecord = encodeSignedRecord(
      proposal.bodyBytes,
      await owner.sign(proposal.signingBytes)
    );
    const chain = [...records, forgedRecord];
    const { createNodeSignatureVerifyExecutor } = await import('../src/ledger/node-sig-pool');
    try {
      await Ledger.verify({
        anchor: created.anchor,
        records: chain,
        executor: createNodeSignatureVerifyExecutor(),
      });
      throw new Error('forged-proof-accepted-workers');
    } catch (error) {
      expectCode(error, 'bad-proof');
    }
    try {
      await Ledger.verify({ anchor: created.anchor, records: chain });
      throw new Error('forged-proof-accepted-sequential');
    } catch (error) {
      expectCode(error, 'bad-proof');
    }
  });
});

describe('incremental extend', () => {
  it('matches from-zero replay at every prefix of a mixed chain', async () => {
    const created = await signGenesis(owner, random(32));
    const records = [created.record];
    let ledger = created.ledger;
    const join = await signJoin(created.anchor, member);
    const admitted = await append(ledger, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request: join,
    });
    records.push(admitted.record);
    ledger = admitted.ledger;
    const phoneOp = await admitDeviceOp(
      created.anchor,
      created.membershipId,
      phone,
      'personal',
      true
    );
    const withPhone = await append(ledger, owner, phoneOp);
    records.push(withPhone.record);
    ledger = withPhone.ledger;
    const rotated = await append(ledger, owner, {
      type: 'publishEpoch',
      epoch: 1,
      commitment: await commitEpochKey(created.anchor, 1, random(32)),
      previousEpochKey: random(HISTORY_PACKET_BYTES),
    });
    records.push(rotated.record);
    ledger = rotated.ledger;

    for (let split = 1; split < records.length; split++) {
      const prefix = await Ledger.verify({
        anchor: created.anchor,
        records: records.slice(0, split),
      });
      const extended = await prefix.extend(records.slice(split));
      const full = await Ledger.verify({ anchor: created.anchor, records });
      expect(extended.head).toEqual(full.head);
      expect(extended.length).toBe(full.length);
      expect(extended.state.epoch.number).toBe(full.state.epoch.number);
      expect(extended.state.devices.size).toBe(full.state.devices.size);
    }
    expect(ledger.head).toEqual((await Ledger.verify({ anchor: created.anchor, records })).head);
  });
});

describe('readable host loop', () => {
  it('covers create → verify → extend → prepare/finalize → key packet → recovery device', async () => {
    const ownerKeys = owner;
    const epoch0 = random(32);
    const created = await signGenesis(ownerKeys, epoch0);
    const ledger0 = created.ledger;

    const applicant = await ed25519();
    const join = await signJoin(created.anchor, applicant);
    const afterJoin = await append(ledger0, ownerKeys, {
      type: 'admitMember',
      membershipId: random(16),
      request: join,
    });

    const r = await ed25519();
    const afterR = await append(
      afterJoin.ledger,
      ownerKeys,
      await admitDeviceOp(created.anchor, created.membershipId, r, 'recovery', false)
    );

    const epoch1 = random(32);
    const packet = random(HISTORY_PACKET_BYTES);
    const proposal = afterR.ledger.prepare(
      {
        type: 'publishEpoch',
        epoch: 1,
        commitment: await commitEpochKey(created.anchor, 1, epoch1),
        previousEpochKey: packet,
      },
      ownerKeys.publicKey
    );
    const epochRecord = await afterR.ledger.finalize(
      proposal,
      await ownerKeys.sign(proposal.signingBytes)
    );
    const ledger1 = await afterR.ledger.extend([epochRecord]);
    expect(ledger1.state.epoch.number).toBe(1);

    const newLaptop = await ed25519();
    const restored = await append(
      ledger1,
      r,
      await admitDeviceOp(created.anchor, created.membershipId, newLaptop, 'personal', true)
    );
    expect(restored.ledger.state.devices.get(hex(newLaptop.publicKey))?.kind).toBe('personal');
    expect(restored.ledger.state.devices.get(hex(newLaptop.publicKey))?.canManage).toBe(true);
  });
});

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
}
