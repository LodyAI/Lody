import {
  createRecoveryDeviceSecret,
  createRecoveryFile,
  createUserIdentity,
  importRecoveryDevice,
  openRecoveryBackup,
  restoreUserIdentity,
  sealRecoveryBackup,
} from '@lody/e2ee-core';
import { fromHex, toHex } from './bytes';
import type { DemoSession } from './session';

const DEMO_BACKUP = 'e2ee-demo-backup/v1';

export async function exportBackup(
  session: DemoSession,
  recovery: {
    secret: Uint8Array;
    publicKey: Uint8Array;
  }
): Promise<Uint8Array> {
  const created = await createUserIdentity();
  const file = createRecoveryFile();
  const sealedUser = sealRecoveryBackup(
    file,
    { identity: created.identity.fingerprint, revision: 0 },
    created.privateMaterial
  );
  created.privateMaterial.fill(0);
  const payload = JSON.stringify([
    DEMO_BACKUP,
    toHex(file),
    created.identity.fingerprint,
    toHex(sealedUser),
    toHex(recovery.secret),
    toHex(recovery.publicKey),
    session.genesisHex,
    session.account,
  ]);
  return new TextEncoder().encode(payload);
}

export async function restoreBackup(
  session: DemoSession,
  backup: Uint8Array
): Promise<{
  fingerprint: string;
  recovery: ReturnType<typeof importRecoveryDevice> extends Promise<infer T> ? T : never;
}> {
  const fields = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(backup)) as unknown;
  if (!Array.isArray(fields) || fields[0] !== DEMO_BACKUP) throw new Error('invalid-demo-backup');
  const file = fromHex(String(fields[1]));
  const fingerprint = String(fields[2]);
  const sealedUser = fromHex(String(fields[3]));
  const recoverySecret = fromHex(String(fields[4]));
  const material = openRecoveryBackup(file, { identity: fingerprint, revision: 0 }, sealedUser);
  await restoreUserIdentity(material, fingerprint);
  const recovery = await importRecoveryDevice(recoverySecret);
  if (typeof fields[6] === 'string' && fields[6].length > 0) await session.adoptGenesis(fields[6]);
  return { fingerprint, recovery };
}

export { createRecoveryDeviceSecret, createRecoveryFile };
