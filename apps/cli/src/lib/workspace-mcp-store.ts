import {
  createLegacyWorkspaceCatalogQuery,
  createLegacyWorkspaceCatalogCommands,
  type WorkspaceCatalogCommand,
  type WorkspaceCatalogQuery,
  type WorkspaceCatalogCommands,
  type WorkspaceCatalogBinding,
  deleteWorkspaceMcpServerFromFlock,
  getEffectiveDefaultMcpIds,
  getProjectMcpKey,
  type ProjectRef,
  getWorkspaceFlockDocId,
  writeWorkspaceMcpServerToFlock,
  type McpServerId,
  type WorkspaceFlockReadableFlock,
  type WorkspaceFlockWritableFlock,
  type WorkspaceId,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import { formatErrorMessage } from '@/utils/format-error';
import { WorkspaceSyncUnavailableError } from './command-runtime';

/** Wait only for the daemon-owned reader's first baseline, never force a refresh. */
export async function waitForMcpCatalogBaseline(
  manager: {
    catalogBaselineReady(docId: string, timeoutMs: number): Promise<boolean>;
  },
  workspaceId: WorkspaceId
): Promise<void> {
  if (!(await manager.catalogBaselineReady(getWorkspaceFlockDocId(workspaceId), 1_000))) {
    throw new WorkspaceSyncUnavailableError({ message: 'Workspace MCP catalog is still syncing.' });
  }
}

/** Defaults may use an old remote snapshot, but never infer absence from a new replica. */
export async function waitForMcpDefaultCatalog(
  manager: Parameters<typeof waitForMcpCatalogBaseline>[0] & {
    hasPersistedWorkspaceCatalog(): boolean;
  },
  workspaceId: WorkspaceId
): Promise<void> {
  try {
    await waitForMcpCatalogBaseline(manager, workspaceId);
  } catch (error) {
    if (!(error instanceof WorkspaceSyncUnavailableError)) throw error;
    try {
      if (manager.hasPersistedWorkspaceCatalog()) return;
    } catch (cause) {
      throw new WorkspaceSyncUnavailableError({
        message: 'Workspace MCP catalog history could not be read.',
        cause,
      });
    }
    throw error;
  }
}

export type McpCatalogWriteResult = {
  changed: boolean;
  synced: boolean;
  syncError?: string;
};

/** Trusted composition owner; business callers use its selected whole-room port. */
export type WorkspaceMcpCatalogOwner = {
  workspaceCatalog: WorkspaceCatalogQuery & WorkspaceCatalogCommands;
  workspaceCatalogBinding: WorkspaceCatalogBinding;
};
type WorkspaceMcpRepo = {
  openFlockDoc(docId: string): Promise<{
    flock: WorkspaceFlockWritableFlock;
    syncOnce(): Promise<unknown>;
  }>;
  flush(): Promise<void>;
};

type WorkspaceMcpReadableRepo = {
  openFlockDoc(docId: string): Promise<{ flock: WorkspaceFlockReadableFlock }>;
};

export async function syncMcpCatalog(
  syncer: {
    syncFlockDocOrThrow(
      docId: string,
      options: { timeoutMs: number; reason: string }
    ): Promise<void>;
  },
  workspaceId: WorkspaceId
): Promise<void> {
  await syncer.syncFlockDocOrThrow(getWorkspaceFlockDocId(workspaceId), {
    timeoutMs: 10_000,
    reason: 'mcp-catalog-read',
  });
}

export async function listWorkspaceMcpCatalog(
  repo: WorkspaceMcpReadableRepo | WorkspaceMcpCatalogOwner,
  workspaceId: WorkspaceId
): Promise<WorkspaceMcpServerMeta[]> {
  if ('workspaceCatalog' in repo)
    return (await repo.workspaceCatalog.read({ ...repo.workspaceCatalogBinding, workspaceId }))
      .servers;
  const binding = { workspaceId, accountId: null };
  return (
    await createLegacyWorkspaceCatalogQuery({
      binding,
      open: () => repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId)),
    }).read(binding)
  ).servers;
}

/**
 * A catalog mutation is durable once it is flushed locally; the workspace sync
 * that follows is best effort and its failure is reported, never rolled back.
 */
async function commitCatalogChange(
  repo: WorkspaceMcpRepo | WorkspaceMcpCatalogOwner,
  workspaceId: WorkspaceId,
  options: { sync?: boolean },
  command: Extract<WorkspaceCatalogCommand, { kind: 'put-mcp' | 'delete-mcp' }>
): Promise<McpCatalogWriteResult> {
  if ('workspaceCatalog' in repo) {
    const binding = { ...repo.workspaceCatalogBinding, workspaceId };
    const { changed } = await repo.workspaceCatalog.execute(binding, command);
    if (!changed) return { changed: false, synced: true };
    if (options.sync === false) return { changed: true, synced: false, syncError: 'offline mode' };
    try {
      await repo.workspaceCatalog.upload(binding);
      return { changed: true, synced: true };
    } catch (error) {
      return { changed: true, synced: false, syncError: formatErrorMessage(error) };
    }
  }
  const handle = await repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
  let changed = false;
  const binding = { workspaceId, accountId: null };
  const commands = createLegacyWorkspaceCatalogCommands({
    binding,
    put: async (_key, value) => {
      changed = writeWorkspaceMcpServerToFlock(handle.flock, value as WorkspaceMcpServerMeta);
      if (changed) await repo.flush();
    },
    remove: async (key) => {
      changed = deleteWorkspaceMcpServerFromFlock(handle.flock, key[1] as McpServerId);
      if (changed) await repo.flush();
    },
    upload: async () => {
      await handle.syncOnce();
    },
  });
  await commands.execute(binding, command);
  if (!changed) {
    return { changed: false, synced: true };
  }
  if (options.sync === false) {
    return { changed: true, synced: false, syncError: 'offline mode' };
  }
  try {
    await commands.upload(binding);
    return { changed: true, synced: true };
  } catch (error) {
    return { changed: true, synced: false, syncError: formatErrorMessage(error) };
  }
}

export async function upsertWorkspaceMcpCatalogEntry(
  repo: WorkspaceMcpRepo | WorkspaceMcpCatalogOwner,
  workspaceId: WorkspaceId,
  entry: WorkspaceMcpServerMeta,
  options: { sync?: boolean } = {}
): Promise<McpCatalogWriteResult> {
  return commitCatalogChange(repo, workspaceId, options, { kind: 'put-mcp', entry });
}

export async function deleteWorkspaceMcpCatalogEntry(
  repo: WorkspaceMcpRepo | WorkspaceMcpCatalogOwner,
  workspaceId: WorkspaceId,
  mcpServerId: McpServerId,
  options: { sync?: boolean } = {}
): Promise<McpCatalogWriteResult> {
  return commitCatalogChange(repo, workspaceId, options, { kind: 'delete-mcp', id: mcpServerId });
}

/** Read a single local workspace snapshot; explicit selections bypass defaults. */
export async function readProjectDefaultMcpIds(
  repo: WorkspaceMcpReadableRepo | WorkspaceMcpCatalogOwner,
  workspaceId: WorkspaceId,
  project: ProjectRef | undefined,
  machineId: string
): Promise<McpServerId[]> {
  const binding = { workspaceId, accountId: null };
  const catalog =
    'workspaceCatalog' in repo
      ? await repo.workspaceCatalog.read({ ...repo.workspaceCatalogBinding, workspaceId })
      : await createLegacyWorkspaceCatalogQuery({
          binding,
          open: () => repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId)),
        }).read(binding);
  const key = getProjectMcpKey(project, machineId);
  return getEffectiveDefaultMcpIds(
    catalog.servers,
    key ? catalog.projectMcpDefaults[key] : undefined
  );
}
