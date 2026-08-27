import { useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import type { MachineId, SessionMeta, WorkspaceId } from '@lody/shared';
import { userAtom } from '@/atoms';
import { allActiveSessionsAtom, archivedSessionListAtom, sessionListAtom } from '@/atoms/doc-meta';
import { filterSessionsByVisibility, type SessionListEntry } from '@/lib/session-visibility';
import { useVisibleLocalProjects } from './use-visible-local-projects';
import { useVisibleMachineMetas } from './use-visible-machine-metas';
import { useResolvedWorkspaceScope } from './use-resolved-workspace-scope';

function areSetsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

type VisibleSessionMetasResult = {
  sessions: SessionListEntry[];
  allActiveSessions: SessionMeta[];
  visibleMachineIds: Set<MachineId>;
  visibleLocalProjectKeys: Set<string>;
  isLoading: boolean;
};

type VisibleArchivedSessionMetasResult = {
  archivedSessions: SessionListEntry[];
  visibleMachineIds: Set<MachineId>;
  visibleLocalProjectKeys: Set<string>;
  isLoading: boolean;
};

type WorkspaceVisibilityOptions = {
  workspaceId?: WorkspaceId | null;
  enabled?: boolean;
};

export function useVisibleMachineIdSet(options: WorkspaceVisibilityOptions = {}): {
  visibleMachineIds: Set<MachineId>;
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

  return { visibleMachineIds, isLoading };
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
  const sessions = useAtomValue(sessionListAtom);
  const allActiveSessions = useAtomValue(allActiveSessionsAtom);
  const { visibleMachineIds, isLoading: machineLoading } = useVisibleMachineIdSet(scope);
  const { visibleLocalProjectKeys, isLoading: localProjectLoading } =
    useVisibleLocalProjectKeySet(scope);
  const enabled = scope.enabled;
  const currentUserIdValue = useAtomValue(userAtom)?.id ?? null;
  const currentUserId = enabled ? currentUserIdValue : null;
  const isLoading = machineLoading || localProjectLoading;

  const visibleSessions = useMemo(
    () =>
      enabled
        ? filterSessionsByVisibility(
            sessions,
            visibleMachineIds,
            visibleLocalProjectKeys,
            machineLoading,
            currentUserId
          )
        : [],
    [currentUserId, enabled, machineLoading, sessions, visibleLocalProjectKeys, visibleMachineIds]
  );
  const visibleAllActiveSessions = useMemo(
    () =>
      enabled
        ? filterSessionsByVisibility(
            allActiveSessions,
            visibleMachineIds,
            visibleLocalProjectKeys,
            machineLoading,
            currentUserId
          )
        : [],
    [
      allActiveSessions,
      currentUserId,
      enabled,
      machineLoading,
      visibleLocalProjectKeys,
      visibleMachineIds,
    ]
  );

  return {
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
  const archivedSessions = useAtomValue(archivedSessionListAtom);
  const { visibleMachineIds, isLoading: machineLoading } = useVisibleMachineIdSet(scope);
  const { visibleLocalProjectKeys, isLoading: localProjectLoading } =
    useVisibleLocalProjectKeySet(scope);
  const currentUserIdValue = useAtomValue(userAtom)?.id ?? null;
  const currentUserId = scope.enabled ? currentUserIdValue : null;
  const isLoading = machineLoading || localProjectLoading;

  const visibleArchivedSessions = useMemo(
    () =>
      scope.enabled
        ? filterSessionsByVisibility(
            archivedSessions,
            visibleMachineIds,
            visibleLocalProjectKeys,
            machineLoading,
            currentUserId
          )
        : [],
    [
      archivedSessions,
      currentUserId,
      machineLoading,
      scope.enabled,
      visibleLocalProjectKeys,
      visibleMachineIds,
    ]
  );

  return {
    archivedSessions: visibleArchivedSessions,
    visibleMachineIds,
    visibleLocalProjectKeys,
    isLoading,
  };
}
