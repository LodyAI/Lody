/**
 * README-only throwaway consumer. Imports the public package twice and
 * drives Ledger.verify / Ledger.extend on a real signed chain.
 */
import { Ledger as LedgerA } from '@lody/e2ee-core';
import { Ledger as LedgerB } from '@lody/e2ee-core';
import {
  commitEpochKey,
  encodeGenesisBody,
  encodeSignedRecord,
  hashRecord,
  joinRequestSigningBytes,
  possessionSigningBytes,
  signingBytesForBody,
} from '@lody/e2ee-core/ledger';

async function ed25519() {
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

function random(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

const owner = await ed25519();
const secret = random(32);
const body = encodeGenesisBody({
  signer: owner.publicKey,
  userId: random(32),
  membershipId: random(16),
  encryptionPublicKey: owner.enc,
  epochCommitment: await commitEpochKey(new Uint8Array(32), 0, secret),
});
const genesis = encodeSignedRecord(body, await owner.sign(signingBytesForBody(body)));
const anchor = await hashRecord(genesis);

if (LedgerA !== LedgerB) throw new Error('double-import-identity');
const first = await LedgerA.verify({ anchor, records: [genesis] });
if (first.length !== 1) throw new Error('verify-length');
if (first.head.some((byte, i) => byte !== anchor[i])) throw new Error('verify-head');

const extra = await ed25519();
const proposal = first.prepare(
  {
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
  owner.publicKey
);
const suffix = encodeSignedRecord(proposal.bodyBytes, await owner.sign(proposal.signingBytes));
const extended = await first.extend([suffix]);
const again = await LedgerB.verify({ anchor, records: [genesis, suffix] });
if (extended.length !== 2 || again.length !== 2) throw new Error('extend-length');
if (extended.head.some((byte, i) => byte !== again.head[i])) throw new Error('extend-head');

const applicant = await ed25519();
const join = {
  requestId: random(16),
  userId: random(32),
  signingPublicKey: applicant.publicKey,
  encryptionPublicKey: applicant.enc,
  expiresAt: null as number | null,
};
const membershipId = random(16);
const joinProposal = extended.prepare(
  {
    type: 'admitMember',
    membershipId,
    request: {
      ...join,
      signature: await applicant.sign(joinRequestSigningBytes(anchor, join)),
    },
  },
  owner.publicKey
);
const joinedRecord = encodeSignedRecord(
  joinProposal.bodyBytes,
  await owner.sign(joinProposal.signingBytes)
);
const joined = await extended.extend([joinedRecord]);
const transferProposal = joined.prepare(
  { type: 'transferOwner', successorMembershipId: membershipId },
  owner.publicKey
);
const transferRecord = encodeSignedRecord(
  transferProposal.bodyBytes,
  await owner.sign(transferProposal.signingBytes)
);
const transferred = await joined.extend([transferRecord]);
const fromZero = await LedgerB.verify({
  anchor,
  records: [genesis, suffix, joinedRecord, transferRecord],
});
if (transferred.length !== 4 || fromZero.length !== 4) throw new Error('transfer-length');
if (transferred.head.some((byte, i) => byte !== fromZero.head[i])) throw new Error('transfer-head');
const ownerHex = Buffer.from(transferred.state.owner).toString('hex');
const successorHex = Buffer.from(membershipId).toString('hex');
if (ownerHex !== successorHex) throw new Error('transfer-owner');

process.stdout.write(
  `${JSON.stringify(
    {
      imports: ['@lody/e2ee-core', '@lody/e2ee-core', '@lody/e2ee-core/ledger'],
      sameExport: LedgerA === LedgerB,
      verifyLength: first.length,
      extendLength: extended.length,
      transferLength: transferred.length,
      fromZeroMatchesExtend: true,
      transferredOwner: successorHex,
      head: Buffer.from(transferred.head).toString('hex'),
    },
    null,
    2
  )}\n`
);
