import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { MachineId } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { z } from 'zod';

export let LODY_AUTH_URL = process.env.LODY_AUTH_URL;
export let LODY_AUTH_SITE_URL = process.env.LODY_AUTH_SITE_URL;
export let LODY_SERVER_URL = process.env.LODY_SERVER_URL;
export let SITE_URL = process.env.SITE_URL ?? 'https://lody.ai';
export let SITE_APP_BASE_PATH = '';

export const loadEnv = () => {
  LODY_AUTH_URL = process.env['LODY_AUTH_URL'];
  LODY_AUTH_SITE_URL = process.env['LODY_AUTH_SITE_URL'];
  LODY_SERVER_URL = process.env['LODY_SERVER_URL'];
  SITE_URL = process.env['SITE_URL'] ?? 'https://lody.ai';
  SITE_APP_BASE_PATH = process.env['SITE_APP_BASE_PATH'] ?? '';
};

const MACHINE_ID_FILE_NAME = 'machine-id';
const CREDENTIALS_FILE_NAME = 'credentials.json';

const CredentialMachineIdSchema = z
  .object({
    version: z.literal(3),
    token: z.string().optional(),
    user: z
      .object({
        id: z.string(),
        email: z.string(),
        name: z.string().nullable().optional(),
      })
      .passthrough(),
    machine: z
      .object({
        machineName: z.string(),
        machineId: z.string().trim().min(1),
      })
      .passthrough(),
    createdAt: z.string().optional(),
  })
  .passthrough();

function getMachineIdFilePath(): string {
  return path.join(getLodyDataDir(), MACHINE_ID_FILE_NAME);
}

function readPersistedMachineId(): MachineId | null {
  try {
    const machineIdPath = getMachineIdFilePath();
    const id = fs.readFileSync(machineIdPath, 'utf-8').trim();
    if (!id) return null;
    return id as MachineId;
  } catch {
    return null;
  }
}

function readCredentialMachineId(): MachineId | null {
  try {
    const credentialsPath = path.join(getLodyDataDir(), CREDENTIALS_FILE_NAME);
    const parsed = CredentialMachineIdSchema.safeParse(
      JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'))
    );
    if (!parsed.success) return null;
    return parsed.data.machine.machineId as MachineId;
  } catch {
    return null;
  }
}

function persistMachineId(machineId: MachineId): MachineId {
  try {
    const machineIdPath = getMachineIdFilePath();
    fs.mkdirSync(path.dirname(machineIdPath), { recursive: true });
    fs.writeFileSync(machineIdPath, machineId, { encoding: 'utf-8', mode: 0o600 });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(machineIdPath, 0o600);
      } catch {
        // best effort
      }
    }
    return machineId;
  } catch {
    return readPersistedMachineId() ?? machineId;
  }
}

function createMachineId(machineId: MachineId): MachineId {
  try {
    const machineIdPath = getMachineIdFilePath();
    fs.mkdirSync(path.dirname(machineIdPath), { recursive: true });
    fs.writeFileSync(machineIdPath, machineId, {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    });
    return machineId;
  } catch {
    // Another CLI may win first creation. Re-read so every concurrent process uses its value.
    return readPersistedMachineId() ?? machineId;
  }
}

/**
 * Returns the installation-scoped machine ID, migrating the credential-bound
 * identity or creating and persisting a UUID on first use. The historical
 * name is retained for callers.
 */
export function getSystemMachineId(): MachineId | null {
  try {
    const persisted = readPersistedMachineId();
    const credentialMachineId = readCredentialMachineId();
    // Cached auth is already the runtime's machine identity. Keep telemetry and future pairing
    // aligned with it, including when a buggy release created a conflicting UUID first.
    if (credentialMachineId && credentialMachineId !== persisted) {
      return persistMachineId(credentialMachineId);
    }
    if (persisted) return persisted;

    return createMachineId(crypto.randomUUID() as MachineId);
  } catch {
    return null;
  }
}

export async function getSystemMachineIdAsync(): Promise<MachineId | null> {
  return getSystemMachineId();
}

/**
 * Returns a stable machine ID. The persisted identity keeps pairing retries
 * bound to the same installation.
 */
export async function getOrCreateStableMachineIdAsync(): Promise<MachineId> {
  const machineId = await getSystemMachineIdAsync();
  if (machineId) return machineId;

  // Preserve the existing best-effort behavior if the persisted ID cannot be read.
  return createMachineId(crypto.randomUUID() as MachineId);
}
