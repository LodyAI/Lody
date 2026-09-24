import { describe, expect, it } from 'vitest';
import {
  readSessionShareSecret,
  removeSessionShareSecret,
  saveSessionShareSecret,
  sessionShareSecretKey,
} from '../src/lib/session-share-secrets';

function fixture() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
const key = sessionShareSecretKey('alice', 'workspace', 'share');
const secret = 'a'.repeat(64);
describe('device-local share secrets', () => {
  it('isolates account/workspace/link and checks credential version, not scope version', () => {
    const storage = fixture();
    expect(saveSessionShareSecret(storage, key, { credentialVersion: 2, secret })).toBe('stored');
    expect(readSessionShareSecret(storage, key, 2)).toBe(secret);
    expect(readSessionShareSecret(storage, key, 1)).toBeNull();
    for (const scope of [
      ['bob', 'workspace', 'share'],
      ['alice', 'other', 'share'],
      ['alice', 'workspace', 'other'],
    ]) {
      expect(
        readSessionShareSecret(storage, sessionShareSecretKey(scope[0]!, scope[1]!, scope[2]!), 2)
      ).toBeNull();
    }
  });
  it('preserves a newer reset when earlier reset/revoke responses arrive late', () => {
    const storage = fixture();
    saveSessionShareSecret(storage, key, { credentialVersion: 2, secret });
    expect(
      saveSessionShareSecret(storage, key, { credentialVersion: 1, secret: 'b'.repeat(64) })
    ).toBe('superseded');
    removeSessionShareSecret(storage, key, 1);
    expect(readSessionShareSecret(storage, key, 2)).toBe(secret);
    removeSessionShareSecret(storage, key, 2);
    expect(readSessionShareSecret(storage, key, 2)).toBeNull();
  });
  it('treats corrupt or inaccessible storage as missing and reports failed persistence', () => {
    const storage = fixture();
    for (const invalid of [
      '{',
      '{}',
      'null',
      JSON.stringify({ credentialVersion: 1, secret: 'bad' }),
    ]) {
      storage.setItem(key, invalid);
      expect(readSessionShareSecret(storage, key, 1)).toBeNull();
    }
    const blocked = {
      ...storage,
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readSessionShareSecret(blocked, key, 1)).toBeNull();
    expect(saveSessionShareSecret(blocked, key, { credentialVersion: 1, secret })).toBe(
      'unavailable'
    );
  });
});
