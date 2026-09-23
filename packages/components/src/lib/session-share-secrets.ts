import { isSessionShareSecret } from '@lody/shared/session-sharing';

type SecretStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type StoredSecret = { credentialVersion: number; secret: string };

/** Device-local credentials, NOT recoverable caches. Never sync them to Flock. */
export function sessionShareSecretKey(
  userId: string,
  workspaceId: string,
  shareId: string
): string {
  return `lody:session-share-secret:v1:${JSON.stringify([userId, workspaceId, shareId])}`;
}

function readRecord(storage: SecretStorage, key: string): StoredSecret | null {
  try {
    const raw = storage.getItem(key);
    const value: unknown = raw !== null ? JSON.parse(raw) : null;
    if (value === null || typeof value !== 'object') return null;
    if (!('credentialVersion' in value) || !('secret' in value)) return null;
    const { credentialVersion, secret } = value;
    return typeof credentialVersion === 'number' &&
      Number.isSafeInteger(credentialVersion) &&
      credentialVersion > 0 &&
      typeof secret === 'string' &&
      isSessionShareSecret(secret)
      ? { credentialVersion, secret }
      : null;
  } catch {
    return null;
  }
}

export function readSessionShareSecret(
  storage: SecretStorage,
  key: string,
  version: number
): string | null {
  const record = readRecord(storage, key);
  return record?.credentialVersion === version ? record.secret : null;
}

/** Called only after the corresponding server create/reset has succeeded. */
export function saveSessionShareSecret(
  storage: SecretStorage,
  key: string,
  record: StoredSecret
): 'stored' | 'superseded' | 'unavailable' {
  if (
    !Number.isSafeInteger(record.credentialVersion) ||
    record.credentialVersion < 1 ||
    !isSessionShareSecret(record.secret)
  )
    throw new Error('Invalid share credential');
  if ((readRecord(storage, key)?.credentialVersion ?? 0) > record.credentialVersion)
    return 'superseded';
  try {
    storage.setItem(key, JSON.stringify(record));
    return 'stored';
  } catch {
    return 'unavailable';
  }
}

/** A late revoke result must not erase a newer reset's secret on this device. */
export function removeSessionShareSecret(
  storage: SecretStorage,
  key: string,
  version: number
): void {
  if (readRecord(storage, key)?.credentialVersion !== version) return;
  try {
    storage.removeItem(key);
  } catch {
    /* The server still revokes the link. */
  }
}
