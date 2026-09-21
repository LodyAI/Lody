import { Ledger } from '../src/ledger';
import { HISTORY_PACKET_BYTES, commitEpochKey, hashRecord } from '../src/ledger/crypto';
import {
  encodeGenesisBody,
  encodeSignedRecord,
  joinRequestSigningBytes,
  possessionSigningBytes,
  signingBytesForBody,
  type JoinRequest,
  type Operation,
} from '../src/ledger/schema';

export type DeviceKeys = {
  publicKey: Uint8Array;
  enc: Uint8Array;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
};

export const random = (length: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(length));

export async function ed25519(): Promise<DeviceKeys> {
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

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
}

export async function signGenesis(owner: DeviceKeys, secret: Uint8Array = random(32)) {
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

export async function signJoin(genesis: Uint8Array, applicant: DeviceKeys): Promise<JoinRequest> {
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

export async function admitDeviceOp(
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

export async function append(
  ledger: Awaited<ReturnType<typeof Ledger.verify>>,
  signer: DeviceKeys,
  operation: Operation
) {
  const proposal = ledger.prepare(operation, signer.publicKey);
  const record = await ledger.finalize(proposal, await signer.sign(proposal.signingBytes));
  return { ledger: await ledger.extend([record]), record };
}

export function findMembership(
  ledger: Awaited<ReturnType<typeof Ledger.verify>>,
  userId: Uint8Array
): Uint8Array {
  const want = hex(userId);
  for (const [id, member] of ledger.state.members) {
    if (hex(member.userId) === want) return fromHex(id);
  }
  throw new Error('membership-not-found');
}

export { HISTORY_PACKET_BYTES, commitEpochKey };

/** Confirmed operations only: no Owner transfer, no setRole guest. */
export async function buildMixedChain(count: number) {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const records = [created.record];
  let ledger = created.ledger;
  const members: DeviceKeys[] = [];
  for (let i = 0; i < count; i++) {
    const step = i % 6;
    if (step === 0) {
      const applicant = await ed25519();
      members.push(applicant);
      const next = await append(ledger, owner, {
        type: 'admitMember',
        membershipId: random(16),
        request: await signJoin(created.anchor, applicant),
      });
      records.push(next.record);
      ledger = next.ledger;
    } else if (step === 1 && members.length > 0) {
      const device = await ed25519();
      const next = await append(
        ledger,
        members[members.length - 1]!,
        await admitDeviceOp(
          created.anchor,
          ledger.state.devices.get(hex(members[members.length - 1]!.publicKey))!.membershipId,
          device,
          'personal',
          false
        )
      );
      records.push(next.record);
      ledger = next.ledger;
    } else if (step === 2) {
      const machine = await ed25519();
      const next = await append(
        ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, machine, 'machine', false)
      );
      records.push(next.record);
      ledger = next.ledger;
    } else if (step === 3) {
      const next = await append(ledger, owner, {
        type: 'publishEpoch',
        epoch: ledger.state.epoch.number + 1,
        commitment: await commitEpochKey(created.anchor, ledger.state.epoch.number + 1, random(32)),
        previousEpochKey: random(HISTORY_PACKET_BYTES),
      });
      records.push(next.record);
      ledger = next.ledger;
    } else if (step === 4 && members.length > 1) {
      const target = members.shift()!;
      const device = ledger.state.devices.get(hex(target.publicKey));
      if (!device) continue;
      const next = await append(ledger, owner, {
        type: 'removeMember',
        membershipId: device.membershipId,
      });
      records.push(next.record);
      ledger = next.ledger;
    } else {
      const recovery = await ed25519();
      const next = await append(
        ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, recovery, 'recovery', false)
      );
      records.push(next.record);
      ledger = next.ledger;
    }
  }
  return { owner, created, records, ledger };
}
