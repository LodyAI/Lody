/** Local hints only: listeners must read verified native state before selecting keys. */
const listeners = new Set<{ accountId: string; workspaceId: string; changed: () => void }>();
export function subscribeE2eeLedgerChanges(
  accountId: string,
  workspaceId: string,
  changed: () => void
) {
  const listener = { accountId, workspaceId, changed };
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function notifyE2eeLedgerChanged(accountId: string, workspaceId: string) {
  for (const listener of listeners)
    if (listener.accountId === accountId && listener.workspaceId === workspaceId)
      listener.changed();
}
