import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  inspectLocalCliHost,
  type LocalCliHostRecord,
} from '@lody/shared/node/local-cli-host-lease';
import { z } from 'zod';
import { writePrivateCredentialFile } from '@/lib/private-credential-file';
import {
  isCustomLodyDataDir,
  readMachineIdentityAnchor,
  syncMachineIdentityAnchor,
  type MachineIdentityStoreOptions,
} from '@/utils/machine-identity-store';

const MACHINE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_MACHINE_ID_LENGTH = 128;

const CredentialsV3Schema = z
  .object({
    version: z.literal(3),
    token: z.string(),
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

export interface RestoreLocalMachineIdOptions {
  dataDir?: string;
  isCustomDataDir?: boolean;
  inspectHost?: () => Promise<LocalCliHostRecord | null>;
  anchorOptions?: MachineIdentityStoreOptions;
  now?: () => Date;
}

export interface RestoreLocalMachineIdResult {
  ok: true;
  changed: boolean;
  targetMachineId: string;
  previousMachineId: string | null;
  previousCredentialMachineId: string | null;
  credentialsUpdated: boolean;
  anchorUpdated: boolean;
  backupDir: string | null;
}

export function validateMachineId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_MACHINE_ID_LENGTH || !MACHINE_ID_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid machine ID "${input}". Expected 1-${MAX_MACHINE_ID_LENGTH} characters matching [A-Za-z0-9._:-].`
    );
  }
  return trimmed;
}

function formatRunningHostError(host: LocalCliHostRecord): string {
  if (host.mode === 'electron') {
    return `Cannot restore machine ID while the Lody desktop app is running (pid ${host.pid}). Quit the Lody desktop app completely and retry.`;
  }
  if (host.mode === 'daemon') {
    return `Cannot restore machine ID while the Lody daemon is running (pid ${host.pid}). Stop it with \`lody daemon stop\` and retry.`;
  }
  return `Cannot restore machine ID while a local \`lody start\` process is running (pid ${host.pid}). Stop it and retry.`;
}

function readOptionalUtf8(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function formatBackupTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    '-',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');
}

export async function restoreLocalMachineId(
  targetMachineIdInput: string,
  options: RestoreLocalMachineIdOptions = {}
): Promise<RestoreLocalMachineIdResult> {
  const targetMachineId = validateMachineId(targetMachineIdInput);
  const dataDir = options.dataDir ?? getLodyDataDir();
  const customDataDir = options.isCustomDataDir ?? isCustomLodyDataDir();

  if (options.inspectHost || !customDataDir) {
    const runningHost = await (options.inspectHost ?? inspectLocalCliHost)();
    if (runningHost) {
      throw new Error(formatRunningHostError(runningHost));
    }
  }

  const machineIdPath = path.join(dataDir, 'machine-id');
  const credentialsPath = path.join(dataDir, 'credentials.json');

  const rawMachineId = readOptionalUtf8(machineIdPath);
  const previousMachineId = rawMachineId?.trim() || null;

  const rawCredentials = readOptionalUtf8(credentialsPath);
  let existingCredentials: z.infer<typeof CredentialsV3Schema> | null = null;
  if (rawCredentials !== null) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawCredentials);
    } catch {
      throw new Error(
        `Existing credentials file at ${credentialsPath} is not valid JSON. Fix or remove it before restoring.`
      );
    }
    const parsed = CredentialsV3Schema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error(
        `Existing credentials file at ${credentialsPath} has an unsupported format and cannot be updated safely.`
      );
    }
    existingCredentials = parsed.data;
  }
  const previousCredentialMachineId = existingCredentials?.machine.machineId ?? null;

  const existingAnchor = customDataDir ? null : readMachineIdentityAnchor(options.anchorOptions);
  const machineIdMatches = previousMachineId === targetMachineId;
  const credentialsMatch = !existingCredentials || previousCredentialMachineId === targetMachineId;
  const anchorMatches = customDataDir || existingAnchor?.machineId === targetMachineId;

  if (machineIdMatches && credentialsMatch && anchorMatches) {
    if (!customDataDir) {
      syncMachineIdentityAnchor(targetMachineId, {
        ...options.anchorOptions,
        forceRefreshFingerprint: true,
      });
    }
    return {
      ok: true,
      changed: false,
      targetMachineId,
      previousMachineId,
      previousCredentialMachineId,
      credentialsUpdated: false,
      anchorUpdated: false,
      backupDir: null,
    };
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  let backupDir: string | null = null;
  if (rawMachineId !== null || rawCredentials !== null) {
    const now = options.now ? options.now() : new Date();
    const backupName = `manual-${formatBackupTimestamp(now)}-${crypto.randomBytes(2).toString('hex')}`;
    backupDir = path.join(dataDir, 'identity-restore-backups', backupName);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    if (rawMachineId !== null) {
      writePrivateCredentialFile(path.join(backupDir, 'machine-id'), rawMachineId);
    }
    if (rawCredentials !== null) {
      writePrivateCredentialFile(path.join(backupDir, 'credentials.json'), rawCredentials);
    }
  }

  let credentialsUpdated = false;
  if (existingCredentials) {
    const updatedCredentials = {
      ...existingCredentials,
      machine: {
        ...existingCredentials.machine,
        machineId: targetMachineId,
      },
    };
    writePrivateCredentialFile(credentialsPath, JSON.stringify(updatedCredentials, null, 2));
    credentialsUpdated = true;
  }

  writePrivateCredentialFile(machineIdPath, targetMachineId);

  const anchorUpdated = customDataDir
    ? false
    : syncMachineIdentityAnchor(targetMachineId, {
        ...options.anchorOptions,
        forceRefreshFingerprint: true,
      });

  return {
    ok: true,
    changed: true,
    targetMachineId,
    previousMachineId,
    previousCredentialMachineId,
    credentialsUpdated,
    anchorUpdated,
    backupDir,
  };
}

function printHumanRestoreResult(result: RestoreLocalMachineIdResult): void {
  if (!result.changed) {
    console.log(`Local machine ID is already ${result.targetMachineId}. No changes were made.`);
    return;
  }

  console.log(`Restored local machine ID to ${result.targetMachineId}`);
  if (result.previousMachineId && result.previousMachineId !== result.targetMachineId) {
    console.log(`  Previous machine-id: ${result.previousMachineId}`);
  }
  if (
    result.previousCredentialMachineId &&
    result.previousCredentialMachineId !== result.targetMachineId
  ) {
    console.log(`  Previous credentials machineId: ${result.previousCredentialMachineId}`);
  }
  console.log(
    `  credentials.json updated: ${result.credentialsUpdated ? 'yes' : 'no (not present)'}`
  );
  console.log(`  backup anchor updated: ${result.anchorUpdated ? 'yes' : 'no'}`);
  if (result.backupDir) {
    console.log(`  Backup saved to: ${result.backupDir}`);
  }
  console.log(
    'Restart Lody (desktop app or `lody daemon start`) to reconnect with the restored identity.'
  );
}

export const machineRestoreIdCommand = new Command('restore-id')
  .description('Restore a previous local machine ID offline after reinstall or state loss')
  .argument('<machineId>', 'Target machine ID to restore locally')
  .option('--json', 'Print JSON output')
  .action(async (machineId: string, options: { json?: boolean }) => {
    try {
      const result = await restoreLocalMachineId(machineId);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printHumanRestoreResult(result);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) {
        console.log(JSON.stringify({ ok: false, error: message }, null, 2));
      } else {
        console.error(message);
      }
      process.exitCode = 1;
    }
  });
