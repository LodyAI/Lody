import { createSessionInputStorage } from './session-input-storage';
import { removeEagerSyncHighWaterNamespace } from './eager-sync-high-water-cache';

/** Only the native, authenticated member-removal result triggers terminal cleanup. */
export const isE2eeMemberRemoved = (error: unknown): boolean =>
  error instanceof Error &&
  /^(?:Error invoking remote method 'e2ee[.:](?:open|refresh|contentStreamsToken|removeMember|setMemberRole)': Error: )?e2ee_member_removed$/.test(
    error.message
  );

/** Call after this window's workspace runtime closes. Each other window retires
 * its own namespace on the same authenticated removal; never delete global stores. */
export async function removeEncryptedWorkspaceLocalData(input: {
  accountId: string;
  workspaceId: string;
  windowId: string;
}): Promise<void> {
  const namespace = input.windowId ? `${input.workspaceId}:${input.windowId}` : input.workspaceId;
  const remove = (name: string) =>
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('e2ee_local_cleanup_pending'));
    });
  const removeInputs = async () => {
    const pending = createSessionInputStorage(input.accountId, input.workspaceId);
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

const cleanupKey = (accountId: string, workspaceId: string, windowId: string) =>
  `lody-e2ee-member-cleanup:${encodeURIComponent(accountId)}:${encodeURIComponent(workspaceId)}:${encodeURIComponent(windowId)}`;

type CleanupScope = { accountId: string; workspaceId: string; windowId: string };
// Repo/cursor databases are shared by this window's physical workspace namespace.
// Only their successor waits; unrelated workspaces never inherit deletion failure.
const cleanupFlights = new Map<string, Promise<void>>();
const pendingCleanup = new Map<string, CleanupScope>();
const physicalScope = (input: CleanupScope) => JSON.stringify([input.workspaceId, input.windowId]);

/** Native removal is already authenticated and scoped when this marker is saved. */
export function retainEncryptedWorkspaceCleanup(input: CleanupScope): void {
  pendingCleanup.set(physicalScope(input), input);
  localStorage.setItem(cleanupKey(input.accountId, input.workspaceId, input.windowId), '1');
}

/** Join only this physical workspace's erasure before reusing its databases. */
export async function resumeEncryptedWorkspaceCleanup(
  input: CleanupScope,
  force = false
): Promise<void> {
  const physical = physicalScope(input);
  const running = cleanupFlights.get(physical);
  if (running) return running;
  const retained = pendingCleanup.get(physical);
  if (
    !force &&
    !retained &&
    localStorage.getItem(cleanupKey(input.accountId, input.workspaceId, input.windowId)) !== '1'
  )
    return;
  const target = retained ?? input;
  pendingCleanup.set(physical, target);
  const flight = (async () => {
    await removeEncryptedWorkspaceLocalData(target);
    localStorage.removeItem(cleanupKey(target.accountId, target.workspaceId, target.windowId));
    pendingCleanup.delete(physical);
  })();
  cleanupFlights.set(physical, flight);
  try {
    await flight;
  } finally {
    if (cleanupFlights.get(physical) === flight) cleanupFlights.delete(physical);
  }
}
