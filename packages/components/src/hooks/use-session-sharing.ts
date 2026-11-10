import { useAtomValue } from 'jotai';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { resolveSessionReadRoot, isSessionReadShared } from '@/lib/session-visibility';
import { useCallback, useRef, useMemo } from 'react';
import type { SessionMeta, WorkspaceId } from '@lody/shared';
import { useWorkspaceLocalAccountId } from '@/lib/e2ee-account';
import { useVisibleLocalProjects } from './use-visible-local-projects';
import { useVisibleMachineMetas } from './use-visible-machine-metas';
import {
  getSessionSharingProjectKey,
  resolveSessionSharingState,
  type SessionSharingState,
} from '@/lib/session-sharing';
import { useAppCapability } from '@/lib/app-platform';
import { useResolvedWorkspaceScope } from './use-resolved-workspace-scope';
import { useOpenSettings } from './use-open-settings';
import { useSessionAccess } from './use-session-access';

type UseSessionSharingOptions = {
  includeLocalProjectDetails?: boolean;
  workspaceId?: WorkspaceId | null;
  enabled?: boolean;
  members?: SessionSharingState['availableMembers'];
  membersLoading?: boolean;
  membersError?: boolean;
  retryMembers?: () => void;
};

/** Team read grants use the same owner-only port in ordinary and encrypted workspaces. */
export function useSessionSharing(options: UseSessionSharingOptions = {}) {
  const { openSettings } = useOpenSettings();
  const sessionMetaCache = useAtomValue(sessionMetaCacheAtom);
  const sessionsById = useMemo(
    () => new Map(Object.values(sessionMetaCache).map((meta) => [meta.id, meta])),
    [sessionMetaCache]
  );
  const currentUserId = useWorkspaceLocalAccountId();
  const scope = useResolvedWorkspaceScope(options);
  const teamSharingAvailable = useAppCapability('teamSharing');
  const access = useSessionAccess(scope);
  const machineIndex = useVisibleMachineMetas({ includeMachineFlock: false, ...scope });
  const projectIndex = useVisibleLocalProjects({
    includeMemberOnly: true,
    includeMachineFlock: options.includeLocalProjectDetails ?? false,
    syncMachineFlock: false,
    ...scope,
  });
  const { machines, accessByMachineId, isLoading: machineVisibilityLoading } = machineIndex;
  const { projects, accessByProjectKey, isLoading: localProjectVisibilityLoading } = projectIndex;
  const isLoading = machineVisibilityLoading || localProjectVisibilityLoading || access.loading;
  const pending = useRef(new Map<string, { requestId: string; level: 'read' | null }>());
  const setReadAccess = useCallback(
    async (
      machineId: string,
      sessionId: string,
      level: 'read' | null,
      audience: 'team' | { userId: string } = 'team'
    ) => {
      if (!access.port || !access.workspaceId || !access.enabled)
        throw new Error('session_access_unavailable');
      const latest = await access.port.read(access.workspaceId, machineId);
      if (!latest.canManage) throw new Error('session_access_not_owned');
      const key = JSON.stringify([
        currentUserId,
        access.workspaceId,
        machineId,
        latest.generation,
        sessionId,
        audience,
      ]);
      const retained = pending.current.get(key);
      const interrupted = latest.pendingRequest;
      if (
        (retained && retained.level !== level) ||
        (interrupted &&
          (interrupted.sessionId !== sessionId ||
            interrupted.level !== level ||
            JSON.stringify(interrupted.audience ?? 'team') !== JSON.stringify(audience)))
      )
        throw new Error('sharing_conflict');
      const requestId =
        interrupted?.requestId ?? retained?.requestId ?? crypto.randomUUID().replaceAll('-', '');
      pending.current.set(key, { requestId, level });
      const result = await access.port.set({
        workspaceId: access.workspaceId,
        machineId,
        sessionId,
        level,
        audience,
        generation: latest.generation,
        requestId,
      });
      if (result.status !== 'pending') pending.current.delete(key);
      await access.store?.refresh();
      if (result.status !== 'saved') throw new Error(`sharing_${result.status}`);
    },
    [access.port, access.workspaceId, access.enabled, access.store, currentUserId]
  );
  const resolve = useCallback(
    (session: SessionMeta): SessionSharingState => {
      const machine = machines.get(session.machineId);
      const localProjectId =
        session.project?.kind === 'local' ? session.project.localProjectId : null;
      const project = localProjectId
        ? projects.get(getSessionSharingProjectKey(session.machineId, localProjectId))?.project
        : null;
      const base = resolveSessionSharingState({
        session,
        currentUserId,
        machineAccessByMachineId: accessByMachineId,
        localProjectAccessByKey: accessByProjectKey,
        machineName: machine?.name,
        projectName: project?.name,
        isLoading,
      });
      const grant = access.views.get(session.machineId);
      const root = resolveSessionReadRoot(session, sessionsById);
      const rootId = root.id;
      const readShared = isSessionReadShared(session, access.views, sessionsById, currentUserId);
      const assignedRead = !!currentUserId && session.userId === currentUserId && !base.canManage;
      const effective =
        base.visibility === 'team' ? 'edit' : readShared || assignedRead ? 'read' : 'private';
      return {
        ...base,
        access: effective,
        sessionId: rootId,
        ownerUserId: root.userId,
        availableMembers: options.members,
        membersLoading: options.membersLoading,
        membersError: options.membersError,
        retryMembers: options.retryMembers,
        memberUserIds: [
          ...new Set(
            (grant?.memberReadSharedSessions ?? [])
              .filter((row) => row.sessionId === rootId)
              .map((row) => row.userId)
          ),
        ],
        setMemberReadAccess: (userId, shared) =>
          setReadAccess(session.machineId, rootId, shared ? 'read' : null, { userId }),
        openMachineSettings: () => openSettings('machines', { machineId: session.machineId }),
        visibility:
          grant?.readSharedSessionIds.includes(rootId) || base.visibility === 'team'
            ? 'team'
            : base.visibility,
        canManage: grant?.canManage ?? base.canManage,
        setReadAccess: (level) => setReadAccess(session.machineId, rootId, level),
      };
    },
    [
      machines,
      options.members,
      options.membersLoading,
      options.membersError,
      options.retryMembers,
      projects,
      currentUserId,
      accessByMachineId,
      accessByProjectKey,
      isLoading,
      access.views,
      sessionsById,
      setReadAccess,
      openSettings,
    ]
  );
  const shareWithTeam = useCallback(async (state: SessionSharingState) => {
    if (!state.canManage || !state.setReadAccess) throw new Error('session_access_not_owned');
    await state.setReadAccess('read');
  }, []);
  return {
    sessionAccessViews: access.views,
    machines,
    accessByMachineId,
    projects,
    accessByProjectKey,
    machineVisibilityLoading,
    localProjectVisibilityLoading,
    isLoading,
    showSessionSharing: scope.enabled && teamSharingAvailable,
    resolve,
    shareWithTeam,
  };
}
