import { encryptedLocalNamespace, type E2eeLocalDataScope } from './e2ee-local-data';
/** This contains unsynced user data, not a disposable replica cache. */
export const PROMPT_SHORTCUT_DATA_PREFIX = 'lody-shortcut-data-';

export function promptShortcutDatabaseName(
  workspaceId: string,
  userId: string,
  scope?: E2eeLocalDataScope
): string {
  if (scope) {
    if (scope.workspaceId !== workspaceId || scope.accountId !== userId)
      throw new Error('e2ee_shortcut_identity_mismatch');
    return `${PROMPT_SHORTCUT_DATA_PREFIX}${encryptedLocalNamespace(scope)}`;
  }
  return `${PROMPT_SHORTCUT_DATA_PREFIX}${encodeURIComponent(workspaceId)}:${encodeURIComponent(userId)}`;
}

const openDatabases = new Map<string, Set<() => Promise<void>>>();

/** Cleanup owns the live writers as well as the exact namespace they opened. */
export function registerPromptShortcutDatabase(
  name: string,
  close: () => Promise<void>
): () => void {
  const owners = openDatabases.get(name) ?? new Set();
  owners.add(close);
  openDatabases.set(name, owners);
  return () => {
    owners.delete(close);
    if (!owners.size) openDatabases.delete(name);
  };
}

export async function closePromptShortcutDatabase(name: string): Promise<void> {
  const results = await Promise.allSettled(
    [...(openDatabases.get(name) ?? [])].map((close) => close())
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
