import {
  buildAgentMessageAuthor,
  resolveAgentBrandId,
  getWorkspaceFlockDocId,
  listWorkspaceAgentRoles,
  snapshotAgentRole,
  readWorkspaceFlockRowsFromFlock,
  type AgentMessageAuthor,
  type ModelInfo,
  type SessionMeta,
  type SessionTurnInputConfig,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroDocumentManager } from '@/lib/loro/doc';

/** Once per execution/acceptance, using local catalogs only; never on token updates. */
export async function resolveSessionMessageAuthor(
  manager: LoroDocumentManager,
  session: SessionMeta,
  turnId: string,
  inputConfig: SessionTurnInputConfig | undefined,
  modelInfo?: ModelInfo,
  workspaceId?: WorkspaceId
): Promise<AgentMessageAuthor> {
  const config = session.agentConfigId
    ? await manager.getAgentConfigById(session.agentConfigId, session.machineId)
    : undefined;
  const roleId = inputConfig?.agentRoleId;
  let role =
    inputConfig?.agentRoleSnapshot?.id === roleId &&
    inputConfig?.agentRoleSnapshot?.revision === inputConfig?.agentRoleRevision
      ? inputConfig?.agentRoleSnapshot
      : undefined;
  if (!role && roleId && workspaceId) {
    const handle = await manager.repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
    const matchedRole = listWorkspaceAgentRoles(readWorkspaceFlockRowsFromFlock(handle.flock)).find(
      (candidate) =>
        candidate.id === roleId &&
        candidate.revision === inputConfig?.agentRoleRevision &&
        candidate.machineId === session.machineId &&
        candidate.agentConfigId === session.agentConfigId
    );
    role = matchedRole ? snapshotAgentRole(matchedRole) : undefined;
  }
  return buildAgentMessageAuthor({
    sessionId: session.id,
    turnId,
    agentConfigId: session.agentConfigId,
    cliType: inputConfig?.cliType ?? config?.cliType ?? session.cliType,
    agentType: inputConfig?.agentType ?? config?.agentType ?? session.agentType,
    name: config?.name,
    brandId: config ? (resolveAgentBrandId(config) ?? undefined) : undefined,
    inputConfig,
    modelInfo,
    role,
  });
}
