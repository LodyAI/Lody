import {
  getWorkspaceFlockDocId,
  serializeAgentRoleRow,
  workspaceFlockKeys,
  type AgentRole,
  type AgentRoleId,
  type McpServerId,
  type WorkspaceId,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';

/**
 * Catalog mutations: durable locally, shared optimistically.
 *
 * Every write resolves as soon as `flockRowPut`/`flockRowDelete` lands — that is
 * the point at which the row exists and the UI can move on. The explicit upload
 * still runs, but nobody waits for it and no surface reports it:
 *
 * - it is a round trip, and blocking an editor on it made a finished, already
 *   durable save sit there looking unfinished for seconds;
 * - failing it is not a failed save, and the old "saved on this device but not
 *   yet synced" banner said something the user could neither act on nor dismiss;
 * - the catalog room stays joined while any consumer is mounted, so a document
 *   this one-shot upload could not push reconciles on the room's own sync.
 *
 * What must never happen is the opposite: reporting a write as failed, or
 * rolling one back, because the upload did not go through.
 */

export type WorkspaceCatalogWriteDeps = {
  workspaceId: WorkspaceId;
  writer: Pick<WorkspaceRuntime['writer'], 'flockRowPut' | 'flockRowDelete'>;
  repo: Pick<WorkspaceRuntime['repo'], 'openFlockDoc'>;
};

/**
 * Push the committed document to the workspace, best effort.
 *
 * Never rejects: a caller has already made its change durable, and there is
 * nothing for it — or the user — to do about a failed upload but let the room
 * carry it later.
 */
export const uploadWorkspaceCatalog = async (deps: WorkspaceCatalogWriteDeps): Promise<void> => {
  try {
    const handle = await deps.repo.openFlockDoc(getWorkspaceFlockDocId(deps.workspaceId));
    await handle.syncOnce();
  } catch (error) {
    console.warn('Workspace catalog upload deferred to room sync', error);
  }
};

/** Durable write, then an upload nobody waits on. */
const putRow = async (
  deps: WorkspaceCatalogWriteDeps,
  key: Parameters<WorkspaceRuntime['writer']['flockRowPut']>[1],
  value: unknown
): Promise<void> => {
  await deps.writer.flockRowPut(getWorkspaceFlockDocId(deps.workspaceId), key, value);
  void uploadWorkspaceCatalog(deps);
};

const deleteRow = async (
  deps: WorkspaceCatalogWriteDeps,
  key: Parameters<WorkspaceRuntime['writer']['flockRowDelete']>[1]
): Promise<void> => {
  await deps.writer.flockRowDelete(getWorkspaceFlockDocId(deps.workspaceId), key);
  void uploadWorkspaceCatalog(deps);
};

export const putWorkspaceMcpServer = (
  deps: WorkspaceCatalogWriteDeps,
  entry: WorkspaceMcpServerMeta
): Promise<void> => putRow(deps, workspaceFlockKeys.mcpServer(entry.id), entry);

export const deleteWorkspaceMcpServer = (
  deps: WorkspaceCatalogWriteDeps,
  id: McpServerId
): Promise<void> => deleteRow(deps, workspaceFlockKeys.mcpServer(id));

/**
 * Write a Role — created, edited, shared, or unshared.
 *
 * Sharing is this same call: `visibility` lives on the row, so the whole catalog
 * stays one family and no state exists where a Role is in both directories or
 * neither. The stored shape is the serializer's: v1 for a single-target Role,
 * v2 — which older clients skip rather than rewrite — once it has several.
 */
export const writeWorkspaceAgentRole = (
  deps: WorkspaceCatalogWriteDeps,
  role: AgentRole
): Promise<void> =>
  putRow(deps, workspaceFlockKeys.agentRole(role.id), serializeAgentRoleRow(role));

export const deleteWorkspaceAgentRole = (
  deps: WorkspaceCatalogWriteDeps,
  id: AgentRoleId
): Promise<void> => deleteRow(deps, workspaceFlockKeys.agentRole(id));
