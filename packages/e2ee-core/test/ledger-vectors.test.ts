import { getPublicKeyAsync, signAsync } from '@noble/ed25519';
import { encode } from '@ipld/dag-cbor';
import { describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger';
import { decodeCbor } from '../src/ledger/cbor';
import { HISTORY_PACKET_BYTES, commitEpochKey, hashRecord } from '../src/ledger/crypto';
import {
  decodeRecord,
  encodeGenesisBody,
  encodeSignedRecord,
  joinRequestSigningBytes,
  possessionSigningBytes,
  signingBytesForBody,
} from '../src/ledger/schema';
import { hex } from './ledger-fixtures';

const OWNER_SECRET = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
const MEMBER_SECRET = fill(0x02);
const PHONE_SECRET = fill(0x03);
const MACHINE_SECRET = fill(0x04);
const RECOVERY_SECRET = fill(0x05);

function fill(byte: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
}

async function device(secret: Uint8Array, encFill: number) {
  const publicKey = await getPublicKeyAsync(secret);
  const enc = fill(encFill);
  return {
    publicKey,
    enc,
    async sign(bytes: Uint8Array) {
      return Uint8Array.from(await signAsync(bytes, secret));
    },
  };
}

function roundTrip(record: Uint8Array): void {
  expect(hex(Uint8Array.from(encode(decodeCbor(record))))).toBe(hex(record));
}

describe('L1 full-operation DAG-CBOR golden vectors', () => {
  it('freezes genesis through every confirmed operation and rejects transfer', async () => {
    const owner = await device(OWNER_SECRET, 0x33);
    const member = await device(MEMBER_SECRET, 0x35);
    const phone = await device(PHONE_SECRET, 0x36);
    const machine = await device(MACHINE_SECRET, 0x37);
    const recovery = await device(RECOVERY_SECRET, 0x38);

    const genesisBody = encodeGenesisBody({
      signer: owner.publicKey,
      userId: fill(0x11),
      membershipId: fill(0x22, 16),
      encryptionPublicKey: owner.enc,
      epochCommitment: fill(0x44),
    });
    const genesis = encodeSignedRecord(
      genesisBody,
      await owner.sign(signingBytesForBody(genesisBody))
    );
    const records = [genesis];
    let ledger = await Ledger.verify({
      anchor: await hashRecord(genesis),
      records: [genesis],
    });
    const genesisHash = ledger.hashAt(0);

    const join = {
      requestId: fill(0x17, 16),
      userId: fill(0x15),
      signingPublicKey: member.publicKey,
      encryptionPublicKey: member.enc,
      expiresAt: null as number | null,
    };
    const admit = await appendSigned(ledger, owner, {
      type: 'admitMember',
      membershipId: fill(0x25, 16),
      request: {
        ...join,
        signature: await member.sign(joinRequestSigningBytes(genesisHash, join)),
      },
    });
    records.push(admit.record);
    ledger = admit.ledger;

    const promoted = await appendSigned(ledger, owner, {
      type: 'setRole',
      membershipId: fill(0x25, 16),
      role: 'admin',
    });
    records.push(promoted.record);
    ledger = promoted.ledger;

    const personal = await appendSigned(
      ledger,
      owner,
      await possess(genesisHash, phone, 'personal', true)
    );
    records.push(personal.record);
    ledger = personal.ledger;

    const machineRec = await appendSigned(
      ledger,
      owner,
      await possess(genesisHash, machine, 'machine', false)
    );
    records.push(machineRec.record);
    ledger = machineRec.ledger;

    const recoveryRec = await appendSigned(
      ledger,
      owner,
      await possess(genesisHash, recovery, 'recovery', false)
    );
    records.push(recoveryRec.record);
    ledger = recoveryRec.ledger;

    const epochSecret = fill(0x55);
    const published = await appendSigned(ledger, owner, {
      type: 'publishEpoch',
      epoch: 1,
      commitment: await commitEpochKey(genesisHash, 1, epochSecret),
      previousEpochKey: fill(0x66, HISTORY_PACKET_BYTES),
    });
    records.push(published.record);
    ledger = published.ledger;

    const revoked = await appendSigned(ledger, owner, {
      type: 'revokeDevice',
      target: phone.publicKey,
    });
    records.push(revoked.record);
    ledger = revoked.ledger;

    const removed = await appendSigned(ledger, owner, {
      type: 'removeMember',
      membershipId: fill(0x25, 16),
    });
    records.push(removed.record);
    ledger = removed.ledger;

    const kinds = records.map((record) => {
      roundTrip(record);
      const decoded = decodeRecord(record);
      return decoded.body.type === 'genesis' ? 'genesis' : decoded.body.fields.operation.type;
    });
    expect(kinds).toEqual([
      'genesis',
      'admitMember',
      'setRole',
      'admitDevice',
      'admitDevice',
      'admitDevice',
      'publishEpoch',
      'revokeDevice',
      'removeMember',
    ]);
    const machineBody = decodeRecord(records[4]!);
    const recoveryBody = decodeRecord(records[5]!);
    expect(machineBody.body.type).toBe('ordinary');
    expect(recoveryBody.body.type).toBe('ordinary');
    if (machineBody.body.type === 'ordinary' && recoveryBody.body.type === 'ordinary') {
      expect(machineBody.body.fields.operation).toMatchObject({
        type: 'admitDevice',
        kind: 'machine',
      });
      expect(recoveryBody.body.fields.operation).toMatchObject({
        type: 'admitDevice',
        kind: 'recovery',
      });
    }

    const hashes = [];
    for (const record of records) hashes.push(hex(await hashRecord(record)));
    expect(hashes).toEqual([
      'c4c4beea624a4e8dfc5ab3f9a47d935ca9632b62bfcd7defd8e81b20f559aaad',
      '70af9f3171ac870499319cc23ddcbf74da3c7214bb34e6cd0f8541e5590bab59',
      '19c1d73823746fc5170ffc4144eb06390c551dadb53a340c1313738277ada798',
      '756c76c265c16cd0e766d0baed37b69b8398c2b519591505b61dbeced5101561',
      '23dfaa6c960b3dc08fc220f487e518276e790e8f445fef4e2b61575361ed2dfb',
      '289f6f9c4c7b5537e89b1d4a0283795f23f0434fd052511d703b7d169a7322d6',
      'c8fa02c237a1ce486bf872b693f9cb2871b829bc7b3ffaa0424b29d0c641b012',
      '3f112f7bfe11e120fc47a765673a0d441d86ad67300aca3c3e8164c7b6b3faad',
      'c1ec25af059a3a2cda48e8e3034a30c52eefdc98ac69003ae4351e1cc5c4eb8a',
    ]);

    const full = await Ledger.verify({ anchor: genesisHash, records });
    expect(full.length).toBe(9);
    expect(full.state.epoch.number).toBe(1);
    expect(full.state.devices.has(hex(phone.publicKey))).toBe(false);
    expect(full.state.members.size).toBe(1);

    const transferBody = encodeSignedRecord(
      (await import('../src/ledger/cbor')).encodeCbor([
        full.head,
        owner.publicKey,
        [6, fill(0x25, 16)],
      ]),
      await owner.sign(
        signingBytesForBody(
          (await import('../src/ledger/cbor')).encodeCbor([
            full.head,
            owner.publicKey,
            [6, fill(0x25, 16)],
          ])
        )
      )
    );
    await expect(full.extend([transferBody])).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});

async function possess(
  genesis: Uint8Array,
  deviceKeys: Awaited<ReturnType<typeof device>>,
  kind: 'personal' | 'machine' | 'recovery',
  canManage: boolean
) {
  return {
    type: 'admitDevice' as const,
    kind,
    signingPublicKey: deviceKeys.publicKey,
    encryptionPublicKey: deviceKeys.enc,
    canManage,
    possessionSignature: await deviceKeys.sign(
      possessionSigningBytes({
        genesis,
        signingPublicKey: deviceKeys.publicKey,
        encryptionPublicKey: deviceKeys.enc,
        kind,
        canManage,
      })
    ),
  };
}

async function appendSigned(
  ledger: Awaited<ReturnType<typeof Ledger.verify>>,
  signer: Awaited<ReturnType<typeof device>>,
  operation: Parameters<Awaited<ReturnType<typeof Ledger.verify>>['prepare']>[0]
) {
  const proposal = ledger.prepare(operation, signer.publicKey);
  const record = encodeSignedRecord(proposal.bodyBytes, await signer.sign(proposal.signingBytes));
  return { ledger: await ledger.extend([record]), record };
}
