import {
  buildAgentMessageAuthor,
  findAcpCapabilityModelName,
  getStaticBuiltinAcpCapabilities,
  resolveAgentBrandId,
  getWorkspaceFlockDocId,
  listWorkspaceAgentRoles,
  snapshotAgentRole,
  readWorkspaceFlockRowsFromFlock,
  type AgentConfigMeta,
  type AgentMessageAuthor,
  type ModelInfo,
  type SessionMeta,
  type SessionTurnInputConfig,
  type WorkspaceId,
} from '@lody/shared';
import { readMachineAcpCapabilityById } from '@/lib/agent-config-machine-flock';
import type { LoroDocumentManager } from '@/lib/loro/doc';

export async function resolveSessionModelDisplayName(
  manager: LoroDocumentManager,
  session: SessionMeta,
  modelId: string | undefined,
  workspaceId?: WorkspaceId,
  config?: Pick<AgentConfigMeta, 'cliType' | 'agentType' | 'runtimeOverrides'> | null
): Promise<string | undefined> {
  const targetModelId = modelId?.trim();
  if (!targetModelId) return undefined;

  if (session.agentConfigId && session.machineId && workspaceId && manager.repo) {
    try {
      const capability = await readMachineAcpCapabilityById(
        manager.repo,
        workspaceId,
        session.machineId,
        session.agentConfigId
      );
      const cachedName = findAcpCapabilityModelName(capability, targetModelId);
      if (cachedName) return cachedName;
    } catch {}
  }

  const cliType = config?.cliType ?? session.cliType;
  const agentType = config?.agentType ?? session.agentType;
  if (cliType && agentType) {
    const staticCapability = getStaticBuiltinAcpCapabilities(
      cliType,
      agentType,
      config?.runtimeOverrides
    );
    return findAcpCapabilityModelName(staticCapability, targetModelId);
  }
  return undefined;
}

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
  const configuredModelId =
    inputConfig?.modelId ??
    (typeof inputConfig?.configOptionValues?.model === 'string'
      ? inputConfig.configOptionValues.model
      : undefined);
  const targetModelId = modelInfo?.modelId?.trim() || configuredModelId?.trim();
  const needsModelNameLookup =
    Boolean(targetModelId) && (!modelInfo?.name?.trim() || modelInfo.name.trim() === targetModelId);
  const modelName = needsModelNameLookup
    ? await resolveSessionModelDisplayName(manager, session, targetModelId, workspaceId, config)
    : undefined;
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
    modelName,
    role,
  });
}
