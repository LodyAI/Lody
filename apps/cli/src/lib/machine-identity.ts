import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MachineId } from '@lody/shared';
import { getInstallationProfile, getLodyDataDir } from '@lody/shared/node/installation-profile';
import { runCommandTextSyncLegacy } from '@lody/shared/node/process';
import { z } from 'zod';
import { MachineIdSchema, readCredentialsFile } from './credentials-file';
import { writePrivateCredentialFile } from './private-credential-file';

const MACHINE_ID_FILE_NAME = 'machine-id';
const MACHINE_IDENTITY_ANCHOR_FILE = 'machine-identity.json';
const HARDWARE_COMMAND_TIMEOUT_MS = 1_500;
const MACHINE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_MACHINE_ID_LENGTH = 128;
const LINUX_CONTAINER_MARKERS = ['/.dockerenv', '/run/.containerenv'] as const;
const LINUX_MACHINE_ID_PATHS = ['/etc/machine-id', '/var/lib/dbus/machine-id'] as const;

type RawHardwareId = string & { readonly __brand: 'RawHardwareId' };
type HostFingerprintHash = string & { readonly __brand: 'HostFingerprintHash' };

export type HardwareProbeResult =
  | { kind: 'ok'; id: string }
  | { kind: 'unavailable' }
  | { kind: 'transient_error' };

export type AnchorSyncStatus = 'unchanged' | 'updated' | 'skipped';

type CachedHardwareProbe = { kind: 'ok'; id: RawHardwareId } | { kind: 'unavailable' };

const MachineIdentityAnchorSchema = z.object({
  version: z.literal(1),
  machineId: MachineIdSchema,
  hostFingerprintHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .transform((value) => value as HostFingerprintHash),
});

type MachineIdentityAnchor = z.infer<typeof MachineIdentityAnchorSchema>;

export function parseMachineId(input: string): MachineId {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_MACHINE_ID_LENGTH || !MACHINE_ID_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid machine ID "${input}". Expected 1-${MAX_MACHINE_ID_LENGTH} characters matching [A-Za-z0-9._:-].`
    );
  }
  return trimmed as MachineId;
}

export function getMachineIdFilePath(dataDir: string = getLodyDataDir()): string {
  return path.join(dataDir, MACHINE_ID_FILE_NAME);
}

export function isDefaultLodyDataDir(dataDir: string = getLodyDataDir()): boolean {
  return (
    !process.env.LODY_DATA_DIR?.trim() && path.resolve(dataDir) === path.resolve(getLodyDataDir())
  );
}

function normalizeHardwareId(raw: string | null): RawHardwareId | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized === 'uninitialized') return null;
  const stripped = normalized.replace(/-/g, '');
  if (!stripped || /^0+$/.test(stripped)) return null;
  return normalized as RawHardwareId;
}

export function parseMacOsPlatformUuid(output: string): string | null {
  const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  return normalizeHardwareId(match?.[1] ?? null);
}

export function parseWindowsMachineGuid(output: string): string | null {
  const match = output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
  return normalizeHardwareId(match?.[1] ?? null);
}

export function resolveLinuxMachineId(
  readFile: (filePath: string) => string | null,
  exists: (filePath: string) => boolean
): string | null {
  // Cloned container images often share `/etc/machine-id`; avoid collapsing distinct containers.
  if (LINUX_CONTAINER_MARKERS.some((marker) => exists(marker))) {
    return null;
  }
  for (const idPath of LINUX_MACHINE_ID_PATHS) {
    const parsed = normalizeHardwareId(readFile(idPath));
    if (parsed) return parsed;
  }
  return null;
}

export function deriveDeterministicMachineId(input: {
  namespace: string;
  userIdentity: string;
  rawHardwareId: string;
}): MachineId {
  const digest = crypto
    .createHmac('sha256', input.rawHardwareId)
    .update(`lody:machine-id:v1:${input.namespace}:${input.userIdentity}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` as MachineId;
}

function readOptionalFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function pathExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function probeOsHardwareId(platform: NodeJS.Platform): HardwareProbeResult {
  if (platform === 'darwin') {
    try {
      const { stdout } = runCommandTextSyncLegacy({
        command: '/usr/sbin/ioreg',
        args: ['-rd1', '-c', 'IOPlatformExpertDevice'],
        timeout: HARDWARE_COMMAND_TIMEOUT_MS,
        check: 'exit-0',
      });
      const id = parseMacOsPlatformUuid(stdout);
      return id ? { kind: 'ok', id } : { kind: 'unavailable' };
    } catch {
      return { kind: 'transient_error' };
    }
  }

  if (platform === 'win32') {
    try {
      const { stdout } = runCommandTextSyncLegacy({
        command: 'reg',
        args: ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        timeout: HARDWARE_COMMAND_TIMEOUT_MS,
        check: 'exit-0',
      });
      const id = parseWindowsMachineGuid(stdout);
      return id ? { kind: 'ok', id } : { kind: 'unavailable' };
    } catch {
      return { kind: 'transient_error' };
    }
  }

  if (platform === 'linux') {
    const id = resolveLinuxMachineId(readOptionalFile, pathExists);
    return id ? { kind: 'ok', id } : { kind: 'unavailable' };
  }

  return { kind: 'unavailable' };
}

function computeHostFingerprintHash(
  platform: NodeJS.Platform,
  rawHardwareId: RawHardwareId
): HostFingerprintHash {
  return crypto
    .createHash('sha256')
    .update(`lody:host-fingerprint:v1:${platform}:${rawHardwareId}`)
    .digest('hex') as HostFingerprintHash;
}

function resolveUserIdentity(explicit?: string): string {
  if (explicit !== undefined) return explicit.trim().toLowerCase();
  try {
    const username = os.userInfo().username.trim();
    if (username) return username.toLowerCase();
  } catch {}
  const fallback = process.env.USER?.trim() || process.env.USERNAME?.trim() || os.homedir();
  return fallback.trim().toLowerCase();
}

function getAnchorFilePath(platform: NodeJS.Platform): string {
  const homeDir = os.homedir();
  const namespace = getInstallationProfile().namespace;
  if (platform === 'win32') {
    const base = process.env.LOCALAPPDATA?.trim() || path.join(homeDir, 'AppData', 'Local');
    return path.join(base, namespace, MACHINE_IDENTITY_ANCHOR_FILE);
  }
  const base = process.env.XDG_STATE_HOME?.trim() || path.join(homeDir, '.local', 'state');
  return path.join(base, namespace, MACHINE_IDENTITY_ANCHOR_FILE);
}

function readPersistedMachineId(dataDir: string = getLodyDataDir()): MachineId | null {
  try {
    const id = fs.readFileSync(getMachineIdFilePath(dataDir), 'utf8').trim();
    return id ? (id as MachineId) : null;
  } catch {
    return null;
  }
}

function createMachineIdFile(candidate: MachineId, dataDir: string): MachineId {
  const machineIdPath = getMachineIdFilePath(dataDir);
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') {
      fs.writeFileSync(machineIdPath, candidate, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return candidate;
    }
    // Publish via temp file + hard link so a crash mid-write never leaves a 0-byte `machine-id`.
    const temporary = `${machineIdPath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      try {
        fs.writeFileSync(descriptor, candidate, 'utf8');
      } finally {
        fs.closeSync(descriptor);
      }
      fs.linkSync(temporary, machineIdPath);
      return candidate;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  } catch {
    // Another CLI may win first creation. Re-read so every concurrent process uses its value.
    const existing = readPersistedMachineId(dataDir);
    if (existing) return existing;
    // Repair a pre-existing 0-byte or whitespace-only `machine-id` file instead of drifting per run.
    try {
      writePrivateCredentialFile(machineIdPath, candidate);
    } catch {}
    return readPersistedMachineId(dataDir) ?? candidate;
  }
}

/** Read-only lookup for telemetry/analytics: never creates files or spawns OS probes. */
export function readExistingMachineId(dataDir: string = getLodyDataDir()): MachineId | null {
  return readCredentialsFile(dataDir)?.machine.machineId ?? readPersistedMachineId(dataDir);
}

export interface MachineIdentityStore {
  getSystemMachineId(): MachineId | null;
  getOrCreateMachineId(): MachineId;
  persistMachineId(
    machineId: MachineId,
    options?: { dataDir?: string; forceRefreshAnchor?: boolean }
  ): { machineId: MachineId; anchorStatus: AnchorSyncStatus };
  readAnchorMachineId(): MachineId | null;
}

export function createMachineIdentityStore(
  options: {
    platform?: NodeJS.Platform;
    userIdentity?: string;
    probeHardware?: () => HardwareProbeResult;
  } = {}
): MachineIdentityStore {
  const platform = options.platform ?? process.platform;
  const probeHardware = options.probeHardware ?? (() => probeOsHardwareId(platform));
  let cachedProbe: CachedHardwareProbe | null = null;

  function resolveHardwareId(): RawHardwareId | null {
    if (cachedProbe) {
      return cachedProbe.kind === 'ok' ? cachedProbe.id : null;
    }
    const result = probeHardware();
    if (result.kind === 'ok') {
      const normalized = normalizeHardwareId(result.id);
      if (normalized) {
        cachedProbe = { kind: 'ok', id: normalized };
        return normalized;
      }
      cachedProbe = { kind: 'unavailable' };
      return null;
    }
    // Transient probe failures (e.g. ioreg/reg timeout under boot load) are never cached.
    if (result.kind === 'unavailable') {
      cachedProbe = { kind: 'unavailable' };
    }
    return null;
  }

  function readAnchor(): MachineIdentityAnchor | null {
    try {
      const raw = fs.readFileSync(getAnchorFilePath(platform), 'utf8');
      const parsed = MachineIdentityAnchorSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  function syncAnchor(machineId: MachineId, forceRefreshFingerprint = false): AnchorSyncStatus {
    try {
      const existing = readAnchor();
      // Warm path: skip spawning OS hardware probes when the anchor already tracks this ID.
      if (existing && existing.machineId === machineId && !forceRefreshFingerprint) {
        return 'unchanged';
      }

      const rawHardwareId = resolveHardwareId();
      if (!rawHardwareId) return 'skipped';

      const hostFingerprintHash = computeHostFingerprintHash(platform, rawHardwareId);
      if (
        existing &&
        existing.machineId === machineId &&
        existing.hostFingerprintHash === hostFingerprintHash
      ) {
        return 'unchanged';
      }

      const anchorPath = getAnchorFilePath(platform);
      fs.mkdirSync(path.dirname(anchorPath), { recursive: true, mode: 0o700 });
      const payload: MachineIdentityAnchor = {
        version: 1,
        machineId,
        hostFingerprintHash,
      };
      writePrivateCredentialFile(anchorPath, JSON.stringify(payload, null, 2));
      return 'updated';
    } catch {
      return 'skipped';
    }
  }

  function recoverFromAnchorOrHardware(): MachineId | null {
    const rawHardwareId = resolveHardwareId();
    if (!rawHardwareId) return null;

    const hostFingerprintHash = computeHostFingerprintHash(platform, rawHardwareId);
    const anchor = readAnchor();
    if (anchor && anchor.hostFingerprintHash === hostFingerprintHash) {
      return anchor.machineId;
    }

    return deriveDeterministicMachineId({
      namespace: getInstallationProfile().namespace,
      userIdentity: resolveUserIdentity(options.userIdentity),
      rawHardwareId,
    });
  }

  function persistMachineId(
    machineId: MachineId,
    persistOptions: { dataDir?: string; forceRefreshAnchor?: boolean } = {}
  ): { machineId: MachineId; anchorStatus: AnchorSyncStatus } {
    const dataDir = persistOptions.dataDir ?? getLodyDataDir();
    const trimmed = machineId.trim() as MachineId;
    if (!trimmed) {
      return {
        machineId: readPersistedMachineId(dataDir) ?? machineId,
        anchorStatus: 'skipped',
      };
    }

    try {
      if (readPersistedMachineId(dataDir) !== trimmed) {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        writePrivateCredentialFile(getMachineIdFilePath(dataDir), trimmed);
      }
      const anchorStatus = isDefaultLodyDataDir(dataDir)
        ? syncAnchor(trimmed, persistOptions.forceRefreshAnchor === true)
        : 'skipped';
      return { machineId: trimmed, anchorStatus };
    } catch {
      return {
        machineId: readPersistedMachineId(dataDir) ?? trimmed,
        anchorStatus: 'skipped',
      };
    }
  }

  function getSystemMachineId(): MachineId | null {
    try {
      const dataDir = getLodyDataDir();
      const persisted = readPersistedMachineId(dataDir);
      const credentialMachineId = readCredentialsFile(dataDir)?.machine.machineId ?? null;
      // Cached auth is already the runtime's machine identity. Keep telemetry and future pairing
      // aligned with it, including when a buggy release created a conflicting UUID first.
      if (credentialMachineId) {
        if (credentialMachineId !== persisted) {
          return persistMachineId(credentialMachineId, { dataDir }).machineId;
        }
        if (isDefaultLodyDataDir(dataDir)) {
          syncAnchor(credentialMachineId);
        }
        return credentialMachineId;
      }
      if (persisted) {
        if (isDefaultLodyDataDir(dataDir)) {
          syncAnchor(persisted);
        }
        return persisted;
      }

      const candidate = isDefaultLodyDataDir(dataDir)
        ? (recoverFromAnchorOrHardware() ?? (crypto.randomUUID() as MachineId))
        : (crypto.randomUUID() as MachineId);
      const created = createMachineIdFile(candidate, dataDir);
      if (isDefaultLodyDataDir(dataDir)) {
        syncAnchor(created);
      }
      return created;
    } catch {
      return null;
    }
  }

  function getOrCreateMachineId(): MachineId {
    return (
      getSystemMachineId() ??
      createMachineIdFile(crypto.randomUUID() as MachineId, getLodyDataDir())
    );
  }

  function readAnchorMachineId(): MachineId | null {
    return readAnchor()?.machineId ?? null;
  }

  return {
    getSystemMachineId,
    getOrCreateMachineId,
    persistMachineId,
    readAnchorMachineId,
  };
}

const defaultStore = createMachineIdentityStore();

export const getSystemMachineId: MachineIdentityStore['getSystemMachineId'] = () =>
  defaultStore.getSystemMachineId();

export const getOrCreateMachineId: MachineIdentityStore['getOrCreateMachineId'] = () =>
  defaultStore.getOrCreateMachineId();

export const persistMachineId: MachineIdentityStore['persistMachineId'] = (machineId, options) =>
  defaultStore.persistMachineId(machineId, options);

export const readAnchorMachineId: MachineIdentityStore['readAnchorMachineId'] = () =>
  defaultStore.readAnchorMachineId();
