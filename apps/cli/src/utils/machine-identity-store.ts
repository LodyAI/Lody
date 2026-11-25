import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MachineId } from '@lody/shared';
import { getInstallationProfile } from '@lody/shared/node/installation-profile';
import { runCommandTextSyncLegacy } from '@lody/shared/node/process';
import { z } from 'zod';
import { writePrivateCredentialFile } from '@/lib/private-credential-file';

const MACHINE_IDENTITY_ANCHOR_FILE = 'machine-identity.json';
const HARDWARE_COMMAND_TIMEOUT_MS = 1_500;
const LINUX_CONTAINER_MARKERS = ['/.dockerenv', '/run/.containerenv'] as const;
const LINUX_MACHINE_ID_PATHS = ['/etc/machine-id', '/var/lib/dbus/machine-id'] as const;

const MachineIdentityAnchorSchema = z.object({
  version: z.literal(1),
  machineId: z.string().trim().min(1),
  hostFingerprintHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export type MachineIdentityAnchor = z.infer<typeof MachineIdentityAnchorSchema>;

export interface MachineIdentityStoreOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  namespace?: 'lody' | 'lody-oss';
  userIdentity?: string;
  readFile?: (filePath: string) => string | null;
  exists?: (filePath: string) => boolean;
  runCommand?: (command: string, args: readonly string[]) => string | null;
}

export interface SyncMachineIdentityAnchorOptions extends MachineIdentityStoreOptions {
  forceRefreshFingerprint?: boolean;
}

export interface RecoveredMachineId {
  machineId: MachineId;
  source: 'anchor' | 'hardware';
}

let cachedDefaultHardwareId: { resolved: true; value: string | null } | null = null;

export function resetHostHardwareIdCacheForTests(): void {
  cachedDefaultHardwareId = null;
}

export function isCustomLodyDataDir(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.LODY_DATA_DIR?.trim());
}

export function getMachineIdentityAnchorPath(options: MachineIdentityStoreOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const namespace = options.namespace ?? getInstallationProfile().namespace;

  if (platform === 'win32') {
    const base = env.LOCALAPPDATA?.trim() || path.join(homeDir, 'AppData', 'Local');
    return path.join(base, namespace, MACHINE_IDENTITY_ANCHOR_FILE);
  }

  const base = env.XDG_STATE_HOME?.trim() || path.join(homeDir, '.local', 'state');
  return path.join(base, namespace, MACHINE_IDENTITY_ANCHOR_FILE);
}

function normalizeHardwareId(raw: string | null): string | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  const stripped = normalized.replace(/-/g, '');
  if (!stripped || /^0+$/.test(stripped)) return null;
  return normalized;
}

export function parseMacOsPlatformUuid(output: string): string | null {
  const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  return normalizeHardwareId(match?.[1] ?? null);
}

export function parseWindowsMachineGuid(output: string): string | null {
  const match = output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
  return normalizeHardwareId(match?.[1] ?? null);
}

function defaultReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function defaultExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function defaultRunCommand(command: string, args: readonly string[]): string | null {
  try {
    return runCommandTextSyncLegacy({
      command,
      args,
      timeout: HARDWARE_COMMAND_TIMEOUT_MS,
      check: 'exit-0',
    }).stdout;
  } catch {
    return null;
  }
}

function canUseDefaultHardwareCache(options: MachineIdentityStoreOptions): boolean {
  return (
    options.platform === undefined &&
    options.readFile === undefined &&
    options.exists === undefined &&
    options.runCommand === undefined
  );
}

export function readHostHardwareId(options: MachineIdentityStoreOptions = {}): string | null {
  const useCache = canUseDefaultHardwareCache(options);
  if (useCache && cachedDefaultHardwareId) {
    return cachedDefaultHardwareId.value;
  }

  const platform = options.platform ?? process.platform;
  const readFile = options.readFile ?? defaultReadFile;
  const exists = options.exists ?? defaultExists;
  const runCommand = options.runCommand ?? defaultRunCommand;

  let hardwareId: string | null = null;
  if (platform === 'darwin') {
    const output = runCommand('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    hardwareId = output ? parseMacOsPlatformUuid(output) : null;
  } else if (platform === 'win32') {
    const output = runCommand('reg', [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
      '/v',
      'MachineGuid',
    ]);
    hardwareId = output ? parseWindowsMachineGuid(output) : null;
  } else if (platform === 'linux') {
    // Cloned container images often share `/etc/machine-id`; avoid collapsing distinct containers.
    const inContainer = LINUX_CONTAINER_MARKERS.some((marker) => exists(marker));
    if (!inContainer) {
      for (const idPath of LINUX_MACHINE_ID_PATHS) {
        const parsed = normalizeHardwareId(readFile(idPath));
        if (parsed) {
          hardwareId = parsed;
          break;
        }
      }
    }
  }

  if (useCache) {
    cachedDefaultHardwareId = { resolved: true, value: hardwareId };
  }
  return hardwareId;
}

export function computeHostFingerprintHash(
  platform: NodeJS.Platform,
  rawHardwareId: string
): string {
  return crypto
    .createHash('sha256')
    .update(`lody:host-fingerprint:v1:${platform}:${rawHardwareId}`)
    .digest('hex');
}

function resolveUserIdentity(options: MachineIdentityStoreOptions): string {
  if (options.userIdentity !== undefined) {
    return options.userIdentity.trim().toLowerCase();
  }
  try {
    const username = os.userInfo().username.trim();
    if (username) return username.toLowerCase();
  } catch {
    // Fall back to environment or home directory when passwd lookup is unavailable.
  }
  const env = options.env ?? process.env;
  const fallback = env.USER?.trim() || env.USERNAME?.trim() || options.homeDir || os.homedir();
  return fallback.trim().toLowerCase();
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

export function readMachineIdentityAnchor(
  options: MachineIdentityStoreOptions = {}
): MachineIdentityAnchor | null {
  try {
    const anchorPath = getMachineIdentityAnchorPath(options);
    const raw = fs.readFileSync(anchorPath, 'utf8');
    const parsed = MachineIdentityAnchorSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function syncMachineIdentityAnchor(
  machineId: string,
  options: SyncMachineIdentityAnchorOptions = {}
): boolean {
  const trimmed = machineId.trim();
  if (!trimmed) return false;

  try {
    const existing = readMachineIdentityAnchor(options);
    // Warm path: skip spawning OS hardware probes when the anchor already tracks this ID.
    if (existing && existing.machineId === trimmed && !options.forceRefreshFingerprint) {
      return true;
    }

    const platform = options.platform ?? process.platform;
    const rawHardwareId = readHostHardwareId(options);
    if (!rawHardwareId) return false;

    const hostFingerprintHash = computeHostFingerprintHash(platform, rawHardwareId);
    if (
      existing &&
      existing.machineId === trimmed &&
      existing.hostFingerprintHash === hostFingerprintHash
    ) {
      return true;
    }

    const anchorPath = getMachineIdentityAnchorPath(options);
    fs.mkdirSync(path.dirname(anchorPath), { recursive: true, mode: 0o700 });
    const payload: MachineIdentityAnchor = {
      version: 1,
      machineId: trimmed,
      hostFingerprintHash,
    };
    writePrivateCredentialFile(anchorPath, JSON.stringify(payload, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function recoverMachineIdFromAnchorOrHardware(
  options: MachineIdentityStoreOptions = {}
): RecoveredMachineId | null {
  const platform = options.platform ?? process.platform;
  const rawHardwareId = readHostHardwareId(options);
  if (!rawHardwareId) return null;

  const hostFingerprintHash = computeHostFingerprintHash(platform, rawHardwareId);
  const anchor = readMachineIdentityAnchor(options);
  if (anchor && anchor.hostFingerprintHash === hostFingerprintHash) {
    return {
      machineId: anchor.machineId as MachineId,
      source: 'anchor',
    };
  }

  const namespace = options.namespace ?? getInstallationProfile().namespace;
  const userIdentity = resolveUserIdentity(options);
  return {
    machineId: deriveDeterministicMachineId({
      namespace,
      userIdentity,
      rawHardwareId,
    }),
    source: 'hardware',
  };
}
