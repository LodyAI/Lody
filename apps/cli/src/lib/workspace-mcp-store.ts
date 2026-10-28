import {
  deleteWorkspaceMcpServerFromFlock,
  getEffectiveDefaultMcpIds,
  getProjectMcpDefaults,
  getProjectMcpKey,
  type ProjectRef,
  getWorkspaceFlockDocId,
  listWorkspaceMcpServers,
  readWorkspaceFlockRowsFromFlock,
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

export type McpCatalogWriteResult = {
  changed: boolean;
  synced: boolean;
  syncError?: string;
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
  repo: WorkspaceMcpReadableRepo,
  workspaceId: WorkspaceId
): Promise<WorkspaceMcpServerMeta[]> {
  const handle = await repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
  return listWorkspaceMcpServers(readWorkspaceFlockRowsFromFlock(handle.flock));
}

/**
 * A catalog mutation is durable once it is flushed locally; the workspace sync
 * that follows is best effort and its failure is reported, never rolled back.
 */
async function commitCatalogChange(
  repo: WorkspaceMcpRepo,
  workspaceId: WorkspaceId,
  options: { sync?: boolean },
  mutate: (flock: WorkspaceFlockWritableFlock) => boolean
): Promise<McpCatalogWriteResult> {
  const handle = await repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
  if (!mutate(handle.flock)) {
    return { changed: false, synced: true };
  }
  await repo.flush();
  if (options.sync === false) {
    return { changed: true, synced: false, syncError: 'offline mode' };
  }
  try {
    await handle.syncOnce();
    return { changed: true, synced: true };
  } catch (error) {
    return { changed: true, synced: false, syncError: formatErrorMessage(error) };
  }
}

export async function upsertWorkspaceMcpCatalogEntry(
  repo: WorkspaceMcpRepo,
  workspaceId: WorkspaceId,
  entry: WorkspaceMcpServerMeta,
  options: { sync?: boolean } = {}
): Promise<McpCatalogWriteResult> {
  return commitCatalogChange(repo, workspaceId, options, (flock) =>
    writeWorkspaceMcpServerToFlock(flock, entry)
  );
}

export async function deleteWorkspaceMcpCatalogEntry(
  repo: WorkspaceMcpRepo,
  workspaceId: WorkspaceId,
  mcpServerId: McpServerId,
  options: { sync?: boolean } = {}
): Promise<McpCatalogWriteResult> {
  return commitCatalogChange(repo, workspaceId, options, (flock) =>
    deleteWorkspaceMcpServerFromFlock(flock, mcpServerId)
  );
}

/** Read a single ready workspace snapshot; explicit selections bypass defaults. */
export async function readProjectDefaultMcpIds(
  repo: WorkspaceMcpReadableRepo,
  workspaceId: WorkspaceId,
  project: ProjectRef | undefined,
  machineId: string
): Promise<McpServerId[]> {
  const handle = await repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
  const rows = readWorkspaceFlockRowsFromFlock(handle.flock);
  const key = getProjectMcpKey(project, machineId);
  return getEffectiveDefaultMcpIds(
    listWorkspaceMcpServers(rows),
    key ? getProjectMcpDefaults(rows)[key] : undefined
  );
}
