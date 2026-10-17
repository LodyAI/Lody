/** Command composition remains Legacy while LoroDocumentManager owns Promise cleanup. */
export interface WorkspaceCommandScope {
  readonly userId: string;
  readonly token: string;
  readonly machineId: string;
  readonly authBaseUrl: string;
  readonly authSiteUrl?: string;
}

interface CommandManager {
  cleanUp(options: { fast: boolean; preserveSessionStatus: boolean }): Promise<void>;
}

/**
 * Overlapping standalone commands borrow one manager; the last release cleans it up.
 * Daemon-executed commands borrow the daemon's replica instead and never reach this.
 */
export function makeWorkspaceCommandManagers<Manager extends CommandManager>() {
  const entries = new Map<
    string,
    {
      scope: WorkspaceCommandScope;
      ready: Promise<Manager>;
      users: number;
      closing?: Promise<void>;
    }
  >();
  return async function withManager<Result>(
    workspaceId: string,
    scope: WorkspaceCommandScope,
    create: () => Promise<Manager>,
    fn: (manager: Manager) => Promise<Result>,
    onCleanupFailure: (error: unknown) => void
  ): Promise<Result> {
    let entry = entries.get(workspaceId);
    // Hand off after the previous manager's actual cleanup. A failed cleanup is
    // reported once and never fences later commands.
    while (entry?.closing) {
      await entry.closing;
      entry = entries.get(workspaceId);
    }
    if (
      entry &&
      (entry.scope.userId !== scope.userId ||
        entry.scope.token !== scope.token ||
        entry.scope.machineId !== scope.machineId ||
        entry.scope.authBaseUrl !== scope.authBaseUrl ||
        entry.scope.authSiteUrl !== scope.authSiteUrl)
    )
      throw new Error('Concurrent workspace commands require the same authorization scope');
    if (!entry) {
      entry = { scope: { ...scope }, ready: Promise.resolve().then(create), users: 0 };
      entries.set(workspaceId, entry);
    }
    const borrowed = entry;
    borrowed.users++;
    let manager: Manager;
    try {
      manager = await borrowed.ready;
    } catch (error) {
      if (--borrowed.users === 0) entries.delete(workspaceId);
      throw error;
    }
    try {
      return await fn(manager);
    } finally {
      if (--borrowed.users === 0) {
        borrowed.closing = Promise.resolve()
          .then(() => manager.cleanUp({ fast: true, preserveSessionStatus: true }))
          // Preserve an accepted command's result, matching the existing cleanup policy.
          // A throwing reporter must not fail this command or the waiters behind it.
          .catch((error: unknown) => {
            try {
              onCleanupFailure(error);
            } catch {
              // Reporting is best effort.
            }
          })
          .finally(() => {
            entries.delete(workspaceId);
          });
        await borrowed.closing;
      }
    }
  };
}
