import {
  getMachineFlockAcpCapabilities,
  getMachineFlockDocId,
  getWorkspaceFlockDocId,
  isMachineDocRoomId,
  listWorkspaceAgentRoles,
  readMachineFlockRowsFromFlock,
  readWorkspaceFlockRowsFromFlock,
  type MachineId,
  type MachineMeta,
  type WorkspaceId,
} from '@lody/shared';
import { listAliveDocMetas, syncWorkspaceMetaForRead, type AuthContext } from './command-runtime';
import type { LoroDocumentManager } from './loro/doc';
import { readSessionMachineAccess, type DelegatedSessionRequester } from '@/commands/session';
import { listMergedAgentConfigs } from './agent-config-machine-flock';
import { readMachineLocalProjects } from './local-project-meta';
import { listWorkspaceGitHubRepositoriesForCliToken } from './workspace';
import { listWorkspaceMcpCatalog } from './workspace-mcp-store';
import { ResourceDiscovery } from './resource-discovery';
import { getCliPlatformKind } from './cli-platform';
import { getSessionCommandEnvironment } from './session-command-environment';

export async function createResourceDiscovery(args: {
  manager: LoroDocumentManager;
  auth: AuthContext;
  workspaceId: WorkspaceId;
  delegatedRequester?: DelegatedSessionRequester;
  selectedMcpServerIds?: readonly string[];
  offline?: boolean;
}): Promise<ResourceDiscovery> {
  const { manager, auth, workspaceId } = args;
  if (!args.offline) await syncWorkspaceMetaForRead(manager, 'resource.discovery');
  const synced = new Set<string>();
  async function sync(id: string) {
    if (!args.offline && !synced.has(id)) {
      await manager.syncFlockDocOrThrow(id, { reason: 'resource.discovery' });
      synced.add(id);
    }
  }
  return new ResourceDiscovery({
    workspaceId,
    userId: args.delegatedRequester?.userId ?? auth.userId,
    selectedMcpServerIds: args.selectedMcpServerIds,
    machines: async () =>
      (await listAliveDocMetas<MachineMeta>(manager, isMachineDocRoomId)).map((row) => row.meta),
    onlineMachineIds: async () =>
      getSessionCommandEnvironment()
        ? new Set([auth.machineId])
        : args.offline
          ? null
          : manager.getOnlineMachineIds(),
    canAccess: async (machineId, localProjectId) =>
      (
        await readSessionMachineAccess({
          auth,
          workspaceId,
          machineId,
          delegatedRequester: args.delegatedRequester,
          localProjectId,
        })
      ).allowed,
    configs: async (machineId) => {
      await sync(getMachineFlockDocId(workspaceId, machineId));
      return listMergedAgentConfigs(manager.repo, workspaceId, [machineId]);
    },
    capabilities: async (machineId: MachineId) => {
      const id = getMachineFlockDocId(workspaceId, machineId);
      await sync(id);
      const handle = await manager.repo.openFlockDoc(id);
      return getMachineFlockAcpCapabilities(readMachineFlockRowsFromFlock(handle.flock));
    },
    projects: async (machineId) => {
      await sync(getMachineFlockDocId(workspaceId, machineId));
      return Object.values(await readMachineLocalProjects(manager.repo, workspaceId, machineId));
    },
    roles: async () => {
      const id = getWorkspaceFlockDocId(workspaceId);
      await sync(id);
      const handle = await manager.repo.openFlockDoc(id);
      return listWorkspaceAgentRoles(readWorkspaceFlockRowsFromFlock(handle.flock));
    },
    mcpServers: async () => {
      await sync(getWorkspaceFlockDocId(workspaceId));
      return listWorkspaceMcpCatalog(manager.repo, workspaceId);
    },
    repositories: async () => {
      if (getCliPlatformKind() === 'local') return [];
      if (args.offline)
        throw new Error(
          'GitHub repository discovery requires an online query; use --kind local with --offline.'
        );
      return listWorkspaceGitHubRepositoriesForCliToken({
        token: auth.token,
        workspaceId,
        requesterUserId: args.delegatedRequester?.userId ?? auth.userId,
        enabledOnly: true,
      });
    },
  });
}
