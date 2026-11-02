import {
  getProjectMcpKey,
  getWorkspaceFlockDocId,
  normalizeProjectMcpDefault,
  serializeAgentRoleRow,
  assertPublicMcpServer,
  workspaceFlockKeys,
  type AgentRole,
  type AgentRoleId,
  type McpServerId,
  type ProjectId,
  type ProjectRef,
  type WorkspaceId,
  type WorkspaceMcpServerMeta,
  type WorkspaceProject,
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
): Promise<void> => {
  assertPublicMcpServer(entry);
  return putRow(deps, workspaceFlockKeys.mcpServer(entry.id), entry);
};

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

/** Write a Project group — created or edited. Each content change bumps `revision`. */
export const writeWorkspaceProject = (
  deps: WorkspaceCatalogWriteDeps,
  project: WorkspaceProject
): Promise<void> => putRow(deps, workspaceFlockKeys.project(project.id), project);

export const deleteWorkspaceProject = (
  deps: WorkspaceCatalogWriteDeps,
  id: ProjectId
): Promise<void> => deleteRow(deps, workspaceFlockKeys.project(id));
/**
 * Who may manage a project's defaults, resolved from live state by the caller
 * at the moment of the write — never from whether a switch was enabled.
 *
 * A local project belongs to its machine's owner (the same rule that owns
 * adding and removing it); a GitHub project to any member of the workspace the
 * repository is connected to.
 */
export type ProjectMcpDefaultAccess =
  | { kind: 'local'; currentUserId: string | null; machineOwnerUserId: string | null }
  | { kind: 'github'; currentUserId: string | null; repoInWorkspace: boolean };

/** The project a default belongs to; `machineId` identifies a local project only. */
export type ProjectMcpDefaultTarget = {
  workspaceId: WorkspaceId;
  project: ProjectRef;
  machineId?: string | null;
};

export type ProjectMcpDefaultManagement =
  | { kind: 'manage'; projectKey: string }
  | { kind: 'read_only'; reason: 'signed_out' | 'not_owner' | 'not_in_workspace' | 'no_project' };

export const resolveProjectMcpDefaultManagement = (
  target: Pick<ProjectMcpDefaultTarget, 'project' | 'machineId'>,
  access: ProjectMcpDefaultAccess
): ProjectMcpDefaultManagement => {
  const projectKey = getProjectMcpKey(target.project, target.machineId);
  if (!projectKey || access.kind !== target.project.kind) {
    return { kind: 'read_only', reason: 'no_project' };
  }
  if (!access.currentUserId) return { kind: 'read_only', reason: 'signed_out' };
  if (access.kind === 'local') {
    return access.machineOwnerUserId === access.currentUserId
      ? { kind: 'manage', projectKey }
      : { kind: 'read_only', reason: 'not_owner' };
  }
  return access.repoInWorkspace
    ? { kind: 'manage', projectKey }
    : { kind: 'read_only', reason: 'not_in_workspace' };
};

export class ProjectMcpDefaultWriteError extends Error {
  constructor(readonly code: 'forbidden' | 'workspace_mismatch' | 'invalid_selection') {
    super(`Project default MCP write rejected: ${code}`);
    this.name = 'ProjectMcpDefaultWriteError';
  }
}

/**
 * Replace a project's whole default selection; `[]` turns every server off.
 *
 * Authority, workspace scope and the selection are checked here, at the write,
 * so a stale or forged call cannot land a row a disabled switch would have
 * refused. Like every catalog write it resolves on local durability and the
 * upload that follows can neither fail nor roll it back.
 */
export const putProjectMcpDefault = async (
  deps: WorkspaceCatalogWriteDeps,
  target: ProjectMcpDefaultTarget,
  access: ProjectMcpDefaultAccess,
  ids: readonly McpServerId[]
): Promise<void> => {
  if (target.workspaceId !== deps.workspaceId) {
    throw new ProjectMcpDefaultWriteError('workspace_mismatch');
  }
  const management = resolveProjectMcpDefaultManagement(target, access);
  if (management.kind !== 'manage') throw new ProjectMcpDefaultWriteError('forbidden');
  const value = normalizeProjectMcpDefault({ ids });
  if (!value) throw new ProjectMcpDefaultWriteError('invalid_selection');
  await putRow(deps, workspaceFlockKeys.projectMcpDefault(management.projectKey), value);
};
