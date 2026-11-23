import { AsyncLocalStorage } from 'node:async_hooks';
import {
  getMachineRoomId,
  isLoroRepoDocDeleted,
  type MachineId,
  type MachineMeta,
  type WorkspaceId,
  type SessionId,
  type SessionActiveInvocationContextResult,
  type SessionSteerResponse,
  type SessionTurnInputConfig,
} from '@lody/shared';
import type { AuthContext } from './command-runtime';
import type { LoroDocumentManager } from './loro/doc';
import type { MachineAccessCheckResult, WorkspaceSummary } from './workspace';
import { readMachineLocalProjects } from './local-project-meta';
import type { SessionLiveStatusBatchItem } from '@/commands/session';
import type { SessionWithdrawInputResponse } from '@lody/shared/local-machine-rpc';

export interface SessionCommandHost {
  readInvocation(sessionId: SessionId): SessionActiveInvocationContextResult;
  readLiveStatus(sessionId: SessionId): Promise<SessionLiveStatusBatchItem>;
  /** Best-effort withdrawal of a queued Agent input this daemon has not started. */
  withdrawQueuedInput(args: {
    sessionId: SessionId;
    userTurnId: string;
    requesterSessionId: SessionId;
  }): Promise<SessionWithdrawInputResponse>;
  /** The running turn an Agent chat may steer; undefined unless it runs on this daemon. */
  readActiveTurnId(sessionId: SessionId): string | undefined;
  steerSession(input: {
    sessionId: SessionId;
    expectedTurnId: string;
    userTurnId: string;
    userId: string;
    timestamp: string;
    inputConfig: SessionTurnInputConfig;
  }): Promise<SessionSteerResponse>;
  cancelSession(
    sessionId: SessionId,
    turnId?: string
  ): Promise<{ success: boolean; error?: string }>;
  dispatchSession(
    sessionId: SessionId,
    input?: {
      inputId: string;
      userId: string;
      config: SessionTurnInputConfig;
      inputOrigin: 'human' | 'agent';
    }
  ): Promise<void>;
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

/**
 * The daemon's current verdict on its own workspace, read from the access state
 * it already maintains (remote subscription, else the cached bootstrap entry).
 * `unknown` means the daemon has no verdict, so commands fall back to discovery.
 */
export type DaemonWorkspaceAccess =
  | { status: 'authorized'; workspace: WorkspaceSummary }
  | { status: 'revoked' }
  | { status: 'unauthorized' }
  | { status: 'unknown' };

/**
 * The daemon's own workspace replica, lent to a command the daemon executes.
 * It changes only which replica a command uses; platform behavior is unchanged.
 * The daemon owns its lifecycle, so a borrowing command never cleans it up.
 */
export type DaemonLocalSessionHost = Pick<
  SessionCommandHost,
  'readActiveTurnId' | 'steerSession' | 'dispatchSession'
>;

export interface DaemonWorkspace {
  workspaceId: WorkspaceId;
  userId: string;
  machineId: MachineId;
  manager: LoroDocumentManager;
  readInvocation(sessionId: SessionId): SessionActiveInvocationContextResult;
  readAccess?(): DaemonWorkspaceAccess;
  host?: DaemonLocalSessionHost;
  wakeOperations?(): void;
  /**
   * Encrypted only: classify an Agent-delegated input by its verified driving Turn.
   * Same-machine delegation returns the verified principal and human root. Machine-owned
   * inputs and cross-machine Owner delegation return `owner` without local provenance.
   * Members require a live driving turn; accepted writes reserve once per target input ID.
   */
  classifyEncryptedDerivation?(
    origin: { sessionId: string; userTurnId: string },
    target: { machineId: string; userTurnId: string }
  ): Promise<
    'owner' | { principal: 'owner' | 'member'; origin: { sessionId: string; userTurnId: string } }
  >;
  /** Encrypted only: machine access decided locally, without the workspace service. */
  checkEncryptedMachineAccess?(target: {
    machineId: string;
    requesterUserId: string;
    localProjectId?: string;
  }): Promise<MachineAccessCheckResult>;
}

export type DaemonTargetAuthority = 'local-daemon' | 'remote-or-unverified' | 'denied';

export type DaemonTargetResolution = {
  sameReplica: boolean;
  isLocalEnvironment: boolean;
  localHost?: DaemonLocalSessionHost;
  authority: DaemonTargetAuthority;
  nativeOwnerAccess: boolean | undefined;
};

/**
 * Single binding and local-authority resolver for daemon-hosted commands.
 * `sameReplica` / `localHost` require matching manager, workspace, machine, optional auth,
 * and non-revoked/non-unknown daemon access. `authority` / `nativeOwnerAccess` additionally
 * verify requester ownership (or encrypted workspace authority) when `requesterUserId` is given.
 */
export async function resolveDaemonTarget(args: {
  manager: unknown;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  auth?: Pick<AuthContext, 'userId' | 'machineId'>;
  requesterUserId?: string;
}): Promise<DaemonTargetResolution> {
  const isLocalEnvironment = getSessionCommandEnvironment() !== undefined;
  const daemon = getDaemonWorkspace();
  const bindingMatches = Boolean(
    daemon &&
    daemon.manager === args.manager &&
    daemon.workspaceId === args.workspaceId &&
    daemon.machineId === args.machineId &&
    (!args.auth || (daemon.userId === args.auth.userId && daemon.machineId === args.auth.machineId))
  );

  if (isLocalEnvironment) {
    const requesterMatches =
      args.requesterUserId === undefined || args.requesterUserId === daemon?.userId;
    return {
      sameReplica: bindingMatches,
      isLocalEnvironment: true,
      ...(bindingMatches && daemon?.host ? { localHost: daemon.host } : {}),
      authority: bindingMatches && requesterMatches ? 'local-daemon' : 'denied',
      nativeOwnerAccess: undefined,
    };
  }

  if (!daemon || !bindingMatches) {
    return {
      sameReplica: false,
      isLocalEnvironment: false,
      authority: 'remote-or-unverified',
      nativeOwnerAccess: undefined,
    };
  }

  const accessStatus = daemon.readAccess?.().status;
  if (accessStatus === 'revoked' || accessStatus === 'unauthorized') {
    return {
      sameReplica: false,
      isLocalEnvironment: false,
      authority: 'denied',
      nativeOwnerAccess:
        args.requesterUserId !== undefined && !daemon.manager.isEncryptedWorkspace()
          ? false
          : undefined,
    };
  }
  if (accessStatus === 'unknown') {
    return {
      sameReplica: false,
      isLocalEnvironment: false,
      authority: 'remote-or-unverified',
      nativeOwnerAccess: undefined,
    };
  }

  const base = {
    sameReplica: true,
    isLocalEnvironment: false,
    ...(daemon.host ? { localHost: daemon.host } : {}),
  };
  if (args.requesterUserId === undefined) {
    return {
      ...base,
      authority: 'remote-or-unverified',
      nativeOwnerAccess: undefined,
    };
  }
  if (daemon.manager.isEncryptedWorkspace()) {
    return {
      ...base,
      authority: 'local-daemon',
      nativeOwnerAccess: undefined,
    };
  }
  if (args.requesterUserId !== daemon.userId) {
    return {
      ...base,
      authority: 'remote-or-unverified',
      nativeOwnerAccess: undefined,
    };
  }
  const row = await daemon.manager.repo.getDocMeta(getMachineRoomId(args.machineId));
  const machineOwnerMatchesDaemon = Boolean(
    row && !isLoroRepoDocDeleted(row) && (row.meta as MachineMeta).ownerUserId === daemon.userId
  );
  return {
    ...base,
    authority: machineOwnerMatchesDaemon ? 'local-daemon' : 'remote-or-unverified',
    nativeOwnerAccess: machineOwnerMatchesDaemon ? true : undefined,
  };
}

/** A one-shot command's own encrypted replica decides machine access for that command. */
export type EncryptedCommandAccess = NonNullable<DaemonWorkspace['checkEncryptedMachineAccess']>;
const encryptedCommandAccess = new AsyncLocalStorage<EncryptedCommandAccess>();
export const runWithEncryptedCommandAccess = <T>(access: EncryptedCommandAccess, run: () => T): T =>
  encryptedCommandAccess.run(access, run);

const encryptedCommandManagers = new AsyncLocalStorage<{
  workspaceId: string;
  manager: LoroDocumentManager;
}>();
/** A one-shot command lends the encrypted workspace manager it opened. */
export const runWithEncryptedCommandManager = <T>(
  owner: { workspaceId: string; manager: LoroDocumentManager },
  run: () => T
): T => encryptedCommandManagers.run(owner, run);
/** The encrypted manager this process holds for `workspaceId`, daemon or one-shot. Its
 * feature channel is the only Machine RPC; callers never fall back to plaintext. */
export const resolveEncryptedMachineRpc = (
  workspaceId: string
): LoroDocumentManager | undefined => {
  const daemon = getDaemonWorkspace();
  if (daemon?.workspaceId === workspaceId && daemon.manager.isEncryptedWorkspace())
    return daemon.manager;
  const command = encryptedCommandManagers.getStore();
  return command?.workspaceId === workspaceId ? command.manager : undefined;
};

const daemonWorkspaces = new AsyncLocalStorage<DaemonWorkspace>();
export const runWithDaemonWorkspace = <T>(workspace: DaemonWorkspace, run: () => T): T =>
  daemonWorkspaces.run(workspace, run);
/** Encrypted machine access from this process's own ledger, in a daemon or a one-shot command. */
export const readEncryptedMachineAccess = (target: Parameters<EncryptedCommandAccess>[0]) =>
  (getDaemonWorkspace()?.checkEncryptedMachineAccess ?? encryptedCommandAccess.getStore())?.(
    target
  );

/** A local environment is itself a daemon workspace. */
export const getDaemonWorkspace = (): DaemonWorkspace | undefined => {
  const environment = environments.getStore();
  if (!environment) return daemonWorkspaces.getStore();
  return {
    workspaceId: environment.workspace.id as WorkspaceId,
    userId: environment.auth.userId,
    machineId: environment.auth.machineId,
    manager: environment.manager,
    readInvocation: (sessionId) => environment.host.readInvocation(sessionId),
    host: environment.host,
  };
};

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

/** Exact human driving this command; a cached backend must read it for each operation. */
export type SessionHistoryRequester = { userId: string; machineId: string };
const historyRequesters = new AsyncLocalStorage<SessionHistoryRequester>();
export const getSessionHistoryRequester = () => historyRequesters.getStore();
export const runWithSessionHistoryRequester = <T>(
  requester: SessionHistoryRequester,
  run: () => T
): T => historyRequesters.run(requester, run);
