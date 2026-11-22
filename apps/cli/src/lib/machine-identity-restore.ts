import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { z } from 'zod';
import type { MachineIdentityRestoreIntent } from '@lody/cloud-api';
import { deriveConvexSiteUrl, normalizeBaseUrl } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { LODY_AUTH_SITE_URL, LODY_AUTH_URL } from '@/utils/const';
import {
  CLI_EXIT_CODE_RETRYABLE_STARTUP,
  CLI_EXIT_CODE_AUTH_FAILURE,
} from '@lody/shared/node/local-cli-supervisor';

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
    sourceMachineId: z.string().min(1),
    targetMachineId: z.string().min(1),
    requestId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
    requesterUserId: z.string().min(1),
  })
  .strict();
type Intent = MachineIdentityRestoreIntent;
const CredentialsSchema = z
  .object({
    version: z.literal(3),
    token: z.string().min(1),
    user: z.object({ id: z.string().min(1) }).passthrough(),
    machine: z.object({ machineId: z.string().min(1), machineName: z.string() }).passthrough(),
  })
  .passthrough();

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWrite(file: string, bytes: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, bytes, { mode: 0o600 });
  await fs.rename(temporary, file);
}

/** An accepted restart owns this intent. No running runtime changes identity. */
export async function prepareMachineIdentityRestore(input: Intent, root = getLodyDataDir()) {
  const intent = IntentSchema.parse(input);
  if (intent.sourceMachineId === intent.targetMachineId)
    throw new Error('Choose a different machine identity.');
  const credentials = CredentialsSchema.parse(
    JSON.parse(await fs.readFile(path.join(root, 'credentials.json'), 'utf8'))
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
  const credentialsPath = path.join(root, 'credentials.json');
  const credentials = CredentialsSchema.parse(
    JSON.parse(await fs.readFile(credentialsPath, 'utf8'))
  );
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
  await fs.mkdir(backup, { recursive: true, mode: 0o700 });
  const backupCredentials = path.join(backup, 'credentials.json');
  if ((await readOptional(backupCredentials)) === null) {
    if (credentials.machine.machineId !== intent.sourceMachineId)
      throw new Error('Identity restore backup is missing.');
    await fs.copyFile(credentialsPath, backupCredentials, fs.constants.COPYFILE_EXCL);
    await fs.chmod(backupCredentials, 0o600);
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
  await atomicWrite(
    credentialsPath,
    JSON.stringify(
      { ...credentials, machine: { ...credentials.machine, machineId: intent.targetMachineId } },
      null,
      2
    )
  );
  await atomicWrite(path.join(root, 'machine-id'), intent.targetMachineId);
  await fs.rename(file, path.join(backup, 'completed.json'));
}
