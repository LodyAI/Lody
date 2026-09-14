import type { LocalProjectId, MachineId } from '@lody/shared';
import type { LocalProjectVisibilityAccess } from './visible-local-project-index';
import type { MachineVisibilityAccess } from './visible-machine-index';

export type SessionSharingPrivateReason =
  | 'machine'
  | 'project'
  | 'machine-and-project'
  | 'machine-not-registered';

export type SessionSharingState = {
  visibility: 'unknown' | 'private' | 'team';
  privateReason?: SessionSharingPrivateReason;
  canManage: boolean;
  machineId: MachineId | null;
  localProjectId: LocalProjectId | null;
  machineName: string | null;
  projectName: string | null;
};

/**
 * Whether a conversation is already published as a static share link.
 *
 * `unknown` covers both "the control plane has not answered yet" and "this
 * build has no cloud", so a header never claims a conversation is unshared
 * before it knows. Team visibility (`SessionSharingState`) is a separate axis:
 * a private conversation can still carry a published link, and a team-visible
 * one can carry none.
 */
export type SessionPublicShareStatus = 'unknown' | 'none' | 'shared';

type SessionSharingRecord = {
  machineId?: string | null;
  project?: { kind?: string; localProjectId?: string | null } | null;
};

type ResolveSessionSharingStateArgs = {
  session: SessionSharingRecord;
  currentUserId: string | null;
  machineAccessByMachineId: ReadonlyMap<MachineId, MachineVisibilityAccess>;
  localProjectAccessByKey: ReadonlyMap<string, LocalProjectVisibilityAccess>;
  machineName?: string | null;
  projectName?: string | null;
  isLoading: boolean;
};

type ResolveLocalProjectSharingStateArgs = Omit<ResolveSessionSharingStateArgs, 'session'> & {
  machineId: MachineId;
  localProjectId: LocalProjectId;
};

export function shouldShowSessionSharing({
  workspaceId,
  activeWorkspaceId,
  memberCount,
}: {
  workspaceId: string | null;
  activeWorkspaceId: string | null;
  memberCount: number | null;
}): boolean {
  return Boolean(
    workspaceId && activeWorkspaceId === workspaceId && memberCount !== null && memberCount > 1
  );
}

export function shouldShowPrivateSharingStatus(
  state: SessionSharingState | null | undefined
): state is SessionSharingState & { visibility: 'private' } {
  return state?.visibility === 'private';
}

export function getSessionSharingProjectKey(
  machineId: MachineId,
  localProjectId: LocalProjectId
): string {
  return `${machineId}:${localProjectId}`;
}

export function resolveSessionSharingState({
  session,
  currentUserId,
  machineAccessByMachineId,
  localProjectAccessByKey,
  machineName,
  projectName,
  isLoading,
}: ResolveSessionSharingStateArgs): SessionSharingState {
  const machineId =
    typeof session.machineId === 'string' && session.machineId.trim()
      ? (session.machineId as MachineId)
      : null;
  const localProjectId =
    session.project?.kind === 'local' &&
    typeof session.project.localProjectId === 'string' &&
    session.project.localProjectId.trim()
      ? (session.project.localProjectId as LocalProjectId)
      : null;

  return resolveSharingState({
    machineId,
    localProjectId,
    currentUserId,
    machineAccessByMachineId,
    localProjectAccessByKey,
    machineName,
    projectName,
    isLoading,
  });
}

/** Resolve the effective team access shown by a local-project picker. A project
 * is usable by teammates only when both its project and machine grants are on. */
export function resolveLocalProjectSharingState({
  machineId,
  localProjectId,
  currentUserId,
  machineAccessByMachineId,
  localProjectAccessByKey,
  machineName,
  projectName,
  isLoading,
}: ResolveLocalProjectSharingStateArgs): SessionSharingState {
  return resolveSharingState({
    machineId,
    localProjectId,
    currentUserId,
    machineAccessByMachineId,
    localProjectAccessByKey,
    machineName,
    projectName,
    isLoading,
  });
}

function resolveSharingState({
  machineId,
  localProjectId,
  currentUserId,
  machineAccessByMachineId,
  localProjectAccessByKey,
  machineName,
  projectName,
  isLoading,
}: Omit<ResolveLocalProjectSharingStateArgs, 'machineId' | 'localProjectId'> & {
  machineId: MachineId | null;
  localProjectId: LocalProjectId | null;
}): SessionSharingState {
  const machineAccess = machineId ? machineAccessByMachineId.get(machineId) : undefined;
  const projectAccess =
    machineId && localProjectId
      ? localProjectAccessByKey.get(getSessionSharingProjectKey(machineId, localProjectId))
      : undefined;
  const canManage = Boolean(
    currentUserId && machineAccess && machineAccess.ownerUserId === currentUserId
  );
  const base = {
    canManage,
    machineId,
    localProjectId,
    machineName: machineName?.trim() || null,
    projectName: projectName?.trim() || null,
  };

  if (!machineId) {
    return { ...base, visibility: 'unknown' };
  }

  // Owners get a synthetic private access row while the Convex subscription is
  // still loading. Do not flash a false Private badge before the authoritative
  // row arrives; cached/settled rows keep `isLoading` false.
  if (
    isLoading &&
    (!machineAccess || machineAccess.updatedAt === 0 || (localProjectId && !projectAccess))
  ) {
    return { ...base, visibility: 'unknown' };
  }

  if (!machineAccess || machineAccess.updatedAt === 0) {
    return {
      ...base,
      visibility: 'private',
      privateReason: 'machine-not-registered',
    };
  }

  const machineShared = machineAccess.sharedWithTeam;
  const projectShared = localProjectId ? projectAccess?.sharedWithTeam === true : true;

  if (machineShared && projectShared) {
    return { ...base, visibility: 'team' };
  }

  const privateReason: SessionSharingPrivateReason =
    !machineShared && !projectShared
      ? 'machine-and-project'
      : !machineShared
        ? 'machine'
        : 'project';

  return {
    ...base,
    visibility: 'private',
    privateReason,
  };
}
