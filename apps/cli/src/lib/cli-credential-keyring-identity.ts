import { createHash } from 'node:crypto';
import path from 'node:path';

const KEYRING_SERVICE = 'Lody CLI';
const KEYRING_USERNAME_PREFIX = 'cloud-token';

export interface CliTokenKeyringIdentity {
  service: string;
  username: string;
  options: { linux: { store: 'secret-service' } };
}

/**
 * Stable keystore identity for one CLI data directory.
 *
 * The username includes a hash of the resolved directory so two installs do
 * not share an entry. The binding's `Entry` constructor is the one to use:
 * its `target` argument selects a macOS keychain domain, and on Windows
 * constructing an entry with a target writes an empty password.
 */
export function cliTokenKeyringIdentity(dataDir: string): CliTokenKeyringIdentity {
  const installId = createHash('sha256').update(path.resolve(dataDir)).digest('hex');
  return {
    service: KEYRING_SERVICE,
    username: `${KEYRING_USERNAME_PREFIX}.${installId}`,
    options: { linux: { store: 'secret-service' } },
  };
}
