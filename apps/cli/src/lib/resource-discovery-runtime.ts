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
import {
  listAliveDocMetas,
  syncWorkspaceMetaForRead,
  WorkspaceSyncUnavailableError,
  type AuthContext,
} from './command-runtime';
import type { LoroDocumentManager } from './loro/doc';
import { readSessionMachineAccess, type DelegatedSessionRequester } from '@/commands/session';
import { listMergedAgentConfigs } from './agent-config-machine-flock';
import { readMachineLocalProjects } from './local-project-meta';
import { listWorkspaceGitHubRepositoriesForCliToken } from './workspace';
import { listWorkspaceMcpCatalog } from './workspace-mcp-store';
import { ResourceDiscovery } from './resource-discovery';
import { getCliPlatformKind } from './cli-platform';
import { getDaemonWorkspace, getSessionCommandEnvironment } from './session-command-environment';

export async function createResourceDiscovery(args: {
  manager: LoroDocumentManager;
  auth: AuthContext;
  workspaceId: WorkspaceId;
  delegatedRequester?: DelegatedSessionRequester;
  selectedMcpServerIds?: readonly string[];
  offline?: boolean;
  requireFreshCatalogs?: boolean;
  initialCatalogWaitMs?: number;
}): Promise<ResourceDiscovery> {
  const { manager, auth, workspaceId } = args;
  // The daemon owns ongoing synchronization. Discovery reads its current replica
  // without making catalog availability depend on another remote catch-up.
  const isDaemon = getDaemonWorkspace()?.manager === manager;
  const shouldSync = args.offline !== true && (!isDaemon || args.requireFreshCatalogs === true);
  if (shouldSync) await syncWorkspaceMetaForRead(manager, 'resource.discovery');
  const synced = new Set<string>();
  const baselines = new Map<string | undefined, boolean>();
  const machineBaselines = new Map<MachineId, boolean>();
  const deadline = performance.now() + (args.offline ? 0 : (args.initialCatalogWaitMs ?? 1_000));
  async function baseline(id: string | undefined) {
    if (!isDaemon || shouldSync || baselines.has(id)) return;
    baselines.set(
      id,
      await manager.catalogBaselineReady(id, Math.max(0, deadline - performance.now()))
    );
  }
  async function sync(id: string) {
    // First-baseline waits share one request budget. Timeout keeps the daemon
    // reader alive and this request unconfirmed, even if later reads catch up.
    if (isDaemon && !shouldSync) {
      await manager.holdCatalogFlockDoc(id);
      await baseline(id);
    }
    if (shouldSync && !synced.has(id)) {
      try {
        await manager.syncFlockDocOrThrow(id, {
          reason: 'resource.discovery',
          requireRemoteConfirmation: args.requireFreshCatalogs === true,
        });
      } catch (cause) {
        if (!args.requireFreshCatalogs) throw cause;
        throw new WorkspaceSyncUnavailableError({
          message: 'Target catalog synchronization is unavailable; retry the request.',
          cause,
        });
      }
      synced.add(id);
    }
  }
  return new ResourceDiscovery({
    workspaceId,
    userId: args.delegatedRequester?.userId ?? auth.userId,
    selectedMcpServerIds: args.selectedMcpServerIds,
    machines: async () => {
      await baseline(undefined);
      return (await listAliveDocMetas<MachineMeta>(manager, isMachineDocRoomId)).map(
        (row) => row.meta
      );
    },
    catalogReadiness: () => ({
      metadata: baselines.get(undefined) !== false,
      workspace: baselines.get(getWorkspaceFlockDocId(workspaceId)) !== false,
      machines: machineBaselines,
    }),
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
      machineBaselines.set(
        machineId,
        baselines.get(getMachineFlockDocId(workspaceId, machineId)) !== false
      );
      return listMergedAgentConfigs(manager.repo, workspaceId, [machineId]);
    },
    capabilities: async (machineId: MachineId) => {
      const id = getMachineFlockDocId(workspaceId, machineId);
      await sync(id);
      machineBaselines.set(machineId, baselines.get(id) !== false);
      const handle = await manager.repo.openFlockDoc(id);
      return getMachineFlockAcpCapabilities(readMachineFlockRowsFromFlock(handle.flock));
    },
    projects: async (machineId) => {
      await sync(getMachineFlockDocId(workspaceId, machineId));
      machineBaselines.set(
        machineId,
        baselines.get(getMachineFlockDocId(workspaceId, machineId)) !== false
      );
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
