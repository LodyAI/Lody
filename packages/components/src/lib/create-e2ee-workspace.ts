import type { PlatformE2eeWorkspaces } from '@lody/platform';
import {
  clearPendingE2eeWorkspace,
  listPendingE2eeWorkspaces,
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
  'e2ee_account_identity_conflict',
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

/** True only after storage no longer holds the exact submitted request. A read
 * failure keeps the component locked because storage remains authoritative. */
export function pendingCreationRemoved(
  storage: Storage,
  accountId: string | null,
  requestId: string
): boolean {
  if (!accountId) return false;
  try {
    return !listPendingE2eeWorkspaces(storage, accountId).some(
      (request) => request.requestId === requestId
    );
  } catch {
    return false;
  }
}

/** Destructive discard runs only after the explicit confirmation. */
export function clearConfirmedPendingCreation(
  storage: Storage,
  pending: PendingE2eeWorkspace | null,
  confirmed: boolean
): boolean {
  if (!confirmed || !pending) return false;
  clearPendingE2eeWorkspace(storage, pending);
  return true;
}

/** Only the account that saved this request may resume or discard it. */
export function canResumePendingCreation(
  pending: PendingE2eeWorkspace | null,
  accountId: string | null
): boolean {
  return Boolean(pending && accountId && pending.accountId === accountId);
}

/** While a submit is in flight, the discard action stays unavailable. */
export function canDiscardPendingCreation(
  creating: boolean,
  pending: PendingE2eeWorkspace | null,
  accountId: string | null
): boolean {
  return !creating && canResumePendingCreation(pending, accountId);
}

/** A pending request has already been submitted: its slug and free slot may
 * belong to that request, so new-workspace checks must not block continuation. */
export function e2eeCreationAvailability(
  pending: PendingE2eeWorkspace | null,
  availability: { canCreateFree?: boolean } | null | undefined
) {
  const resumable = Boolean(pending);
  return {
    resumable,
    canCreate: resumable || availability?.canCreateFree === true,
    blocked: !resumable && availability?.canCreateFree === false,
    slugCheckApplies: !resumable,
  };
}

/** Reuse the device's saved request instead of minting a second identity after a
 * lost response. The caller persists the returned intent before any host call. */
export function e2eeCreationIntent(
  accountId: string,
  pending: PendingE2eeWorkspace | null,
  name: string,
  slug: string
): PendingE2eeWorkspace {
  return (
    pending ?? {
      accountId,
      requestId: crypto.randomUUID(),
      name: name.trim(),
      slug,
    }
  );
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

export type PendingE2eeRequestLists = {
  active: PendingE2eeWorkspace[];
  archived: PendingE2eeWorkspace[];
};

/** Keep the previous lists when storage holds the same requests, so re-reading
 * storage never re-renders a form for an unchanged list. */
export function keepSameRequestLists(
  previous: PendingE2eeRequestLists,
  next: PendingE2eeRequestLists
): PendingE2eeRequestLists {
  const same = (a: PendingE2eeWorkspace[], b: PendingE2eeWorkspace[]) =>
    a.length === b.length &&
    a.every(
      (item, index) =>
        item.accountId === b[index]!.accountId &&
        item.requestId === b[index]!.requestId &&
        item.name === b[index]!.name &&
        item.slug === b[index]!.slug
    );
  return same(previous.active, next.active) && same(previous.archived, next.archived)
    ? previous
    : next;
}
