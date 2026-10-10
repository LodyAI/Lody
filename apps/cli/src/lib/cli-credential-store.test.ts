import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigPath } from '@/utils';
import { loadEnv } from '@/utils/const';
import { AuthClient } from './auth';
import {
  type CliTokenKeystore,
  type KeyringEntry,
  KeystoreUnavailableError,
  clearCliCredentials,
  cliCredentialFileTokenRemovalEnabled,
  cliTokenKeyringIdentity,
  openCliTokenKeyringEntry,
  createSystemCliTokenKeystore,
  linuxSecretServiceLooksAvailable,
  loadCliCredentials,
  resetCliCredentialStoreForTests,
  saveCliCredentials,
  setCliCredentialChmodForTests,
  setCliCredentialMigrationHookForTests,
  setCliCredentialPlatformForTests,
  setCliCredentialWindowsRestrictForTests,
  setCliTokenKeystoreForTests,
} from './cli-credential-store';

const logs = vi.hoisted(() => ({
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock('@/utils/logger', () => ({
  getLogger: () => ({
    info: logs.info,
    warn: logs.warn,
    error: logs.error,
    success: vi.fn(),
    debug: logs.debug,
    trace: vi.fn(),
    setLevel: vi.fn(),
    setDebug: vi.fn(),
    child: vi.fn(),
    close: vi.fn(async () => {}),
  }),
}));

class MemoryKeystore implements CliTokenKeystore {
  value: string | null = null;
  writes = 0;
  removed = 0;
  failWrite = false;
  failRead = false;
  failRemove = false;
  mismatch = false;

  read(): string | null {
    if (this.failRead) throw new KeystoreUnavailableError('keystore read failed');
    if (this.mismatch && this.value !== null) return `${this.value}-other`;
    return this.value;
  }

  write(token: string): void {
    this.writes += 1;
    if (this.failWrite) throw new KeystoreUnavailableError('keystore write failed');
    this.value = token;
  }

  remove(): void {
    this.removed += 1;
    if (this.failRemove) throw new Error('keystore remove failed');
    this.value = null;
  }
}

const user = { id: 'user-1', email: 'user@example.com', name: 'User One' };
const machine = { machineId: 'machine-1', machineName: 'test-machine' };
const posix = process.platform !== 'win32';

let dataDir: string;
let keystore: MemoryKeystore;

function credentialFile(): string {
  return getConfigPath();
}

function readFileRecord(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(credentialFile(), 'utf8')) as Record<string, unknown>;
}

function writeLegacyFile(record: Record<string, unknown>, mode = 0o600): void {
  const filePath = credentialFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
  if (process.platform !== 'win32') fs.chmodSync(filePath, mode);
}

beforeEach(() => {
  logs.warn.mockReset();
  logs.debug.mockReset();
  logs.error.mockReset();
  logs.info.mockReset();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-cli-credential-'));
  vi.stubEnv('LODY_DATA_DIR', dataDir);
  vi.stubEnv('LODY_AUTH_URL', 'https://convex.example.com');
  vi.stubEnv('LODY_AUTH_SITE_URL', 'https://auth.example.com');
  vi.stubEnv('LODY_CLI_DROP_FILE_TOKEN', '');
  vi.stubEnv('LODY_ELECTRON_SESSION_TOKEN', '');
  loadEnv();
  resetCliCredentialStoreForTests();
  keystore = new MemoryKeystore();
  setCliTokenKeystoreForTests(keystore);
});

afterEach(() => {
  resetCliCredentialStoreForTests();
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('CLI credential read precedence', () => {
  it('uses the credentials file when the keystore is empty', async () => {
    await saveCliCredentials({ token: 'file-token', user, machine });

    expect(loadCliCredentials()).toMatchObject({ token: 'file-token', user, machine });
    expect(readFileRecord().token).toBe('file-token');
    expect(keystore.value).toBe('file-token');
  });

  it('uses the keystore token when the credentials file has no token', () => {
    writeLegacyFile({
      version: 3,
      user,
      machine,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    keystore.value = 'keystore-token';

    expect(loadCliCredentials()?.token).toBe('keystore-token');
    expect(readFileRecord().token).toBeUndefined();
    expect(keystore.writes).toBe(0);
  });

  it('prefers a different file token and copies it into the keystore', async () => {
    await saveCliCredentials({ token: 'previous-token', user, machine });
    keystore.value = 'stale-keystore-token';

    expect(loadCliCredentials()?.token).toBe('previous-token');
    expect(keystore.value).toBe('previous-token');
    expect(readFileRecord().token).toBe('previous-token');
  });

  it('does not treat an injected session environment value as the stored token', () => {
    vi.stubEnv('LODY_ELECTRON_SESSION_TOKEN', 'session-token');
    writeLegacyFile({ version: 3, token: 'file-token', user, machine });

    expect(loadCliCredentials()?.token).toBe('file-token');

    writeLegacyFile({ version: 3, user, machine });
    keystore.value = null;
    expect(loadCliCredentials()).toBeNull();
  });
});

describe('CLI credential keystore copy', () => {
  it('keeps the file token unless removal is enabled', async () => {
    expect(cliCredentialFileTokenRemovalEnabled()).toBe(false);

    await saveCliCredentials({ token: 'kept-token', user, machine });

    expect(readFileRecord().token).toBe('kept-token');
    expect(keystore.value).toBe('kept-token');
    expect(loadCliCredentials()?.token).toBe('kept-token');
  });

  it('removes the file token only after the keystore read-back matches', async () => {
    vi.stubEnv('LODY_CLI_DROP_FILE_TOKEN', '1');
    writeLegacyFile({
      version: 3,
      token: 'legacy-token',
      user,
      machine,
      source: 'legacy',
    });

    const loaded = loadCliCredentials();

    expect(loaded?.token).toBe('legacy-token');
    expect(keystore.value).toBe('legacy-token');
    const saved = readFileRecord();
    expect(saved.token).toBeUndefined();
    expect(saved.source).toBe('legacy');
    expect(saved.user).toMatchObject(user);
    expect(saved.machine).toMatchObject(machine);

    expect(loadCliCredentials()?.token).toBe('legacy-token');
    expect(keystore.writes).toBe(1);
  });

  it('leaves the file token in place when the keystore write throws', async () => {
    vi.stubEnv('LODY_CLI_DROP_FILE_TOKEN', '1');
    keystore.failWrite = true;

    await saveCliCredentials({ token: 'legacy-token', user, machine });
    expect(loadCliCredentials()?.token).toBe('legacy-token');

    expect(readFileRecord().token).toBe('legacy-token');
    expect(keystore.value).toBeNull();
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn.mock.calls[0]?.[0]).toContain('credentials file');
  });

  it('leaves the file token in place when the keystore read-back differs', async () => {
    vi.stubEnv('LODY_CLI_DROP_FILE_TOKEN', '1');
    keystore.mismatch = true;

    await saveCliCredentials({ token: 'legacy-token', user, machine });

    expect(readFileRecord().token).toBe('legacy-token');
    expect(loadCliCredentials()?.token).toBe('legacy-token');
    expect(logs.warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'did not return the CLI login token'
    );
  });

  it('keeps serving the file token when the keystore cannot be read', () => {
    writeLegacyFile({ version: 3, token: 'legacy-token', user, machine });
    keystore.failRead = true;

    expect(loadCliCredentials()?.token).toBe('legacy-token');
    expect(loadCliCredentials()?.token).toBe('legacy-token');
    expect(logs.warn).toHaveBeenCalledTimes(1);
  });

  it('still has the file token while a verified copy is being published', async () => {
    vi.stubEnv('LODY_CLI_DROP_FILE_TOKEN', '1');
    const seen: string[] = [];
    setCliCredentialMigrationHookForTests(() => {
      seen.push(String(readFileRecord().token));
      expect(loadCliCredentials()?.token).toBe('published-token');
    });

    await saveCliCredentials({ token: 'published-token', user, machine });

    expect(seen).toEqual(['published-token']);
    expect(readFileRecord().token).toBeUndefined();
    expect(loadCliCredentials()?.token).toBe('published-token');
    expect(keystore.value).toBe('published-token');
  });

  it('does not remove a newer file token written during the copy', async () => {
    vi.stubEnv('LODY_CLI_DROP_FILE_TOKEN', '1');
    setCliCredentialMigrationHookForTests(() => {
      writeLegacyFile({ version: 3, token: 'newer-token', user, machine });
      expect(loadCliCredentials()?.token).toBe('newer-token');
    });

    await saveCliCredentials({ token: 'original-token', user, machine });

    expect(readFileRecord().token).toBe('newer-token');
    expect(loadCliCredentials()?.token).toBe('newer-token');
    expect(keystore.value).toBe('newer-token');
  });
});

describe('CLI credential logout', () => {
  it('clears the keystore and the credentials file', async () => {
    await saveCliCredentials({ token: 'logout-token', user, machine });
    const authClient = new AuthClient({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      setLevel: vi.fn(),
      setDebug: vi.fn(),
      child: vi.fn(),
      close: vi.fn(async () => {}),
    });

    expect(authClient.logout()).toEqual({ success: true, user });
    expect(fs.existsSync(credentialFile())).toBe(false);
    expect(keystore.value).toBeNull();
    expect(keystore.removed).toBe(1);
    expect(authClient.getAuthInfo()).toBeNull();
  });

  it('reports failure when the keystore entry cannot be removed', async () => {
    await saveCliCredentials({ token: 'logout-token', user, machine });
    keystore.failRemove = true;

    expect(clearCliCredentials()).toEqual({
      ok: false,
      error: 'Failed to clear authentication state',
    });
    expect(fs.existsSync(credentialFile())).toBe(false);
    expect(keystore.removed).toBe(1);
    expect(keystore.value).toBe('logout-token');
  });

  it('clears only the credential that is still current', async () => {
    const authClient = new AuthClient({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      setLevel: vi.fn(),
      setDebug: vi.fn(),
      child: vi.fn(),
      close: vi.fn(async () => {}),
    });
    await saveCliCredentials({ token: 'new-token', user, machine });

    expect(authClient.clearRejectedToken('old-token')).toBe('not_current');
    expect(fs.existsSync(credentialFile())).toBe(true);
    expect(keystore.value).toBe('new-token');

    expect(authClient.clearRejectedToken('new-token')).toBe('cleared');
    expect(fs.existsSync(credentialFile())).toBe(false);
    expect(keystore.value).toBeNull();
  });
});

describe('CLI credential file permissions', () => {
  it.skipIf(!posix)(
    'creates the data directory as 0700 and the credentials file as 0600',
    async () => {
      await saveCliCredentials({ token: 'mode-token', user, machine });

      expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(credentialFile()).mode & 0o777).toBe(0o600);
    }
  );

  it.skipIf(!posix)('tightens an existing credentials file on read', () => {
    writeLegacyFile({ version: 3, token: 'loose-token', user, machine }, 0o644);
    expect(fs.statSync(credentialFile()).mode & 0o777).toBe(0o644);

    expect(loadCliCredentials()?.token).toBe('loose-token');
    expect(fs.statSync(credentialFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
  });

  it('reports a permissions failure and still returns the saved token', async () => {
    setCliCredentialPlatformForTests('linux');
    setCliCredentialChmodForTests(() => {
      throw new Error('chmod denied');
    });

    await saveCliCredentials({ token: 'still-saved', user, machine });

    expect(loadCliCredentials()?.token).toBe('still-saved');
    expect(
      logs.warn.mock.calls
        .map((call) => String(call[0]))
        .some((message) => message.includes('chmod denied'))
    ).toBe(true);
  });

  it('reports a Windows ACL failure without dropping the saved token', async () => {
    setCliCredentialPlatformForTests('win32');
    setCliCredentialWindowsRestrictForTests(() => {
      throw new Error('icacls denied');
    });

    await saveCliCredentials({ token: 'windows-token', user, machine });

    expect(loadCliCredentials()?.token).toBe('windows-token');
    expect(
      logs.warn.mock.calls
        .map((call) => String(call[0]))
        .some(
          (message) => message.includes('icacls denied') && message.includes('credentials file')
        )
    ).toBe(true);
  });
});

describe('OS credential store availability', () => {
  it('treats a Linux session without a Secret Service bus as unavailable', () => {
    const exists = vi.fn(() => false);
    expect(
      linuxSecretServiceLooksAvailable({
        env: {},
        pathExists: exists,
        uid: 1000,
      })
    ).toBe(false);
    expect(
      linuxSecretServiceLooksAvailable({
        env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
        pathExists: exists,
        uid: 1000,
      })
    ).toBe(true);
    expect(
      linuxSecretServiceLooksAvailable({
        env: { XDG_RUNTIME_DIR: '/run/user/1000' },
        pathExists: (candidate) => candidate === '/run/user/1000/bus',
        uid: 1000,
      })
    ).toBe(true);
  });

  it('does not open the native store when Linux Secret Service is missing', () => {
    const entryFactory = vi.fn<(target: string) => KeyringEntry>();
    const store = createSystemCliTokenKeystore({
      platform: 'linux',
      env: {},
      pathExists: () => false,
      uid: 1000,
      dataDir,
      entryFactory,
    });

    expect(() => store.write('token')).toThrow(KeystoreUnavailableError);
    expect(store.read()).toBeNull();

    const fresh = createSystemCliTokenKeystore({
      platform: 'linux',
      env: {},
      pathExists: () => false,
      uid: 1000,
      dataDir,
      entryFactory,
    });
    expect(() => fresh.read()).toThrow(KeystoreUnavailableError);
    expect(fresh.read()).toBeNull();
    expect(() => fresh.remove()).not.toThrow();
    expect(entryFactory).not.toHaveBeenCalled();
  });

  it('pins Linux entries to Secret Service and isolates each data directory', () => {
    const identity = cliTokenKeyringIdentity(dataDir);
    const other = cliTokenKeyringIdentity(path.join(dataDir, 'other-install'));
    expect(identity.service).toBe('Lody CLI');
    expect(identity.username.startsWith('cloud-token.')).toBe(true);
    expect(identity.options).toEqual({ linux: { store: 'secret-service' } });
    expect(identity.username).not.toBe(other.username);
    expect(cliTokenKeyringIdentity(`${dataDir}${path.sep}`)).toEqual(identity);
    expect(identity).not.toHaveProperty('target');

    const entry: KeyringEntry = {
      getPassword: () => 'stored-token',
      setPassword: vi.fn(),
      deleteCredential: vi.fn(() => true),
    };
    const entryFactory = vi.fn<(target: string) => KeyringEntry>(() => entry);
    const store = createSystemCliTokenKeystore({
      platform: 'linux',
      env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
      dataDir,
      entryFactory,
    });

    expect(store.read()).toBe('stored-token');
    store.write('stored-token');
    store.remove();
    expect(entryFactory).toHaveBeenCalledWith(dataDir);
    expect(entry.setPassword).toHaveBeenCalledWith('stored-token');
    expect(entry.deleteCredential).toHaveBeenCalledOnce();
  });

  it('stops calling a store that has already failed', () => {
    const entryFactory = vi.fn<(target: string) => KeyringEntry>(() => {
      throw new Error('locked');
    });
    const store = createSystemCliTokenKeystore({
      platform: 'darwin',
      dataDir,
      entryFactory,
    });

    expect(() => store.read()).toThrow(/locked/);
    expect(store.read()).toBeNull();
    expect(entryFactory).toHaveBeenCalledTimes(1);
  });

  it('reads a password from a newly constructed entry', () => {
    const secrets = new Map<string, string>();
    class PlainEntry {
      private readonly key: string;
      constructor(
        service: string,
        username: string,
        options?: { linux: { store: 'secret-service' } }
      ) {
        expect(options).toEqual({ linux: { store: 'secret-service' } });
        this.key = `${service}\0${username}`;
      }
      getPassword(): string | null {
        return secrets.get(this.key) ?? null;
      }
      setPassword(password: string): void {
        secrets.set(this.key, password);
      }
      deleteCredential(): boolean {
        return secrets.delete(this.key);
      }
    }

    const saved = openCliTokenKeyringEntry({ Entry: PlainEntry }, dataDir);
    saved.setPassword('kept-token');
    expect(openCliTokenKeyringEntry({ Entry: PlainEntry }, dataDir).getPassword()).toBe(
      'kept-token'
    );
    expect(
      openCliTokenKeyringEntry(
        { Entry: PlainEntry },
        path.join(dataDir, 'other-install')
      ).getPassword()
    ).toBeNull();
  });

  it('loses a password when construction writes an empty secret', () => {
    const secrets = new Map<string, string>();
    const keyFor = (service: string, username: string) => `${service}\0${username}`;
    class TargetedEntry {
      static withTarget(_target: string, service: string, username: string): TargetedEntry {
        secrets.set(keyFor(service, username), '');
        return new TargetedEntry(service, username);
      }
      constructor(
        private readonly service: string,
        private readonly username: string
      ) {}
      getPassword(): string | null {
        const value = secrets.get(keyFor(this.service, this.username));
        return value && value.length > 0 ? value : null;
      }
      setPassword(password: string): void {
        secrets.set(keyFor(this.service, this.username), password);
      }
      deleteCredential(): boolean {
        return secrets.delete(keyFor(this.service, this.username));
      }
    }

    const identity = cliTokenKeyringIdentity(dataDir);
    const written = TargetedEntry.withTarget(dataDir, identity.service, identity.username);
    written.setPassword('wiped-token');
    expect(
      TargetedEntry.withTarget(dataDir, identity.service, identity.username).getPassword()
    ).toBeNull();
  });
});
