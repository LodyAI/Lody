/**
 * Two-process recovery fixture. Restore mode may only read files written by setup.
 * It must not receive in-memory R handles, owner signers, or workspace keys.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Ledger,
  createRecoveryDeviceSecret,
  createRecoveryFile,
  importRecoveryDevice,
  openRecoveryBackup,
  sealRecoveryBackup,
} from '../src/index';
import {
  collectEpochPackets,
  commitEpochKey,
  encodeGenesisBody,
  encodeSignedRecord,
  hashRecord,
  openEpochEnvelope,
  joinRequestSigningBytes,
  possessionSigningBytes,
  recoverHistory,
  sealEpochEnvelope,
  sealHistoryPacket,
  signingBytesForBody,
} from '../src/ledger';
import { decodeRecord } from '../src/ledger/schema';

const dir = process.argv[3]!;
const mode = process.argv[2]!;
const variant = process.argv[4] ?? 'ok';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function write(name: string, bytes: Uint8Array) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
}

function read(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(dir, name)));
}

function frameRecords(records: readonly Uint8Array[]): Uint8Array {
  const chunks: Buffer[] = [];
  for (const record of records) {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(record.byteLength);
    chunks.push(header, Buffer.from(record));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function parseRecords(bytes: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = [];
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 4 <= bytes.byteLength) {
    const size = view.getUint32(offset);
    offset += 4;
    if (offset + size > bytes.byteLength) throw new Error('truncated-records');
    records.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  return records;
}

async function setup() {
  const ownerMaterial = await createRecoveryDeviceSecret();
  const owner = await importRecoveryDevice(ownerMaterial.secret);
  const recoveryMaterial = await createRecoveryDeviceSecret();
  const recovery = await importRecoveryDevice(recoveryMaterial.secret);
  const k0 = crypto.getRandomValues(new Uint8Array(32));
  const k1 = crypto.getRandomValues(new Uint8Array(32));
  const commitment0 = await commitEpochKey(new Uint8Array(32), 0, k0);
  const body = encodeGenesisBody({
    signer: owner.publicKey,
    userId: crypto.getRandomValues(new Uint8Array(32)),
    membershipId: crypto.getRandomValues(new Uint8Array(16)),
    encryptionPublicKey: owner.enc,
    epochCommitment: commitment0,
  });
  const genesis = encodeSignedRecord(body, await owner.sign(signingBytesForBody(body)));
  const anchor = await hashRecord(genesis);
  let ledger = await Ledger.verify({ anchor, records: [genesis] });
  const records = [genesis];

  let admitSigner = owner;
  let removedMembership: Uint8Array | null = null;
  if (variant === 'remove-member') {
    const memberMaterial = await createRecoveryDeviceSecret();
    const member = await importRecoveryDevice(memberMaterial.secret);
    removedMembership = crypto.getRandomValues(new Uint8Array(16));
    const request = {
      requestId: crypto.getRandomValues(new Uint8Array(16)),
      userId: crypto.getRandomValues(new Uint8Array(32)),
      signingPublicKey: member.publicKey,
      encryptionPublicKey: member.enc,
      expiresAt: null as number | null,
    };
    const joinPrep = ledger.prepare(
      {
        type: 'admitMember',
        membershipId: removedMembership,
        request: {
          ...request,
          signature: await member.sign(joinRequestSigningBytes(anchor, request)),
        },
      },
      owner.publicKey
    );
    const joinRecord = await ledger.finalize(joinPrep, await owner.sign(joinPrep.signingBytes));
    ledger = await ledger.extend([joinRecord]);
    records.push(joinRecord);
    admitSigner = member;
    memberMaterial.secret.fill(0);
  }

  const admitPrep = ledger.prepare(
    {
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
    admitSigner.publicKey
  );
  const admitRecord = await ledger.finalize(
    admitPrep,
    await admitSigner.sign(admitPrep.signingBytes)
  );
  ledger = await ledger.extend([admitRecord]);
  records.push(admitRecord);

  const packet = sealHistoryPacket(k1, k0, anchor, 1);
  const rotatePrep = ledger.prepare(
    {
      type: 'publishEpoch',
      epoch: 1,
      commitment: await commitEpochKey(anchor, 1, k1),
      previousEpochKey: packet,
    },
    owner.publicKey
  );
  const rotateRecord = await ledger.finalize(rotatePrep, await owner.sign(rotatePrep.signingBytes));
  ledger = await ledger.extend([rotateRecord]);
  records.push(rotateRecord);

  const envelope = await sealEpochEnvelope({
    state: ledger.state,
    genesis: anchor,
    epoch: 1,
    sender: owner.publicKey,
    recipient: recovery.publicKey,
    recipientEncryptionKey: recovery.enc,
    epochKey: k1,
    sign: (bytes) => owner.sign(bytes),
  });

  if (variant === 'revoke-r') {
    const revokePrep = ledger.prepare(
      { type: 'revokeDevice', target: recovery.publicKey },
      owner.publicKey
    );
    const revokeRecord = await ledger.finalize(
      revokePrep,
      await owner.sign(revokePrep.signingBytes)
    );
    ledger = await ledger.extend([revokeRecord]);
    records.push(revokeRecord);
  }

  if (variant === 'remove-member' && removedMembership) {
    const removePrep = ledger.prepare(
      { type: 'removeMember', membershipId: removedMembership },
      owner.publicKey
    );
    const removeRecord = await ledger.finalize(
      removePrep,
      await owner.sign(removePrep.signingBytes)
    );
    ledger = await ledger.extend([removeRecord]);
    records.push(removeRecord);
  }

  const file = createRecoveryFile();
  const backup = sealRecoveryBackup(
    file,
    { identity: hex(anchor), revision: 1 },
    recoveryMaterial.secret
  );
  const snapshotPrep = ledger.prepareSnapshot(owner.publicKey);
  const snapshot = await Ledger.finalizeSnapshot(
    snapshotPrep,
    await owner.sign(snapshotPrep.signingBytes)
  );
  const headSignature = await owner.sign(snapshotPrep.headAttestationSigningBytes);
  const snapshotIndex = records.length;

  write('anchor.bin', anchor);
  write('genesis.bin', genesis);
  write('records.bin', frameRecords(records));
  write('snapshot.bin', snapshot);
  write('endorser.bin', owner.publicKey);
  write('head.bin', snapshotPrep.head);
  write('head-sig.bin', headSignature);
  write('recovery-file.bin', file);
  write('backup.bin', backup);
  write('envelope.bin', variant === 'missing-envelope' ? new Uint8Array() : envelope);
  write('sender.bin', owner.publicKey);
  write('recipient.bin', recovery.publicKey);
  write('suffix.bin', frameRecords(records.slice(snapshotIndex)));
  k0.fill(0);
  k1.fill(0);
  recoveryMaterial.secret.fill(0);
  ownerMaterial.secret.fill(0);
}

async function restore() {
  const file = read('recovery-file.bin');
  const backup = read('backup.bin');
  if (variant === 'bad-backup') {
    const last = backup.byteLength - 1;
    const prev = backup[last];
    if (prev === undefined) throw new Error('empty-backup');
    backup[last] = prev ^ 0xff;
  }
  const identity = hex(read('anchor.bin'));
  const secret = openRecoveryBackup(file, { identity, revision: 1 }, backup);
  const r = await importRecoveryDevice(secret);
  secret.fill(0);
  const records = parseRecords(read('records.bin'));
  const ledger = await Ledger.verify({ anchor: read('anchor.bin'), records });
  const envelope = read('envelope.bin');
  if (envelope.byteLength === 0) throw new Error('missing-envelope');
  const latest = await openEpochEnvelope({
    state: ledger.state,
    genesis: read('anchor.bin'),
    epoch: ledger.state.epoch.number,
    sender: read('sender.bin'),
    recipient: r.publicKey,
    recipientKeyPair: r.recipientKeyPair,
    frame: envelope,
  });
  const genesisDecoded = decodeRecord(read('genesis.bin'));
  if (genesisDecoded.body.type !== 'genesis') throw new Error('not-genesis');
  const history = await recoverHistory({
    genesis: read('anchor.bin'),
    latestEpoch: ledger.state.epoch.number,
    latestKey: latest,
    packets: collectEpochPackets(records, genesisDecoded.body.fields.epochCommitment),
  });
  const nextMaterial = await createRecoveryDeviceSecret();
  const nextHandle = await importRecoveryDevice(nextMaterial.secret);
  const admitPrep = ledger.prepare(
    {
      type: 'admitDevice',
      kind: 'personal',
      signingPublicKey: nextMaterial.publicKey,
      encryptionPublicKey: nextMaterial.enc,
      canManage: true,
      possessionSignature: await nextHandle.sign(
        possessionSigningBytes({
          genesis: read('anchor.bin'),
          signingPublicKey: nextMaterial.publicKey,
          encryptionPublicKey: nextMaterial.enc,
          kind: 'personal',
          canManage: true,
        })
      ),
    },
    r.publicKey
  );
  const admitted = await ledger.finalize(admitPrep, await r.sign(admitPrep.signingBytes));
  const next = await ledger.extend([admitted]);
  write(
    'restore.json',
    new TextEncoder().encode(
      JSON.stringify({
        recoveredEpochs: [...history.keys()].sort((a, b) => a - b),
        newLength: next.length,
        canManage: next.state.devices.get(hex(nextMaterial.publicKey))?.canManage === true,
      })
    )
  );
}

async function restoreSnapshot() {
  const file = read('recovery-file.bin');
  const backup = read('backup.bin');
  if (variant === 'bad-backup') {
    const last = backup.byteLength - 1;
    const prev = backup[last];
    if (prev === undefined) throw new Error('empty-backup');
    backup[last] = prev ^ 0xff;
  }
  const identity = hex(read('anchor.bin'));
  const secret = openRecoveryBackup(file, { identity, revision: 1 }, backup);
  const r = await importRecoveryDevice(secret);
  secret.fill(0);
  const ledger = await Ledger.verifySnapshot({
    trust: {
      genesis: read('anchor.bin'),
      endorser: read('endorser.bin'),
      head: read('head.bin'),
      headSignature: read('head-sig.bin'),
    },
    snapshot: read('snapshot.bin'),
    suffix: parseRecords(read('suffix.bin')),
  });
  const envelope = read('envelope.bin');
  if (envelope.byteLength === 0) throw new Error('missing-envelope');
  const latest = await openEpochEnvelope({
    state: ledger.state,
    genesis: read('anchor.bin'),
    epoch: ledger.state.epoch.number,
    sender: read('sender.bin'),
    recipient: r.publicKey,
    recipientKeyPair: r.recipientKeyPair,
    frame: envelope,
  });
  const history = await recoverHistory({
    genesis: read('anchor.bin'),
    latestEpoch: ledger.state.epoch.number,
    latestKey: latest,
    packets: ledger.historyPackets(),
  });
  const nextMaterial = await createRecoveryDeviceSecret();
  const nextHandle = await importRecoveryDevice(nextMaterial.secret);
  const admitPrep = ledger.prepare(
    {
      type: 'admitDevice',
      kind: 'personal',
      signingPublicKey: nextMaterial.publicKey,
      encryptionPublicKey: nextMaterial.enc,
      canManage: true,
      possessionSignature: await nextHandle.sign(
        possessionSigningBytes({
          genesis: read('anchor.bin'),
          signingPublicKey: nextMaterial.publicKey,
          encryptionPublicKey: nextMaterial.enc,
          kind: 'personal',
          canManage: true,
        })
      ),
    },
    r.publicKey
  );
  const admitted = await ledger.finalize(admitPrep, await r.sign(admitPrep.signingBytes));
  const next = await ledger.extend([admitted]);
  write(
    'restore.json',
    new TextEncoder().encode(
      JSON.stringify({
        origin: next.origin,
        recoveredEpochs: [...history.keys()].sort((a, b) => a - b),
        newLength: next.length,
        canManage: next.state.devices.get(hex(nextMaterial.publicKey))?.canManage === true,
      })
    )
  );
}

if (mode === 'setup') await setup();
else if (mode === 'restore') await restore();
else if (mode === 'restore-snapshot') await restoreSnapshot();
else throw new Error(`unknown-mode:${mode}`);
