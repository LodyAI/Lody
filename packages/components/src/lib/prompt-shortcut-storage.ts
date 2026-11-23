/** This contains unsynced user data, not a disposable replica cache. */
export const PROMPT_SHORTCUT_DATA_PREFIX = 'lody-shortcut-data-';

export function promptShortcutDatabaseName(workspaceId: string, userId: string): string {
  return `${PROMPT_SHORTCUT_DATA_PREFIX}${encodeURIComponent(workspaceId)}:${encodeURIComponent(userId)}`;
}
