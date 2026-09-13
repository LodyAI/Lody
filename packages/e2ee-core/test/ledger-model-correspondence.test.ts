import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Ledger, LedgerError } from '@lody/e2ee-core';
import {
  HISTORY_PACKET_BYTES,
  commitEpochKey,
  encodeGenesisBody,
  encodeSignedRecord,
  hashRecord,
  joinRequestSigningBytes,
  possessionSigningBytes,
  signingBytesForBody,
  type Operation,
} from '@lody/e2ee-core/ledger';
import { genesis, leanStep, type LeanOp, type LeanState } from './ledger-model';

type Device = {
  publicKey: Uint8Array;
  enc: Uint8Array;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
};

function random(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function device(): Promise<Device> {
  const sign = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', sign.publicKey));
  const dh = (await crypto.subtle.generateKey('X25519', false, ['deriveBits'])) as CryptoKeyPair;
  const enc = new Uint8Array(await crypto.subtle.exportKey('raw', dh.publicKey));
  void dh;
  return {
    publicKey,
    enc,
    async sign(bytes: Uint8Array) {
      const message = new Uint8Array(bytes.byteLength);
      message.set(bytes);
      return new Uint8Array(await crypto.subtle.sign('Ed25519', sign.privateKey, message));
    },
  };
}

async function genesisLedger(owner: Device) {
  const secret = random(32);
  const body = encodeGenesisBody({
    signer: owner.publicKey,
    userId: random(32),
    membershipId: random(16),
    encryptionPublicKey: owner.enc,
    epochCommitment: await commitEpochKey(new Uint8Array(32), 0, secret),
  });
  const record = encodeSignedRecord(body, await owner.sign(signingBytesForBody(body)));
  const anchor = await hashRecord(record);
  const ledger = await Ledger.verify({ anchor, records: [record] });
  return { record, anchor, ledger, membershipId: body };
}

describe('M3 Lean model ↔ public Ledger API', () => {
  it('accepts and rejects the same synthetic trace as E2EE.step, including broken guards', async () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/\bfrom '([^']+)'/g)].map((match) => match[1]!);
    expect(specifiers.some((value) => value.includes('../src') || value.includes('src/'))).toBe(
      false
    );
    expect(specifiers).toContain('@lody/e2ee-core');
    expect(specifiers).toContain('@lody/e2ee-core/ledger');

    const owner = await device();
    const secret = random(32);
    const ownerMembership = random(16);
    const body = encodeGenesisBody({
      signer: owner.publicKey,
      userId: random(32),
      membershipId: ownerMembership,
      encryptionPublicKey: owner.enc,
      epochCommitment: await commitEpochKey(new Uint8Array(32), 0, secret),
    });
    const genesisRecord = encodeSignedRecord(body, await owner.sign(signingBytesForBody(body)));
    const anchor = await hashRecord(genesisRecord);
    const records = [genesisRecord];
    let ledger = await Ledger.verify({ anchor, records });

    const devices = new Map<number, Device>([[0, owner]]);
    const memberships = new Map<number, Uint8Array>([[0, ownerMembership]]);
    let lean: LeanState = genesis;

    const tryLedger = async (signer: Device, operation: Operation) => {
      try {
        const proposal = ledger.prepare(operation, signer.publicKey);
        const record = await ledger.finalize(proposal, await signer.sign(proposal.signingBytes));
        const next = await ledger.extend([record]);
        return { ok: true as const, record, ledger: next };
      } catch (error) {
        return { ok: false as const, error };
      }
    };

    const admitMemberOp = async (applicant: Device): Promise<Operation> => ({
      type: 'admitMember',
      membershipId: random(16),
      request: {
        requestId: random(16),
        userId: random(32),
        signingPublicKey: applicant.publicKey,
        encryptionPublicKey: applicant.enc,
        expiresAt: null,
        signature: await applicant.sign(
          joinRequestSigningBytes(anchor, {
            requestId: random(16),
            userId: random(32),
            signingPublicKey: applicant.publicKey,
            encryptionPublicKey: applicant.enc,
            expiresAt: null,
          })
        ),
      },
    });

    async function apply(
      op: LeanOp,
      build: () => Promise<{ signer: Device; operation: Operation }>
    ) {
      const model = leanStep(lean, op);
      const { signer, operation } = await build();
      const result = await tryLedger(signer, operation);
      expect(result.ok, JSON.stringify(op)).toBe(model !== null);
      if (model && result.ok) {
        lean = model;
        records.push(result.record);
        ledger = result.ledger;
        expect(ledger.state.epoch.number).toBe(lean.epoch);
        expect(ledger.state.members.size).toBe(lean.members.length);
        expect(ledger.state.devices.size).toBe(lean.devices.length);
      } else if (!result.ok) {
        expect(result.error).toBeInstanceOf(LedgerError);
      }
    }

    const member = await device();
    devices.set(1, member);
    const memberJoin = {
      requestId: random(16),
      userId: random(32),
      signingPublicKey: member.publicKey,
      encryptionPublicKey: member.enc,
      expiresAt: null as number | null,
    };
    const memberJoinSigned = {
      ...memberJoin,
      signature: await member.sign(joinRequestSigningBytes(anchor, memberJoin)),
    };
    const memberMembership = random(16);
    memberships.set(2, memberMembership);
    await apply({ type: 'admitMember', actor: 0, newMember: 2, firstDevice: 1 }, async () => ({
      signer: owner,
      operation: { type: 'admitMember', membershipId: memberMembership, request: memberJoinSigned },
    }));

    await apply({ type: 'setRoleAdmin', actor: 0, target: 2 }, async () => ({
      signer: owner,
      operation: { type: 'setRole', membershipId: memberMembership, role: 'admin' },
    }));

    const adminManage = await device();
    devices.set(3, adminManage);
    await apply(
      { type: 'admitDevice', actor: 1, newId: 3, kind: 'personal', canManage: true },
      async () => {
        const target = adminManage;
        return {
          signer: member,
          operation: {
            type: 'admitDevice',
            kind: 'personal',
            signingPublicKey: target.publicKey,
            encryptionPublicKey: target.enc,
            canManage: true,
            possessionSignature: await target.sign(
              possessionSigningBytes({
                genesis: anchor,
                signingPublicKey: target.publicKey,
                encryptionPublicKey: target.enc,
                kind: 'personal',
                canManage: true,
              })
            ),
          },
        };
      }
    );

    await apply({ type: 'publishEpoch', actor: 3 }, async () => ({
      signer: adminManage,
      operation: {
        type: 'publishEpoch',
        epoch: ledger.state.epoch.number + 1,
        commitment: await commitEpochKey(anchor, ledger.state.epoch.number + 1, random(32)),
        previousEpochKey: random(HISTORY_PACKET_BYTES),
      },
    }));

    const recovery = await device();
    devices.set(4, recovery);
    await apply(
      { type: 'admitDevice', actor: 0, newId: 4, kind: 'recovery', canManage: false },
      async () => ({
        signer: owner,
        operation: {
          type: 'admitDevice',
          kind: 'recovery',
          signingPublicKey: recovery.publicKey,
          encryptionPublicKey: recovery.enc,
          canManage: false,
          possessionSignature: await recovery.sign(
            possessionSigningBytes({
              genesis: anchor,
              signingPublicKey: recovery.publicKey,
              encryptionPublicKey: recovery.enc,
              kind: 'recovery',
              canManage: false,
            })
          ),
        },
      })
    );

    await apply({ type: 'publishEpoch', actor: 4 }, async () => ({
      signer: recovery,
      operation: {
        type: 'publishEpoch',
        epoch: ledger.state.epoch.number + 1,
        commitment: await commitEpochKey(anchor, ledger.state.epoch.number + 1, random(32)),
        previousEpochKey: random(HISTORY_PACKET_BYTES),
      },
    }));

    await apply({ type: 'removeMember', actor: 3, target: 2 }, async () => ({
      signer: adminManage,
      operation: { type: 'removeMember', membershipId: memberMembership },
    }));

    const extra = await device();
    devices.set(5, extra);
    await apply(
      { type: 'admitDevice', actor: 0, newId: 5, kind: 'personal', canManage: false },
      async () => ({
        signer: owner,
        operation: {
          type: 'admitDevice',
          kind: 'personal',
          signingPublicKey: extra.publicKey,
          encryptionPublicKey: extra.enc,
          canManage: false,
          possessionSignature: await extra.sign(
            possessionSigningBytes({
              genesis: anchor,
              signingPublicKey: extra.publicKey,
              encryptionPublicKey: extra.enc,
              kind: 'personal',
              canManage: false,
            })
          ),
        },
      })
    );
    await apply({ type: 'revokeDevice', actor: 0, target: 5 }, async () => ({
      signer: owner,
      operation: { type: 'revokeDevice', target: extra.publicKey },
    }));
    await apply(
      { type: 'admitDevice', actor: 0, newId: 5, kind: 'personal', canManage: false },
      async () => ({
        signer: owner,
        operation: {
          type: 'admitDevice',
          kind: 'personal',
          signingPublicKey: extra.publicKey,
          encryptionPublicKey: extra.enc,
          canManage: false,
          possessionSignature: await extra.sign(
            possessionSigningBytes({
              genesis: anchor,
              signingPublicKey: extra.publicKey,
              encryptionPublicKey: extra.enc,
              kind: 'personal',
              canManage: false,
            })
          ),
        },
      })
    );

    const plain = await device();
    devices.set(6, plain);
    const plainMembership = random(16);
    memberships.set(7, plainMembership);
    const plainJoin = {
      requestId: random(16),
      userId: random(32),
      signingPublicKey: plain.publicKey,
      encryptionPublicKey: plain.enc,
      expiresAt: null as number | null,
    };
    await apply({ type: 'admitMember', actor: 0, newMember: 7, firstDevice: 6 }, async () => ({
      signer: owner,
      operation: {
        type: 'admitMember',
        membershipId: plainMembership,
        request: {
          ...plainJoin,
          signature: await plain.sign(joinRequestSigningBytes(anchor, plainJoin)),
        },
      },
    }));
    const plainRecovery = await device();
    devices.set(8, plainRecovery);
    await apply(
      { type: 'admitDevice', actor: 6, newId: 8, kind: 'recovery', canManage: false },
      async () => ({
        signer: plain,
        operation: {
          type: 'admitDevice',
          kind: 'recovery',
          signingPublicKey: plainRecovery.publicKey,
          encryptionPublicKey: plainRecovery.enc,
          canManage: false,
          possessionSignature: await plainRecovery.sign(
            possessionSigningBytes({
              genesis: anchor,
              signingPublicKey: plainRecovery.publicKey,
              encryptionPublicKey: plainRecovery.enc,
              kind: 'recovery',
              canManage: false,
            })
          ),
        },
      })
    );
    const granted = await device();
    devices.set(9, granted);
    await apply(
      { type: 'admitDevice', actor: 8, newId: 9, kind: 'personal', canManage: true },
      async () => ({
        signer: plainRecovery,
        operation: {
          type: 'admitDevice',
          kind: 'personal',
          signingPublicKey: granted.publicKey,
          encryptionPublicKey: granted.enc,
          canManage: true,
          possessionSignature: await granted.sign(
            possessionSigningBytes({
              genesis: anchor,
              signingPublicKey: granted.publicKey,
              encryptionPublicKey: granted.enc,
              kind: 'personal',
              canManage: true,
            })
          ),
        },
      })
    );

    await apply({ type: 'setRoleGuest', actor: 6, target: 7 }, async () => ({
      signer: plain,
      operation: { type: 'setRole', membershipId: plainMembership, role: 'guest' },
    }));
    await apply({ type: 'setRoleGuest', actor: 0, target: 7 }, async () => ({
      signer: owner,
      operation: { type: 'setRole', membershipId: plainMembership, role: 'guest' },
    }));
    await apply({ type: 'transferOwner', actor: 6, successor: 0 }, async () => ({
      signer: plain,
      operation: { type: 'transferOwner', successorMembershipId: ownerMembership },
    }));
    await apply({ type: 'transferOwner', actor: 0, successor: 7 }, async () => ({
      signer: owner,
      operation: { type: 'transferOwner', successorMembershipId: plainMembership },
    }));
    await apply({ type: 'transferOwner', actor: 0, successor: 0 }, async () => ({
      signer: owner,
      operation: { type: 'transferOwner', successorMembershipId: ownerMembership },
    }));

    await apply({ type: 'removeMember', actor: 0, target: 0 }, async () => ({
      signer: owner,
      operation: { type: 'removeMember', membershipId: ownerMembership },
    }));

    const full = await Ledger.verify({ anchor, records });
    expect(full.head).toEqual(ledger.head);
    for (let split = 1; split < records.length; split++) {
      const prefix = await Ledger.verify({ anchor, records: records.slice(0, split) });
      const extended = await prefix.extend(records.slice(split));
      expect(extended.head, `split ${split}`).toEqual(full.head);
      expect(extended.state.epoch.number).toBe(full.state.epoch.number);
      expect(extended.state.members.size).toBe(full.state.members.size);
      expect(extended.state.devices.size).toBe(full.state.devices.size);
    }
  });
});
