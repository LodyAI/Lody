import { useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import type { MachineId, SessionMeta, WorkspaceId } from '@lody/shared';
import { useWorkspaceLocalAccountId } from '@/lib/e2ee-account';
import { allActiveSessionsAtom, archivedSessionListAtom, sessionListAtom } from '@/atoms/doc-meta';
import {
  filterSessionsByVisibility,
  isSessionVisibleToUser,
  type SessionListEntry,
} from '@/lib/session-visibility';
import { useVisibleLocalProjects } from './use-visible-local-projects';
import { useVisibleMachineMetas } from './use-visible-machine-metas';
import { useResolvedWorkspaceScope } from './use-resolved-workspace-scope';
import { useWorkspaceHistoryAccess } from './use-workspace-history-access';

function areSetsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

type VisibleSessionMetasResult = {
  workspaceHistoryReadable: boolean;
  historyOnlySessionIds: ReadonlySet<string>;
  sessions: SessionListEntry[];
  allActiveSessions: SessionMeta[];
  visibleMachineIds: Set<MachineId>;
  visibleLocalProjectKeys: Set<string>;
  isLoading: boolean;
};

type VisibleArchivedSessionMetasResult = {
  workspaceHistoryReadable: boolean;
  historyOnlySessionIds: ReadonlySet<string>;
  archivedSessions: SessionListEntry[];
  visibleMachineIds: Set<MachineId>;
  visibleLocalProjectKeys: Set<string>;
  isLoading: boolean;
};

type WorkspaceVisibilityOptions = {
  workspaceId?: WorkspaceId | null;
  enabled?: boolean;
};

/** Only the new workspace-history read permission; retain pre-existing author management. */
function useHistoryOnlySessionIds(
  sessions: readonly SessionMeta[],
  machines: ReadonlySet<MachineId>,
  projects: ReadonlySet<string>,
  accountId: string | null,
  readable: boolean,
  ownedMachineIds: ReadonlySet<MachineId>
) {
  const previous = useRef(new Set<string>());
  return useMemo(() => {
    const next = new Set(
      readable
        ? sessions
            .filter(
              (session) =>
                !isSessionVisibleToUser(session, machines, projects, accountId, ownedMachineIds)
            )
            .map((session) => session.id)
        : []
    );
    if (areSetsEqual(previous.current, next)) return previous.current;
    previous.current = next;
    return next;
  }, [sessions, machines, projects, accountId, readable, ownedMachineIds]);
}

export function useVisibleMachineIdSet(options: WorkspaceVisibilityOptions = {}): {
  visibleMachineIds: Set<MachineId>;
  ownedMachineIds: Set<MachineId>;
  isLoading: boolean;
} {
  const { accessByMachineId, isLoading } = useVisibleMachineMetas({
    includeMachineFlock: false,
    workspaceId: options.workspaceId,
    enabled: options.enabled,
  });

  // `accessByMachineId` is a fresh Map on every Loro machine-meta tick even
  // when the key set is unchanged. Stabilize the Set reference by content so
  // downstream memos (e.g. filtered session lists) don't re-run on no-op
  // visibility updates.
  const prevRef = useRef<Set<MachineId>>(new Set());
  const visibleMachineIds = useMemo(() => {
    const next = new Set<MachineId>(accessByMachineId.keys());
    const prev = prevRef.current;
    if (areSetsEqual(prev, next)) return prev;
    prevRef.current = next;
    return next;
  }, [accessByMachineId]);

  const accountId = useWorkspaceLocalAccountId();
  const ownedRef = useRef(new Set<MachineId>());
  const ownedMachineIds = useMemo(() => {
    const next = new Set(
      [...accessByMachineId]
        .filter(
          ([, access]) =>
            !!accountId && options.enabled !== false && access.ownerUserId === accountId
        )
        .map(([id]) => id)
    );
    if (areSetsEqual(ownedRef.current, next)) return ownedRef.current;
    ownedRef.current = next;
    return next;
  }, [accessByMachineId, accountId, options.enabled]);
  return { visibleMachineIds, ownedMachineIds, isLoading };
}

export function useVisibleLocalProjectKeySet(options: WorkspaceVisibilityOptions = {}): {
  visibleLocalProjectKeys: Set<string>;
  isLoading: boolean;
} {
  const { accessByProjectKey, isLoading } = useVisibleLocalProjects({
    includeMachineFlock: false,
    workspaceId: options.workspaceId,
    enabled: options.enabled,
  });

  const prevRef = useRef<Set<string>>(new Set());
  const visibleLocalProjectKeys = useMemo(() => {
    const next = new Set<string>(accessByProjectKey.keys());
    const prev = prevRef.current;
    if (areSetsEqual(prev, next)) return prev;
    prevRef.current = next;
    return next;
  }, [accessByProjectKey]);

  return { visibleLocalProjectKeys, isLoading };
}

export function useVisibleSessionMetas(
  options: WorkspaceVisibilityOptions = {}
): VisibleSessionMetasResult {
  const scope = useResolvedWorkspaceScope(options);
  const workspaceHistoryReadable = useWorkspaceHistoryAccess(scope);
  const sessions = useAtomValue(sessionListAtom);
  const allActiveSessions = useAtomValue(allActiveSessionsAtom);
  const {
    visibleMachineIds,
    ownedMachineIds,
    isLoading: machineLoading,
  } = useVisibleMachineIdSet(scope);
  const { visibleLocalProjectKeys, isLoading: localProjectLoading } =
    useVisibleLocalProjectKeySet(scope);
  const enabled = scope.enabled;
  const currentUserIdValue = useWorkspaceLocalAccountId();
  const currentUserId = enabled ? currentUserIdValue : null;
  const isLoading = machineLoading || localProjectLoading;
  const historyOnlySessionIds = useHistoryOnlySessionIds(
    allActiveSessions,
    visibleMachineIds,
    visibleLocalProjectKeys,
    currentUserId,
    workspaceHistoryReadable,
    ownedMachineIds
  );

  const visibleSessions = useMemo(
    () =>
      enabled
        ? filterSessionsByVisibility(
            sessions,
            visibleMachineIds,
            visibleLocalProjectKeys,
            machineLoading,
            currentUserId,
            workspaceHistoryReadable,
            ownedMachineIds
          )
        : [],
    [
      currentUserId,
      enabled,
      machineLoading,
      sessions,
      visibleLocalProjectKeys,
      visibleMachineIds,
      workspaceHistoryReadable,
      ownedMachineIds,
    ]
  );
  const visibleAllActiveSessions = useMemo(
    () =>
      enabled
        ? filterSessionsByVisibility(
            allActiveSessions,
            visibleMachineIds,
            visibleLocalProjectKeys,
            machineLoading,
            currentUserId,
            workspaceHistoryReadable,
            ownedMachineIds
          )
        : [],
    [
      allActiveSessions,
      currentUserId,
      enabled,
      machineLoading,
      visibleLocalProjectKeys,
      visibleMachineIds,
      workspaceHistoryReadable,
      ownedMachineIds,
    ]
  );

  return {
    workspaceHistoryReadable,
    historyOnlySessionIds,
    sessions: visibleSessions,
    allActiveSessions: visibleAllActiveSessions,
    visibleMachineIds,
    visibleLocalProjectKeys,
    isLoading,
  };
}

export function useVisibleArchivedSessionMetas(
  options: WorkspaceVisibilityOptions = {}
): VisibleArchivedSessionMetasResult {
  const scope = useResolvedWorkspaceScope(options);
  const workspaceHistoryReadable = useWorkspaceHistoryAccess(scope);
  const archivedSessions = useAtomValue(archivedSessionListAtom);
  const {
    visibleMachineIds,
    ownedMachineIds,
    isLoading: machineLoading,
  } = useVisibleMachineIdSet(scope);
  const { visibleLocalProjectKeys, isLoading: localProjectLoading } =
    useVisibleLocalProjectKeySet(scope);
  const currentUserIdValue = useWorkspaceLocalAccountId();
  const currentUserId = scope.enabled ? currentUserIdValue : null;
  const isLoading = machineLoading || localProjectLoading;
  const historyOnlySessionIds = useHistoryOnlySessionIds(
    archivedSessions,
    visibleMachineIds,
    visibleLocalProjectKeys,
    currentUserId,
    workspaceHistoryReadable,
    ownedMachineIds
  );

  const visibleArchivedSessions = useMemo(
    () =>
      scope.enabled
        ? filterSessionsByVisibility(
            archivedSessions,
            visibleMachineIds,
            visibleLocalProjectKeys,
            machineLoading,
            currentUserId,
            workspaceHistoryReadable,
            ownedMachineIds
          )
        : [],
    [
      archivedSessions,
      currentUserId,
      machineLoading,
      scope.enabled,
      visibleLocalProjectKeys,
      visibleMachineIds,
      workspaceHistoryReadable,
      ownedMachineIds,
    ]
  );

  return {
    workspaceHistoryReadable,
    historyOnlySessionIds,
    archivedSessions: visibleArchivedSessions,
    visibleMachineIds,
    visibleLocalProjectKeys,
    isLoading,
  };
}

/** Ownership is resolved by the same access rows as sharing management, including its BC fallback. */
export function useMySessionScope(options: WorkspaceVisibilityOptions = {}) {
  const currentUserId = useWorkspaceLocalAccountId();
  const { ownedMachineIds } = useVisibleMachineIdSet(options);
  return { currentUserId, ownedMachineIds };
}
