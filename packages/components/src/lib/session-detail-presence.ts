import type { MachineId, WorkspaceId } from '@lody/shared';
import type { LodyControlConnectionState } from '@/atoms/control-connection';
import { resolveSessionVisibilityState, type SessionMachineRecord } from './session-visibility';

export type SessionDetailPresenceState = 'loading' | 'resolved' | 'not-found';

export function resolveSessionDetailVisibilityState(args: {
  baseState: SessionDetailPresenceState;
  session: SessionMachineRecord | null;
  visibleMachineIds: ReadonlySet<MachineId>;
  visibleLocalProjectKeys: ReadonlySet<string>;
  machineVisibilityLoading: boolean;
  localProjectVisibilityLoading: boolean;
  currentUserId?: string | null;
  ownedMachineIds?: ReadonlySet<MachineId>;
}): SessionDetailPresenceState {
  const { baseState, session } = args;
  if (baseState !== 'resolved' || !session || typeof session.machineId !== 'string') {
    return baseState;
  }

  const visibilityState = resolveSessionVisibilityState(
    session,
    args.visibleMachineIds,
    args.visibleLocalProjectKeys,
    {
      machineVisibilityLoading: args.machineVisibilityLoading,
      localProjectVisibilityLoading: args.localProjectVisibilityLoading,
      currentUserId: args.currentUserId,
      ownedMachineIds: args.ownedMachineIds,
    }
  );
  if (visibilityState === 'loading') return 'loading';
  return visibilityState === 'visible' ? 'resolved' : 'not-found';
}

export function resolveSessionDetailPresenceState(args: {
  hasActiveSession: boolean;
  docMetaCacheReady: boolean;
  runtimeInitializing: boolean;
  runtimeWorkspaceId: WorkspaceId | null;
  currentWorkspaceId: WorkspaceId | null;
  controlConnectionState: LodyControlConnectionState;
}): SessionDetailPresenceState {
  const {
    hasActiveSession,
    docMetaCacheReady,
    runtimeInitializing,
    runtimeWorkspaceId,
    currentWorkspaceId,
    controlConnectionState,
  } = args;

  // Session found in local cache — render immediately, no network needed.
  if (hasActiveSession) {
    return 'resolved';
  }

  // Local data not ready yet (IndexedDB scan in progress).
  if (!docMetaCacheReady || runtimeInitializing) {
    return 'loading';
  }

  // Workspace mismatch — runtime is switching workspaces.
  if (!currentWorkspaceId || !runtimeWorkspaceId) {
    return 'loading';
  }

  if (runtimeWorkspaceId !== currentWorkspaceId) {
    return 'loading';
  }

  // Session not in local cache. Wait for remote metadata sync before
  // concluding "not-found" — the session may exist on the server
  // (e.g. shared link, first visit from another device).
  if (controlConnectionState !== 'online' && controlConnectionState !== 'reconnecting') {
    return 'loading';
  }

  return 'not-found';
}
