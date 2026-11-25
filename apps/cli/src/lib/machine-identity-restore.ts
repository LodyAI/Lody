import { randomBytes, randomUUID } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { MachineIdentityRestoreIntent } from '@lody/cloud-api';
import { deriveConvexSiteUrl, normalizeBaseUrl, type MachineId } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  inspectLocalCliHost,
  type LocalCliHostRecord,
} from '@lody/shared/node/local-cli-host-lease';
import {
  CLI_EXIT_CODE_AUTH_FAILURE,
  CLI_EXIT_CODE_RETRYABLE_STARTUP,
} from '@lody/shared/node/local-cli-supervisor';
import { LODY_AUTH_SITE_URL, LODY_AUTH_URL } from '@/utils/const';
import {
  CredentialsV3Schema,
  getCredentialsFilePath,
  MachineIdSchema,
  readCredentialsFileStrict,
  writeCredentialsFile,
} from './credentials-file';
import {
  getMachineIdFilePath,
  isDefaultLodyDataDir,
  parseMachineId,
  persistMachineId,
  readAnchorMachineId,
} from './machine-identity';
import { writePrivateCredentialFile } from './private-credential-file';

export class MachineIdentityRestoreError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions
  ) {
    super(`${message} The restore intent and original backup were retained.`, options);
    this.name = 'MachineIdentityRestoreError';
  }
}

/** Use existing watchdog exits: transient dependency failure retries without crash accounting. */
export function machineIdentityRestoreStartupExitCode(error: unknown): number {
  return error instanceof MachineIdentityRestoreError && error.retryable
    ? CLI_EXIT_CODE_RETRYABLE_STARTUP
    : CLI_EXIT_CODE_AUTH_FAILURE;
}

const IntentSchema = z
  .object({
    workspaceId: z.string().min(1),
    sourceMachineId: MachineIdSchema,
    targetMachineId: MachineIdSchema,
    requestId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
    requesterUserId: z.string().min(1),
  })
  .strict();
type Intent = MachineIdentityRestoreIntent;

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function readOptionalSync(file: string): string | null {
  try {
    return fsSync.readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeIdentityBackupFiles(
  backupDir: string,
  files: { credentialsRaw?: string | null; machineIdRaw?: string | null }
): void {
  fsSync.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  if (files.credentialsRaw != null) {
    writePrivateCredentialFile(path.join(backupDir, 'credentials.json'), files.credentialsRaw);
  }
  if (files.machineIdRaw != null) {
    writePrivateCredentialFile(path.join(backupDir, 'machine-id'), files.machineIdRaw);
  }
}

/** An accepted restart owns this intent. No running runtime changes identity. */
export async function prepareMachineIdentityRestore(input: Intent, root = getLodyDataDir()) {
  const intent = IntentSchema.parse(input);
  if (intent.sourceMachineId === intent.targetMachineId)
    throw new Error('Choose a different machine identity.');
  const credentials = CredentialsV3Schema.parse(
    JSON.parse(await fs.readFile(getCredentialsFilePath(root), 'utf8'))
  );
  if (
    credentials.user.id !== intent.requesterUserId ||
    credentials.machine.machineId !== intent.sourceMachineId
  ) {
    throw new Error('The signed-in machine identity changed.');
  }
  const file = path.join(root, 'machine-identity-restore.json');
  const existing = await readOptional(file);
  if (
    existing !== null &&
    JSON.stringify(IntentSchema.parse(JSON.parse(existing))) !== JSON.stringify(intent)
  ) {
    throw new Error(
      'Another machine identity restore is pending. Restart the daemon to finish it.'
    );
  }
  if (existing !== null) return false;
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(intent), { mode: 0o600 });
  try {
    // Exclusive publication across the daemon's independent workspace RPC lanes.
    await fs.link(temporary, file);
    return true;
  } catch (error) {
    const winner = await readOptional(file);
    if (
      winner !== null &&
      JSON.stringify(IntentSchema.parse(JSON.parse(winner))) === JSON.stringify(intent)
    )
      return false;
    throw error;
  } finally {
    // An orphaned temporary copy cannot change the published intent.
    await fs.unlink(temporary).catch(() => undefined);
  }
}

/** Release only this unaccepted intent when a task won the final admission check. */
export async function cancelPreparedMachineIdentityRestore(
  requestId: string,
  root = getLodyDataDir()
) {
  const file = path.join(root, 'machine-identity-restore.json');
  const original = await readOptional(file);
  if (original === null) return;
  if (IntentSchema.parse(JSON.parse(original)).requestId !== requestId)
    throw new Error('Another restore owns this intent.');
  await fs.unlink(file);
}

/** Before opening any runtime, reconcile the exact accepted operation, then publish credentials. */
export async function applyPendingMachineIdentityRestore(
  options: {
    root?: string;
    siteUrl?: string;
    fetchImpl?: typeof fetch;
    /** Candidate health checks must never commit an identity change. */
    readOnly?: boolean;
  } = {}
): Promise<void> {
  const root = options.root ?? getLodyDataDir();
  const file = path.join(root, 'machine-identity-restore.json');
  const original = await readOptional(file);
  if (original === null) return;
  if (options.readOnly)
    throw new Error('A pending machine identity restore must finish before a managed update.');
  const intent = IntentSchema.parse(JSON.parse(original));
  const credentialsPath = getCredentialsFilePath(root);
  const rawCredentials = await fs.readFile(credentialsPath, 'utf8');
  const credentials = CredentialsV3Schema.parse(JSON.parse(rawCredentials));
  if (
    credentials.user.id !== intent.requesterUserId ||
    ![intent.sourceMachineId, intent.targetMachineId].includes(credentials.machine.machineId)
  ) {
    throw new Error('Pending identity restore belongs to another signed-in machine.');
  }
  const siteUrl =
    options.siteUrl ??
    LODY_AUTH_SITE_URL ??
    (LODY_AUTH_URL ? deriveConvexSiteUrl(normalizeBaseUrl(LODY_AUTH_URL)) : null);
  if (!siteUrl) throw new Error('Machine identity restore requires the cloud auth service.');
  // Retain the original credentials before any remote or local mutation. Exact retries
  // use the same request id even if the previous commit response was lost.
  const backup = path.join(root, 'identity-restore-backups', intent.requestId);
  const backupCredentials = path.join(backup, 'credentials.json');
  if ((await readOptional(backupCredentials)) === null) {
    if (credentials.machine.machineId !== intent.sourceMachineId)
      throw new Error('Identity restore backup is missing.');
    writeIdentityBackupFiles(backup, { credentialsRaw: rawCredentials });
  }
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(
      `${normalizeBaseUrl(siteUrl)}/api/machine-lifecycle/restore-identity`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials.token}`,
        },
        body: JSON.stringify(intent),
        signal: AbortSignal.timeout(15_000),
      }
    );
  } catch (cause) {
    throw new MachineIdentityRestoreError(
      'Identity restore confirmation is temporarily unavailable.',
      true,
      { cause }
    );
  }
  if (!response.ok) {
    throw new MachineIdentityRestoreError(
      `Machine identity restore was not confirmed (${response.status}).`,
      response.status >= 500 || response.status === 408 || response.status === 429
    );
  }
  let committed: { requestId: string; machineId: string };
  try {
    committed = z
      .object({ requestId: z.string(), machineId: z.string() })
      .parse(await response.json());
  } catch (cause) {
    throw new MachineIdentityRestoreError('Identity restore confirmation was unreadable.', true, {
      cause,
    });
  }
  if (committed.requestId !== intent.requestId || committed.machineId !== intent.targetMachineId) {
    throw new MachineIdentityRestoreError(
      'Machine identity restore response did not match the accepted request.',
      false
    );
  }
  // Keep the intent until both files are published. After an interrupted write,
  // the next worker reconfirms this exact commit and rewrites both files before
  // any runtime starts; it never relies on getSystemMachineId to run first.
  writeCredentialsFile(
    { ...credentials, machine: { ...credentials.machine, machineId: intent.targetMachineId } },
    root
  );
  persistMachineId(intent.targetMachineId, { dataDir: root, forceRefreshAnchor: true });
  await fs.rename(file, path.join(backup, 'completed.json'));
}

export type RestoreLocalMachineIdResult =
  | {
      ok: true;
      changed: false;
      targetMachineId: MachineId;
      previousMachineId: MachineId | null;
      previousCredentialMachineId: MachineId | null;
      credentialsUpdated: false;
      anchorUpdated: false;
      backupDir: null;
    }
  | {
      ok: true;
      changed: true;
      targetMachineId: MachineId;
      previousMachineId: MachineId | null;
      previousCredentialMachineId: MachineId | null;
      credentialsUpdated: boolean;
      anchorUpdated: boolean;
      backupDir: string | null;
    };

function formatRunningHostError(host: LocalCliHostRecord): string {
  if (host.mode === 'electron') {
    return `Cannot restore machine ID while the Lody desktop app is running (pid ${host.pid}). Quit the Lody desktop app completely and retry.`;
  }
  if (host.mode === 'daemon') {
    return `Cannot restore machine ID while the Lody daemon is running (pid ${host.pid}). Stop it with \`lody daemon stop\` and retry.`;
  }
  return `Cannot restore machine ID while a local \`lody start\` process is running (pid ${host.pid}). Stop it and retry.`;
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

/**
 * Offline recovery for reinstalling or restoring a known previous machine ID.
 * Refuses while a local host lease is active on the default data dir, backs up
 * prior files, and atomically updates `credentials.json`, `machine-id`, and anchor.
 */
export async function restoreLocalMachineId(
  targetMachineIdInput: string
): Promise<RestoreLocalMachineIdResult> {
  const targetMachineId = parseMachineId(targetMachineIdInput);
  const dataDir = getLodyDataDir();
  const defaultDataDir = isDefaultLodyDataDir(dataDir);

  if (defaultDataDir) {
    const runningHost = await inspectLocalCliHost();
    if (runningHost) {
      throw new Error(formatRunningHostError(runningHost));
    }
  }

  const rawMachineId = readOptionalSync(getMachineIdFilePath(dataDir));
  const previousMachineId = rawMachineId?.trim() ? (rawMachineId.trim() as MachineId) : null;
  const existingCreds = readCredentialsFileStrict(dataDir);
  const previousCredentialMachineId = existingCreds?.credentials.machine.machineId ?? null;
  const existingAnchorMachineId = defaultDataDir ? readAnchorMachineId() : null;

  const machineIdMatches = previousMachineId === targetMachineId;
  const credentialsMatch = !existingCreds || previousCredentialMachineId === targetMachineId;
  const anchorMatches = !defaultDataDir || existingAnchorMachineId === targetMachineId;

  if (machineIdMatches && credentialsMatch && anchorMatches) {
    const anchorUpdated = defaultDataDir
      ? persistMachineId(targetMachineId, { dataDir, forceRefreshAnchor: true }).anchorStatus ===
        'updated'
      : false;
    if (!anchorUpdated) {
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
    return {
      ok: true,
      changed: true,
      targetMachineId,
      previousMachineId,
      previousCredentialMachineId,
      credentialsUpdated: false,
      anchorUpdated: true,
      backupDir: null,
    };
  }

  fsSync.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  let backupDir: string | null = null;
  if (rawMachineId !== null || existingCreds !== null) {
    const backupName = `manual-${formatBackupTimestamp(new Date())}-${randomBytes(2).toString('hex')}`;
    backupDir = path.join(dataDir, 'identity-restore-backups', backupName);
    writeIdentityBackupFiles(backupDir, {
      machineIdRaw: rawMachineId,
      credentialsRaw: existingCreds?.raw ?? null,
    });
  }

  let credentialsUpdated = false;
  if (existingCreds) {
    writeCredentialsFile(
      {
        ...existingCreds.credentials,
        machine: {
          ...existingCreds.credentials.machine,
          machineId: targetMachineId,
        },
      },
      dataDir
    );
    credentialsUpdated = true;
  }

  const { anchorStatus } = persistMachineId(targetMachineId, {
    dataDir,
    forceRefreshAnchor: true,
  });

  return {
    ok: true,
    changed: true,
    targetMachineId,
    previousMachineId,
    previousCredentialMachineId,
    credentialsUpdated,
    anchorUpdated: anchorStatus === 'updated',
    backupDir,
  };
}
