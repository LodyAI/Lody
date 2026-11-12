import { createSessionInputStorage } from './session-input-storage';
import { personalHostFailureCode } from './e2ee-control-failure';
import { removeEagerSyncHighWaterNamespace } from './eager-sync-high-water-cache';
import {
  encryptedLocalNamespace,
  parseEncryptedLocalScope,
  type E2eeLocalDataScope,
} from './e2ee-local-data';

/** Exact native results of credential-authenticated access loss. Whole-member
 * removal ends membership; device revocation ends only this device's identity. */
export type E2eeAccessLoss = 'e2ee_member_removed' | 'e2ee_device_revoked';
const accessLossPattern =
  /^(?:Error invoking remote method 'e2ee[.:](?:open|refresh|contentStreamsToken|removeMember|setMemberRole|transferOwnership)': Error: )?(e2ee_member_removed|e2ee_device_revoked)$/;

/** Only these exact native results trigger terminal cleanup; any other error never does.
 * A personal-device host (phone, browser) reports its own device absent from the
 * verified ledger as typed `revoked`; that is this device's revocation. Membership
 * is not inferred from it: the control page reads the ledger and shows removal. */
export const e2eeAccessLoss = (error: unknown): E2eeAccessLoss | null => {
  if (personalHostFailureCode(error) === 'revoked') return 'e2ee_device_revoked';
  // A portable host's typed loss, from its verified ledger or a credential-bound
  // adapter's parsed refusal: only its tag with an exact code, never a substring
  // or a bare `code` field on an unrelated network or JWT error.
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { _tag?: unknown })._tag === 'PersonalAccessLoss'
  ) {
    const code = (error as { code?: unknown }).code;
    return code === 'e2ee_member_removed' || code === 'e2ee_device_revoked' ? code : null;
  }
  return error instanceof Error
    ? ((accessLossPattern.exec(error.message)?.[1] as E2eeAccessLoss | undefined) ?? null)
    : null;
};
export const isE2eeMemberRemoved = (error: unknown): boolean =>
  e2eeAccessLoss(error) === 'e2ee_member_removed';
export const isE2eeDeviceRevoked = (error: unknown): boolean =>
  e2eeAccessLoss(error) === 'e2ee_device_revoked';

/** Call after this window's workspace runtime closes. Each other window retires
 * its own namespace on the same authenticated removal; never delete global stores. */
export async function removeEncryptedWorkspaceLocalData(input: E2eeLocalDataScope): Promise<void> {
  const namespace = encryptedLocalNamespace(input);
  const remove = (name: string) =>
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('e2ee_local_cleanup_pending'));
    });
  const removeInputs = async () => {
    const pending = createSessionInputStorage(input.accountId, input.workspaceId, undefined, input);
    try {
      await pending.removeWorkspace();
    } finally {
      await pending.close();
    }
  };
  const results = await Promise.allSettled([
    removeInputs(),
    remove(`lody-loro-repo-db-${namespace}`),
    remove(`lody-loro-stream-cursors-${namespace}`),
    removeEagerSyncHighWaterNamespace(namespace),
  ]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

const receiptPrefix = 'lody-e2ee-member-cleanup-v2:';
const cleanupKey = (input: E2eeLocalDataScope) => receiptPrefix + encryptedLocalNamespace(input);
const cleanupFlights = new Map<string, Promise<void>>();
const pendingCleanup = new Map<string, E2eeLocalDataScope>();

/** Persist the exact retired instance; no workspace-wide deletion fallback exists. */
export function retainEncryptedWorkspaceCleanup(input: E2eeLocalDataScope): void {
  const scope = parseEncryptedLocalScope(input);
  pendingCleanup.set(encryptedLocalNamespace(scope), scope);
  localStorage.setItem(cleanupKey(scope), JSON.stringify(scope));
}

/** A successor only waits for deletion of its exact account/device/window namespace. */
export async function resumeEncryptedWorkspaceCleanup(
  input: E2eeLocalDataScope,
  force = false
): Promise<void> {
  const scope = parseEncryptedLocalScope(input);
  const namespace = encryptedLocalNamespace(scope);
  const running = cleanupFlights.get(namespace);
  if (running) return running;
  const key = cleanupKey(scope);
  if (!force && !pendingCleanup.has(namespace) && localStorage.getItem(key) === null) return;
  pendingCleanup.set(namespace, scope);
  const flight = (async () => {
    await removeEncryptedWorkspaceLocalData(scope);
    localStorage.removeItem(key);
    pendingCleanup.delete(namespace);
  })();
  cleanupFlights.set(namespace, flight);
  try {
    await flight;
  } finally {
    if (cleanupFlights.get(namespace) === flight) cleanupFlights.delete(namespace);
  }
}

/** Retry old receipts independently after reopening a different identity. All locators
 * are public local originals, and every deletion still names its original instance. */
export async function retryRetiredEncryptedWorkspaceCleanup(
  current: E2eeLocalDataScope
): Promise<void> {
  const scopes = new Map(pendingCleanup);
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(receiptPrefix)) continue;
    const stored = localStorage.getItem(key);
    if (stored === null) continue;
    const scope = parseEncryptedLocalScope(JSON.parse(stored));
    if (cleanupKey(scope) !== key) throw new Error('e2ee_invalid_local_cleanup');
    scopes.set(encryptedLocalNamespace(scope), scope);
  }
  const namespace = encryptedLocalNamespace(current);
  const results = await Promise.allSettled(
    [...scopes]
      .filter(
        ([key, scope]) =>
          key !== namespace &&
          scope.accountId === current.accountId &&
          scope.workspaceId === current.workspaceId &&
          scope.windowId === current.windowId
      )
      .map(([, scope]) => resumeEncryptedWorkspaceCleanup(scope))
  );
  if (results.some((result) => result.status === 'rejected'))
    throw new Error('e2ee_local_cleanup_pending');
}
