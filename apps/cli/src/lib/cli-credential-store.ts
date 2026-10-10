import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCommandTextSyncLegacy } from '@lody/shared/node/process';
import { z } from 'zod';
import { getConfigPath } from '@/utils';
import { getLogger, type Logger } from '@/utils/logger';
import {
  cliTokenKeyringIdentity,
  type CliTokenKeyringIdentity,
} from './cli-credential-keyring-identity';

/**
 * CLI cloud login persistence.
 *
 * The access token is copied into the OS credential store (macOS Keychain,
 * Windows Credential Manager, Linux Secret Service) when that store can be
 * opened. Profile and machine id stay in `credentials.json`. The file keeps
 * the token as well unless `LODY_CLI_DROP_FILE_TOKEN=1`, so an older CLI that
 * only reads the file still finds it. `LODY_ELECTRON_SESSION_TOKEN` is not
 * read here; startup exchanges that session through the existing bootstrap.
 */

const SECRET_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

const StoredUserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

const StoredMachineSchema = z
  .object({
    machineName: z.string(),
    machineId: z.string(),
  })
  .passthrough();

const StoredCredentialSchema = z
  .object({
    version: z.literal(3),
    token: z.string().optional(),
    user: StoredUserSchema,
    machine: StoredMachineSchema,
    createdAt: z.string().optional(),
  })
  .passthrough();

export type StoredCredential = z.infer<typeof StoredCredentialSchema>;

export type LoadedCliCredential = {
  token: string;
  user: z.infer<typeof StoredUserSchema>;
  machine: z.infer<typeof StoredMachineSchema>;
};

export interface CliTokenKeystore {
  /** The stored token, or null when the entry is empty. Throws when the store cannot be read. */
  read(): string | null;
  write(token: string): void;
  /** Removes the entry. Throws only when an existing entry could not be removed. */
  remove(): void;
}

export class KeystoreUnavailableError extends Error {
  readonly silent: boolean;

  constructor(message: string, silent = false) {
    super(message);
    this.name = 'KeystoreUnavailableError';
    this.silent = silent;
  }
}

export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deleteCredential(): boolean;
}

export { cliTokenKeyringIdentity, type CliTokenKeyringIdentity };

export function linuxSecretServiceLooksAvailable(input: {
  env: NodeJS.ProcessEnv;
  pathExists: (candidate: string) => boolean;
  uid: number | undefined;
}): boolean {
  if (input.env.DBUS_SESSION_BUS_ADDRESS?.trim()) return true;
  const runtimeDir = input.env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir && input.pathExists(path.join(runtimeDir, 'bus'))) return true;
  if (input.uid !== undefined && input.pathExists(`/run/user/${input.uid}/bus`)) return true;
  return false;
}

export function cliCredentialFileTokenRemovalEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const value = (env.LODY_CLI_DROP_FILE_TOKEN ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asCallable(value: unknown, label: string): (...args: unknown[]) => unknown {
  if (typeof value !== 'function') {
    throw new KeystoreUnavailableError(`OS credential store binding is missing ${label}`);
  }
  return value as (...args: unknown[]) => unknown;
}

function tokenOf(record: StoredCredential): string | null {
  const token = record.token?.trim();
  return token ? token : null;
}

function withoutToken(record: StoredCredential): StoredCredential {
  const { token: _token, ...rest } = record;
  const parsed = StoredCredentialSchema.safeParse(rest);
  if (!parsed.success) {
    throw new Error('Credential profile is missing required fields');
  }
  return parsed.data;
}

const warned = new Set<string>();
let keystoreOverride: CliTokenKeystore | null = null;
let cachedKeystore: CliTokenKeystore | null = null;
let migrationHook: (() => void) | null = null;
let copying = false;
let keystoreCopyDisabled = false;
let chmodFile: (filePath: string, mode: number) => void = (filePath, mode) => {
  fs.chmodSync(filePath, mode);
};
let restrictWindowsFile: (filePath: string) => void = restrictWindowsCredentialFile;
let platformOverride: NodeJS.Platform | null = null;

function currentPlatform(): NodeJS.Platform {
  return platformOverride ?? process.platform;
}

function logger(): Pick<Logger, 'warn' | 'debug' | 'error'> {
  return getLogger('auth');
}

function reportOnce(level: 'warn' | 'debug', key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger()[level](message);
}

function noteKeystoreUnavailable(error: unknown): void {
  const silent = error instanceof KeystoreUnavailableError && error.silent;
  const detail = errorText(error);
  reportOnce(
    silent ? 'debug' : 'warn',
    silent ? 'keystore-disabled' : 'keystore-unavailable',
    silent
      ? `The OS credential store is disabled. The CLI login token remains in the credentials file. ${detail}`
      : `The OS credential store is unavailable. The CLI login token remains in the credentials file. ${detail}`
  );
}

function noteKeystoreMismatch(): void {
  reportOnce(
    'warn',
    'keystore-mismatch',
    'The OS credential store did not return the CLI login token. The credentials file was left unchanged.'
  );
}

export function createDisabledCliTokenKeystore(): CliTokenKeystore {
  return {
    read: () => null,
    write: () => {
      throw new KeystoreUnavailableError('OS credential store is disabled', true);
    },
    remove: () => {},
  };
}

export interface CliTokenKeyringBinding {
  Entry: new (
    service: string,
    username: string,
    options?: CliTokenKeyringIdentity['options']
  ) => {
    getPassword(): string | null;
    setPassword(password: string): void;
    deleteCredential(): boolean;
  };
}

/** Opens one entry with `new Entry(service, username)`. Construction does not write a password. */
export function openCliTokenKeyringEntry(
  binding: CliTokenKeyringBinding,
  dataDir: string
): KeyringEntry {
  const identity = cliTokenKeyringIdentity(dataDir);
  const created = new binding.Entry(identity.service, identity.username, identity.options);
  if (!isRecord(created)) {
    throw new KeystoreUnavailableError('OS credential store binding is unavailable');
  }
  const getPassword = asCallable(created.getPassword, 'getPassword').bind(created);
  const setPassword = asCallable(created.setPassword, 'setPassword').bind(created);
  const deleteCredential = asCallable(created.deleteCredential, 'deleteCredential').bind(created);
  return {
    getPassword: () => {
      const value = getPassword();
      return typeof value === 'string' ? value : null;
    },
    setPassword: (password: string) => {
      setPassword(password);
    },
    deleteCredential: () => deleteCredential() === true,
  };
}

function loadNativeKeyringEntry(dataDir: string): KeyringEntry {
  const require = createRequire(import.meta.url);
  const loaded: unknown = require('@napi-rs/keyring');
  if (typeof loaded !== 'object' || loaded === null || !('Entry' in loaded)) {
    throw new KeystoreUnavailableError('OS credential store binding is unavailable');
  }
  const Entry = loaded.Entry;
  if (typeof Entry !== 'function') {
    throw new KeystoreUnavailableError('OS credential store binding is unavailable');
  }
  return openCliTokenKeyringEntry({ Entry: Entry as CliTokenKeyringBinding['Entry'] }, dataDir);
}

export function createSystemCliTokenKeystore(options?: {
  dataDir?: string | (() => string);
  entryFactory?: (dataDir: string) => KeyringEntry;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathExists?: (candidate: string) => boolean;
  uid?: number | undefined;
}): CliTokenKeystore {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const pathExists = options?.pathExists ?? ((candidate) => fs.existsSync(candidate));
  const uid = options && 'uid' in options ? options.uid : process.getuid?.();
  const entryFactory = options?.entryFactory ?? loadNativeKeyringEntry;
  const resolveDataDir = (): string =>
    typeof options?.dataDir === 'function'
      ? options.dataDir()
      : (options?.dataDir ?? path.dirname(getConfigPath()));
  let failed = false;

  const secretServiceMissing = (): boolean =>
    platform === 'linux' &&
    !linuxSecretServiceLooksAvailable({
      env,
      pathExists,
      uid,
    });

  return {
    read() {
      if (failed) return null;
      if (secretServiceMissing()) {
        failed = true;
        throw new KeystoreUnavailableError('Linux Secret Service is not available');
      }
      try {
        const value = entryFactory(resolveDataDir()).getPassword();
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
      } catch (error) {
        failed = true;
        if (error instanceof KeystoreUnavailableError) throw error;
        throw new KeystoreUnavailableError(errorText(error));
      }
    },
    write(token: string) {
      if (failed) {
        throw new KeystoreUnavailableError('OS credential store is unavailable');
      }
      if (secretServiceMissing()) {
        failed = true;
        throw new KeystoreUnavailableError('Linux Secret Service is not available');
      }
      try {
        entryFactory(resolveDataDir()).setPassword(token);
      } catch (error) {
        failed = true;
        if (error instanceof KeystoreUnavailableError) throw error;
        throw new KeystoreUnavailableError(errorText(error));
      }
    },
    remove() {
      if (failed || secretServiceMissing()) {
        failed = true;
        return;
      }
      try {
        entryFactory(resolveDataDir()).deleteCredential();
      } catch (error) {
        failed = true;
        throw error;
      }
    },
  };
}

function activeKeystore(): CliTokenKeystore {
  if (keystoreOverride) return keystoreOverride;
  if (!cachedKeystore) {
    cachedKeystore =
      isTruthyEnv(process.env.LODY_CLI_DISABLE_KEYSTORE) || process.env.VITEST === 'true'
        ? createDisabledCliTokenKeystore()
        : createSystemCliTokenKeystore();
  }
  return cachedKeystore;
}

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (currentPlatform() === 'win32') return;
  try {
    chmodFile(dir, PRIVATE_DIR_MODE);
  } catch (error) {
    reportOnce(
      'warn',
      `dir-mode:${dir}`,
      `Could not restrict the CLI data directory to the current user (${dir}): ${errorText(error)}`
    );
  }
}

function restrictPublishedFile(filePath: string): void {
  if (currentPlatform() === 'win32') {
    try {
      restrictWindowsFile(filePath);
    } catch (error) {
      reportOnce(
        'warn',
        `file-acl:${filePath}`,
        `Could not restrict the CLI credentials file to the current user (${filePath}): ${errorText(error)}`
      );
    }
    return;
  }
  try {
    chmodFile(filePath, SECRET_FILE_MODE);
  } catch (error) {
    reportOnce(
      'warn',
      `file-mode:${filePath}`,
      `Could not restrict the CLI credentials file to the current user (${filePath}): ${errorText(error)}`
    );
  }
}

export function restrictWindowsCredentialFile(filePath: string): void {
  const username = os.userInfo().username.trim();
  if (!username) {
    throw new Error('Current user name is unavailable');
  }
  runCommandTextSyncLegacy({
    command: 'icacls',
    args: [filePath, '/inheritance:r', '/grant:r', `${username}:(R,W)`],
    timeout: 5_000,
    check: 'exit-0',
  });
}

function writeCredentialFile(filePath: string, record: StoredCredential): void {
  const dir = path.dirname(filePath);
  ensurePrivateDirectory(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, 'wx', SECRET_FILE_MODE);
    fs.writeFileSync(fd, JSON.stringify(record, null, 2));
    fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // The original write error is the one callers need.
      }
      fd = null;
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // The temporary file may not exist.
    }
    throw error;
  }
  if (fd !== null) {
    fs.closeSync(fd);
  }
  restrictPublishedFile(tmpPath);
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Preserve the rename failure.
    }
    throw error;
  }
  restrictPublishedFile(filePath);
}

function readCredentialFile(filePath: string): StoredCredential | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      logger().debug('Failed to load auth info from disk');
    }
    return null;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    logger().debug('Invalid credentials.json; please run `lody logout` + `lody login`');
    return null;
  }
  const parsed = StoredCredentialSchema.safeParse(parsedJson);
  if (!parsed.success) {
    logger().debug('Invalid credentials.json; please run `lody logout` + `lody login`');
    return null;
  }
  return parsed.data;
}

function tightenExistingCredentialFile(filePath: string): void {
  if (currentPlatform() === 'win32') return;
  let mode: number;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      reportOnce(
        'warn',
        `file-stat:${filePath}`,
        `Could not read permissions for the CLI credentials file (${filePath}): ${errorText(error)}`
      );
    }
    return;
  }
  if (mode === SECRET_FILE_MODE) return;
  restrictPublishedFile(filePath);
}

function readKeystoreToken(): string | null {
  try {
    return activeKeystore().read();
  } catch (error) {
    noteKeystoreUnavailable(error);
    return null;
  }
}

function copyTokenToKeystore(token: string): boolean {
  if (keystoreCopyDisabled) return false;
  try {
    activeKeystore().write(token);
    if (activeKeystore().read() === token) return true;
    noteKeystoreMismatch();
    return false;
  } catch (error) {
    keystoreCopyDisabled = true;
    noteKeystoreUnavailable(error);
    return false;
  }
}

function maybeCopyTokenToKeystore(token: string): void {
  if (copying) return;
  copying = true;
  try {
    if (!copyTokenToKeystore(token)) return;
    migrationHook?.();
    if (!cliCredentialFileTokenRemovalEnabled()) return;
    const filePath = getConfigPath();
    const latest = readCredentialFile(filePath);
    if (!latest || tokenOf(latest) !== token) return;
    writeCredentialFile(filePath, withoutToken(latest));
  } finally {
    copying = false;
  }
}

export async function saveCliCredentials(input: {
  token: string;
  user: { id: string; email: string; name?: string | null };
  machine: { machineName: string; machineId: string };
}): Promise<void> {
  const token = input.token.trim();
  if (!token) {
    throw new Error('Cannot save an empty CLI credential');
  }
  const record = StoredCredentialSchema.parse({
    version: 3,
    token,
    user: input.user,
    machine: input.machine,
    createdAt: new Date().toISOString(),
  });
  writeCredentialFile(getConfigPath(), record);
  maybeCopyTokenToKeystore(token);
}

export function loadCliCredentials(): LoadedCliCredential | null {
  const filePath = getConfigPath();
  try {
    ensurePrivateDirectory(path.dirname(filePath));
  } catch (error) {
    logger().debug(`Failed to prepare the CLI data directory: ${errorText(error)}`);
  }
  tightenExistingCredentialFile(filePath);
  const record = readCredentialFile(filePath);
  if (!record) return null;

  const fileToken = tokenOf(record);
  const keystoreToken = readKeystoreToken();
  if (fileToken) {
    if (keystoreToken !== fileToken || cliCredentialFileTokenRemovalEnabled()) {
      maybeCopyTokenToKeystore(fileToken);
    }
    return {
      token: fileToken,
      user: record.user,
      machine: record.machine,
    };
  }
  if (!keystoreToken) return null;
  return {
    token: keystoreToken,
    user: record.user,
    machine: record.machine,
  };
}

export function clearCliCredentials(): { ok: true } | { ok: false; error: string } {
  let keystoreFailed = false;
  try {
    activeKeystore().remove();
  } catch (error) {
    keystoreFailed = true;
    logger().warn(
      `Could not remove the CLI token from the OS credential store: ${errorText(error)}`
    );
  }

  try {
    fs.unlinkSync(getConfigPath());
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      logger().error('Failed to remove auth file', { error });
      return { ok: false, error: 'Failed to clear authentication state' };
    }
  }

  if (keystoreFailed) {
    return { ok: false, error: 'Failed to clear authentication state' };
  }
  return { ok: true };
}

export function setCliTokenKeystoreForTests(keystore: CliTokenKeystore | null): void {
  keystoreOverride = keystore;
  cachedKeystore = null;
}

export function setCliCredentialMigrationHookForTests(hook: (() => void) | null): void {
  migrationHook = hook;
}

export function setCliCredentialChmodForTests(
  chmod: ((filePath: string, mode: number) => void) | null
): void {
  chmodFile =
    chmod ??
    ((filePath, mode) => {
      fs.chmodSync(filePath, mode);
    });
}

export function setCliCredentialPlatformForTests(platform: NodeJS.Platform | null): void {
  platformOverride = platform;
}

export function setCliCredentialWindowsRestrictForTests(
  restrict: ((filePath: string) => void) | null
): void {
  restrictWindowsFile = restrict ?? restrictWindowsCredentialFile;
}

export function resetCliCredentialStoreForTests(): void {
  keystoreOverride = null;
  cachedKeystore = null;
  migrationHook = null;
  copying = false;
  keystoreCopyDisabled = false;
  platformOverride = null;
  warned.clear();
  chmodFile = (filePath, mode) => {
    fs.chmodSync(filePath, mode);
  };
  restrictWindowsFile = restrictWindowsCredentialFile;
}
