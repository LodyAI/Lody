import { AsyncLocalStorage } from 'node:async_hooks';
import {
  getMachineRoomId,
  isLoroRepoDocDeleted,
  type MachineId,
  type MachineMeta,
  type WorkspaceId,
  type SessionId,
  type SessionActiveInvocationContextResult,
} from '@lody/shared';
import type { AuthContext } from './command-runtime';
import type { LoroDocumentManager } from './loro/doc';
import type { MachineAccessCheckResult, WorkspaceSummary } from './workspace';
import { readMachineLocalProjects } from './local-project-meta';
import type { SessionLiveStatusBatchItem } from '@/commands/session';

export interface SessionCommandHost {
  readInvocation(sessionId: SessionId): SessionActiveInvocationContextResult;
  readLiveStatus(sessionId: SessionId): Promise<SessionLiveStatusBatchItem>;
  cancelSession(
    sessionId: SessionId,
    turnId?: string
  ): Promise<{ success: boolean; error?: string }>;
  dispatchSession(sessionId: SessionId): Promise<void>;
}

/** A daemon-owned workspace, never a second replica opened by an MCP process. */
export interface SessionCommandEnvironment {
  auth: AuthContext;
  workspace: WorkspaceSummary;
  manager: LoroDocumentManager;
  host: SessionCommandHost;
  checkMachineAccess(args: {
    workspaceId: WorkspaceId;
    machineId: MachineId;
    requesterUserId: string;
    localProjectId?: string;
  }): Promise<MachineAccessCheckResult>;
}

const environments = new AsyncLocalStorage<SessionCommandEnvironment>();
export const getSessionCommandEnvironment = () => environments.getStore();
export const runWithSessionCommandEnvironment = <T>(
  environment: SessionCommandEnvironment,
  run: () => T
): T => environments.run(environment, run);

export function createLocalSessionCommandEnvironment(args: {
  manager: LoroDocumentManager;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  machineName: string;
  userId: string;
  host: SessionCommandHost;
}): SessionCommandEnvironment {
  const { manager, workspaceId, machineId, userId } = args;
  return {
    auth: {
      token: '',
      userId,
      userName: userId,
      userEmail: '',
      machineId,
      machineName: args.machineName,
    },
    workspace: { id: workspaceId, name: 'Lody', slug: 'local', role: 'owner' },
    manager,
    host: args.host,
    async checkMachineAccess(target) {
      if (target.workspaceId !== workspaceId || target.requesterUserId !== userId)
        return { allowed: false, reason: 'requester_not_member' };
      if (target.machineId !== machineId)
        return { allowed: false, reason: 'machine_not_registered' };
      const row = await manager.repo.getDocMeta(getMachineRoomId(machineId));
      if (
        !row?.meta ||
        isLoroRepoDocDeleted(row) ||
        (row.meta as MachineMeta).ownerUserId !== userId
      )
        return { allowed: false, reason: 'not_visible' };
      if (target.localProjectId) {
        const projects = await readMachineLocalProjects(manager.repo, workspaceId, machineId);
        const project = Object.values(projects).find((entry) => entry.id === target.localProjectId);
        if (!project) return { allowed: false, reason: 'project_not_shared' };
      }
      return { allowed: true };
    },
  };
}
