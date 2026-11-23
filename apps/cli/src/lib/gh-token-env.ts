import { createHash } from 'crypto';

export const LODY_MANAGED_GH_TOKEN_SHA256_ENV = 'LODY_MANAGED_GH_TOKEN_SHA256';

export const getGhTokenFingerprint = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const clearManagedGhTokenEnv = (env: Record<string, string | undefined>): void => {
  const marker = env[LODY_MANAGED_GH_TOKEN_SHA256_ENV];
  if (!marker) return;
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const token = env[key];
    if (token && getGhTokenFingerprint(token) === marker) {
      delete env[key];
      delete env[LODY_MANAGED_GH_TOKEN_SHA256_ENV];
    }
  }
};

export const GITHUB_CREDENTIAL_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  LODY_MANAGED_GH_TOKEN_SHA256_ENV,
];

/** Remove host credentials before handing an environment to a non-owner process. */
export const clearGitHubTokenEnv = (env: Record<string, string | undefined>): void => {
  // Windows child environments treat variable names case-insensitively.
  for (const key of Object.keys(env)) {
    if (GITHUB_CREDENTIAL_ENV_KEYS.includes(key.toUpperCase())) delete env[key];
  }
};
