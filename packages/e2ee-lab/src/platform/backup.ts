import {
  createRecoveryFile,
  importRecoveryDevice,
  openRecoveryBackup,
  sealRecoveryBackup,
} from '@lody/e2ee-core';
import { asArrayBuffer, fromHex, toHex } from './bytes';
import type { DemoDevice } from './device';

export interface BackupSession {
  genesisHex: string | null;
  epochKeys: Map<number, Uint8Array>;
  account: string;
  adoptGenesis(genesisHex: string): Promise<void>;
}

const DEMO_BACKUP = 'e2ee-demo-backup/v2';
const DEMO_MATERIAL = 'e2ee-demo-material/v1';

export async function backupFingerprint(recoveryPublicKey: Uint8Array): Promise<string> {
  return toHex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', asArrayBuffer(recoveryPublicKey)))
  );
}

function encodeMaterial(
  recoverySecret: Uint8Array,
  epochs: Map<number, Uint8Array>,
  genesisHex: string,
  account: string
): Uint8Array {
  const rows = [...epochs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([epoch, key]) => [epoch, toHex(key)]);
  return new TextEncoder().encode(
    JSON.stringify([DEMO_MATERIAL, toHex(recoverySecret), rows, genesisHex, account])
  );
}

function decodeMaterial(material: Uint8Array): {
  recoverySecret: Uint8Array;
  epochs: Map<number, Uint8Array>;
  genesisHex: string;
  account: string;
} {
  const fields = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(material)) as unknown;
  if (!Array.isArray(fields) || fields[0] !== DEMO_MATERIAL)
    throw new Error('invalid-demo-material');
  const rows = fields[2] as Array<[number, string]>;
  const epochs = new Map(rows.map(([epoch, key]) => [epoch, fromHex(key)]));
  return {
    recoverySecret: fromHex(String(fields[1])),
    epochs,
    genesisHex: String(fields[3]),
    account: String(fields[4]),
  };
}

export async function exportBackup(
  session: BackupSession,
  recovery: { secret: Uint8Array; publicKey: Uint8Array }
): Promise<Uint8Array> {
  if (!session.genesisHex) throw new Error('no-space');
  const file = createRecoveryFile();
  const fingerprint = await backupFingerprint(recovery.publicKey);
  const material = encodeMaterial(
    recovery.secret,
    session.epochKeys,
    session.genesisHex,
    session.account
  );
  const sealed = sealRecoveryBackup(file, { identity: fingerprint, revision: 0 }, material);
  material.fill(0);
  return new TextEncoder().encode(
    JSON.stringify([DEMO_BACKUP, toHex(file), fingerprint, toHex(sealed)])
  );
}

export async function restoreBackup(
  session: BackupSession,
  backup: Uint8Array
): Promise<{
  fingerprint: string;
  recovery: Awaited<ReturnType<typeof importRecoveryDevice>>;
}> {
  const fields = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(backup)) as unknown;
  if (!Array.isArray(fields) || fields[0] !== DEMO_BACKUP) throw new Error('invalid-demo-backup');
  const file = fromHex(String(fields[1]));
  const fingerprint = String(fields[2]);
  const sealed = fromHex(String(fields[3]));
  const material = openRecoveryBackup(file, { identity: fingerprint, revision: 0 }, sealed);
  const parsed = decodeMaterial(material);
  material.fill(0);
  const recovery = await importRecoveryDevice(parsed.recoverySecret);
  parsed.recoverySecret.fill(0);
  session.epochKeys = parsed.epochs;
  await session.adoptGenesis(parsed.genesisHex);
  return { fingerprint, recovery };
}

export function recoveryAsDevice(
  recovery: Awaited<ReturnType<typeof importRecoveryDevice>>
): DemoDevice {
  return {
    publicKey: recovery.publicKey,
    enc: recovery.enc,
    signing: recovery.recipientKeyPair,
    encryption: recovery.recipientKeyPair,
    sign: (bytes) => recovery.sign(bytes),
  };
}
