import type { PlatformE2eeWorkspaces } from '@lody/platform';
import {
  clearPendingE2eeWorkspace,
  saveE2eeGenesisPin,
  retainWorkspaceModeProof,
  type PendingE2eeWorkspace,
} from './e2ee-workspace-storage';

/**
 * Server refusals that prove this request ID holds no reservation and can never
 * succeed as saved. The server raises each only after it found no earlier
 * reservation for the ID, in the same transaction (or, for deleted, behind a
 * permanent tombstone), so dropping the saved request loses nothing.
 */
const UNRESERVED_REFUSALS = new Set([
  'e2ee_creation_not_enabled',
  'e2ee_creation_deleted',
  'e2ee_genesis_already_bound',
  'workspace_slug_taken',
]);

/** The server error code of a Convex error, if any. */
export function e2eeCreationErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('data' in error)) return undefined;
  const data = (error as { data?: unknown }).data;
  return typeof data === 'object' &&
    data !== null &&
    'code' in data &&
    typeof data.code === 'string'
    ? data.code
    : undefined;
}

/** Reconcile the durable intent. Any unknown outcome leaves it available for retry;
 * a refusal that proves nothing was reserved removes it and rethrows the refusal. */
export async function createPreparedE2eeWorkspace(
  port: PlatformE2eeWorkspaces,
  storage: Storage,
  pending: PendingE2eeWorkspace
) {
  if (!port.prepareCreation) throw new Error('Device custody unavailable');
  const prepared = await port.prepareCreation(pending);
  if (
    prepared.accountId !== pending.accountId ||
    prepared.requestId !== pending.requestId ||
    prepared.name !== pending.name ||
    prepared.slug !== pending.slug
  )
    throw new Error('Creation intent changed');
  let result: Awaited<ReturnType<PlatformE2eeWorkspaces['create']>>;
  try {
    result = await port.create({
      accountId: pending.accountId,
      name: pending.name,
      slug: pending.slug,
      requestId: pending.requestId,
      genesisRecordHex: prepared.genesisRecordHex,
      deviceCredentialHash: prepared.deviceCredentialHash,
      developerMode: true,
    });
  } catch (error) {
    const code = e2eeCreationErrorCode(error);
    if (code !== undefined && UNRESERVED_REFUSALS.has(code))
      clearPendingE2eeWorkspace(storage, pending);
    throw error;
  }
  if (
    result.contentMode !== 'e2ee' ||
    result.contentModeVersion !== 1 ||
    result.name !== pending.name ||
    result.slug !== pending.slug ||
    result.genesisHash !== prepared.genesisHashHex ||
    result.cryptoOrgId !== prepared.genesisHashHex ||
    result.activation !== 'control-only'
  )
    throw new Error('Creation response changed');
  saveE2eeGenesisPin(storage, pending.accountId, result.workspaceId, prepared.genesisHashHex);
  retainWorkspaceModeProof(storage, pending.accountId, pending.slug, result);
  clearPendingE2eeWorkspace(storage, pending);
  return result;
}

/** Creation stays behind both developer toggles. A saved request whose result may
 * already be committed stays visible and resumable after the toggles are turned off. */
export function e2eeCreationChoice(input: {
  featureEnabled: boolean;
  selected: boolean;
  resumable: boolean;
  savedRequests: number;
}): { showOption: boolean; encrypt: boolean } {
  return {
    showOption: input.featureEnabled || input.resumable || input.savedRequests > 0,
    encrypt: input.resumable || (input.featureEnabled && input.selected),
  };
}

/** The server's release switch has not enabled new encrypted workspaces for this
 * account. The server checks it only for a request ID without a reservation, so
 * the refused request was never reserved and is no longer saved. */
export function isE2eeCreationNotEnabled(error: unknown): boolean {
  return e2eeCreationErrorCode(error) === 'e2ee_creation_not_enabled';
}
