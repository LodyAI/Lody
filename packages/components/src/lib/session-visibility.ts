import type { LocalProjectId, MachineId, SessionId, SessionMeta } from '@lody/shared';
import type { MachineVisibilityAccess } from './visible-machine-index';
import type { LocalProjectVisibilityAccess } from './visible-local-project-index';
import { getLocalProjectVisibilityKey } from './visible-local-project-index';

export type SessionListEntry = SessionMeta & { id: SessionId };

export type SessionMachineRecord = {
  machineId?: string | null;
  userId?: string | null;
  project?: { kind?: string; localProjectId?: string | null } | null;
};

type LocalProjectSessionMachineRecord = SessionMachineRecord & {
  project: { kind: 'local'; localProjectId: string };
};

export type SessionVisibilityState = 'loading' | 'visible' | 'hidden';

type SessionVisibilityOptions = {
  machineVisibilityLoading?: boolean;
  localProjectVisibilityLoading?: boolean;
  currentUserId?: string | null;
  workspaceHistoryReadable?: boolean;
  ownedMachineIds?: ReadonlySet<MachineId>;
};

export function isLocalProjectSession(
  session: SessionMachineRecord
): session is LocalProjectSessionMachineRecord {
  const project = session.project;
  return project?.kind === 'local' && typeof project.localProjectId === 'string';
}

/** UI availability only; the receiver still authorizes every execution. No author fallback. */
export function isSessionMachineAvailable(
  session: SessionMachineRecord | null | undefined,
  visibleMachineIds: ReadonlySet<MachineId>,
  visibleLocalProjectKeys: ReadonlySet<string>
): boolean {
  if (!session?.machineId || !visibleMachineIds.has(session.machineId as MachineId)) return false;
  return (
    !isLocalProjectSession(session) ||
    visibleLocalProjectKeys.has(
      getLocalProjectVisibilityKey(session.machineId, session.project.localProjectId)
    )
  );
}

/** Metadata presentation must not turn unreadable/unusable machines into catalog readers. */
export function availableLocalHistoryMachineIds(
  sessions: readonly (SessionMachineRecord & { id: string })[],
  visibleMachineIds: ReadonlySet<MachineId>,
  visibleLocalProjectKeys: ReadonlySet<string>
): MachineId[] {
  return [
    ...new Set(
      sessions
        .filter(
          (session) =>
            isLocalProjectSession(session) &&
            isSessionMachineAvailable(session, visibleMachineIds, visibleLocalProjectKeys)
        )
        .map((session) => session.machineId as MachineId)
    ),
  ];
}

export function isSessionVisibleToUser(
  session: SessionMachineRecord,
  visibleMachineIds: ReadonlySet<MachineId>,
  visibleLocalProjectKeys: ReadonlySet<string>,
  currentUserId?: string | null,
  ownedMachineIds?: ReadonlySet<MachineId>
): boolean {
  if (typeof session.machineId !== 'string') {
    return false;
  }
  // Legacy metadata has no immutable creator: retain the owner fallback for
  // authors whose machine access was revoked. Owner transfer separately requires access.
  if (
    currentUserId &&
    (session.userId === currentUserId || ownedMachineIds?.has(session.machineId as MachineId))
  ) {
    return true;
  }
  if (isLocalProjectSession(session)) {
    return visibleLocalProjectKeys.has(
      getLocalProjectVisibilityKey(
        session.machineId as MachineId,
        session.project.localProjectId as LocalProjectId
      )
    );
  }
  return visibleMachineIds.has(session.machineId as MachineId);
}

export function resolveSessionVisibilityState(
  session: SessionMachineRecord,
  visibleMachineIds: ReadonlySet<MachineId>,
  visibleLocalProjectKeys: ReadonlySet<string>,
  options: SessionVisibilityOptions = {}
): SessionVisibilityState {
  if (options.workspaceHistoryReadable && typeof session.machineId === 'string') return 'visible';
  if (
    isSessionVisibleToUser(
      session,
      visibleMachineIds,
      visibleLocalProjectKeys,
      options.currentUserId,
      options.ownedMachineIds
    )
  ) {
    return 'visible';
  }
  if (typeof session.machineId !== 'string') {
    return 'hidden';
  }

  const visibilityLoading = isLocalProjectSession(session)
    ? options.machineVisibilityLoading || options.localProjectVisibilityLoading
    : options.machineVisibilityLoading;
  return visibilityLoading ? 'loading' : 'hidden';
}

// Lists fail closed while access is loading: only owner fallback or access
// already present in the current visibility indices may render. Detail views
// use `resolveSessionVisibilityState` to distinguish pending access from a
// settled denial.
export function filterSessionsByVisibility<T extends SessionMachineRecord>(
  sessions: readonly T[],
  visibleMachineIds: ReadonlySet<MachineId>,
  visibleLocalProjectKeys: ReadonlySet<string>,
  machineVisibilityLoading = false,
  currentUserId?: string | null,
  workspaceHistoryReadable = false,
  ownedMachineIds?: ReadonlySet<MachineId>
): T[] {
  if (sessions.length === 0) return [];
  if (
    !workspaceHistoryReadable &&
    visibleMachineIds.size === 0 &&
    visibleLocalProjectKeys.size === 0 &&
    !currentUserId
  ) {
    return [];
  }
  return sessions.filter(
    (session) =>
      resolveSessionVisibilityState(session, visibleMachineIds, visibleLocalProjectKeys, {
        machineVisibilityLoading,
        currentUserId,
        workspaceHistoryReadable,
        ownedMachineIds,
      }) === 'visible'
  );
}

/** My scope is responsibility plus the machines I own, independent of sharing. */
export function isSessionInMyScope(
  session: SessionMachineRecord,
  currentUserId: string | null | undefined,
  ownedMachineIds: ReadonlySet<MachineId>
): boolean {
  return (
    !!currentUserId &&
    (session.userId === currentUserId || ownedMachineIds.has(session.machineId as MachineId))
  );
}

/** Assignment may use existing access only; it never changes sharing. */
export function getSessionOwnerAccessReason(
  session: SessionMachineRecord,
  candidateUserId: string,
  machines: ReadonlyMap<MachineId, MachineVisibilityAccess>,
  projects: ReadonlyMap<string, LocalProjectVisibilityAccess>
): 'machineUnavailable' | 'machineNotShared' | 'projectNotShared' | null {
  const machine = machines.get(session.machineId as MachineId);
  if (!machine) return 'machineUnavailable';
  if (machine.ownerUserId === candidateUserId) return null;
  if (!machine.sharedWithTeam) return 'machineNotShared';
  if (isLocalProjectSession(session)) {
    const project = projects.get(
      getLocalProjectVisibilityKey(session.machineId!, session.project.localProjectId)
    );
    if (!project?.sharedWithTeam) return 'projectNotShared';
  }
  return null;
}
