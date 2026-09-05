import { describe, expect, it } from 'vitest';
import {
  clearManagedGhTokenEnv,
  getGhTokenFingerprint,
  LODY_MANAGED_GH_TOKEN_SHA256_ENV,
} from './gh-token-env';

describe('clearManagedGhTokenEnv', () => {
  it.each(['GH_TOKEN', 'GITHUB_TOKEN'])(
    'removes only the marked %s, preserving user credentials',
    (managedKey) => {
      const userKey = managedKey === 'GH_TOKEN' ? 'GITHUB_TOKEN' : 'GH_TOKEN';
      const env: Record<string, string> = {
        [managedKey]: 'managed-token',
        [userKey]: 'user-token',
        [LODY_MANAGED_GH_TOKEN_SHA256_ENV]: getGhTokenFingerprint('managed-token'),
      };
      clearManagedGhTokenEnv(env);
      expect(env).toEqual({ [userKey]: 'user-token' });
    }
  );

  it('preserves unmarked user tokens', () => {
    const env = { GH_TOKEN: 'user-token' };
    clearManagedGhTokenEnv(env);
    expect(env).toEqual({ GH_TOKEN: 'user-token' });
  });
});
