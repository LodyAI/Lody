import type {
  LocalProjectGitState,
  LocalProjectId,
  MachineId,
  MachineMeta,
  WorkspaceId,
} from '@lody/shared';
import {
  createChatLandingBranchSnapshot,
  resolveChatLandingBranchSelection,
} from './chat-landing-branches';

export function resolveLocalProjectBranchSelection(
  state: LocalProjectGitState,
  previousBranch: string | null
): string | null {
  if (!state.git) return null;
  return resolveChatLandingBranchSelection(
    createChatLandingBranchSnapshot(state.branches, state.defaultBranch),
    state.currentBranch ?? previousBranch
  );
}

export function getLocalProjectBranchLabel(
  branchSelector: string,
  labels: { local: string; remote: string }
): string {
  const localPrefix = 'lody:branch:local:';
  const remotePrefix = 'lody:branch:remote:';
  try {
    if (branchSelector.startsWith(localPrefix)) {
      const branchName = decodeURIComponent(branchSelector.slice(localPrefix.length));
      return `${branchName} (${labels.local})`;
    }
    if (branchSelector.startsWith(remotePrefix)) {
      const encoded = branchSelector.slice(remotePrefix.length);
      const separator = encoded.indexOf(':');
      if (separator < 0) return branchSelector;
      const remoteName = decodeURIComponent(encoded.slice(0, separator));
      const branchName = decodeURIComponent(encoded.slice(separator + 1));
      return `${remoteName}/${branchName} (${labels.remote})`;
    }
  } catch {
    return branchSelector;
  }
  return branchSelector;
}

export function getLocalProjectWorktreeAvailability(state: LocalProjectGitState | null): boolean {
  return state?.git === true && state.branches.length > 0;
}

export function getLocalProjectGitStateLoadKey(args: {
  workspaceId: WorkspaceId | null;
  machineId: MachineId | null;
  localProjectId: LocalProjectId | null;
  userId: string | null;
  machineOnline: boolean;
  retryNonce: number;
  hasRuntime: boolean;
  hasDesktopControl: boolean;
}): string | null {
  if (!args.workspaceId || !args.machineId || !args.localProjectId) return null;
  const loader = args.hasDesktopControl ? 'desktop' : args.hasRuntime ? 'runtime' : 'none';
  return [
    args.workspaceId,
    args.machineId,
    args.localProjectId,
    args.userId ?? 'missing-user',
    args.machineOnline ? 'online' : 'offline',
    loader,
    args.retryNonce,
  ].join(':');
}

/**
 * Returns true when the chat-landing Git-state fetch should fail fast with an
 * "offline" error instead of waiting on the workspace RPC to time out.
 *
 * Two non-obvious choices encoded here:
 *  - The visible local machine is treated as always reachable; the in-process
 *    handler / Electron fast path take over before any heartbeat check matters.
 *  - An *unknown* target machine (not yet in the workspace map) does NOT
 *    short-circuit. The workspace meta room may still be bootstrapping, and a
 *    false-positive offline error during initial sync is worse than letting
 *    the single 30s RPC timeout run. An unsynced presence room is unknown in
 *    the same way: only a synced room proves a missing heartbeat means offline.
 */
export function isLocalProjectMachineOffline(args: {
  projectMachineId: MachineId;
  visibleLocalMachineId: MachineId | null;
  targetMachine: MachineMeta | undefined;
  /** Whether the presence room is synced, so a missing heartbeat is meaningful. */
  presenceSynced: boolean;
  /** Presence-based machine liveness (see useMachineOnlineStatus). */
  isMachineOnline: (machineId: MachineId) => boolean;
}): boolean {
  if (args.visibleLocalMachineId === args.projectMachineId) return false;
  if (!args.targetMachine) return false;
  return args.presenceSynced && !args.isMachineOnline(args.projectMachineId);
}
