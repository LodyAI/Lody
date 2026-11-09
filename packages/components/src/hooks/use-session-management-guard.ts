import { useCallback, useRef } from 'react';
import { useStore } from 'jotai';
import { usePlatform } from '@lody/platform/react';
import { useTranslation } from 'react-i18next';
import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { activeWorkspaceRuntimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import {
  isSessionVisibleToUser,
  isSessionReadShared,
  isContainedSession,
} from '@/lib/session-visibility';
import { useSessionAccess } from './use-session-access';
import { useVisibleMachineIdSet, useVisibleLocalProjectKeySet } from './use-visible-session-metas';

export class SessionManagementDeniedError extends Error {
  readonly code = 'session_management_denied';
}

/** Read grants admit only the narrow preference path; management requires machine authority. */
export function useSessionManagementGuard(runtime: WorkspaceRuntime | null) {
  const store = useStore();
  const platform = usePlatform();
  const { t } = useTranslation();
  const sessionAccess = useSessionAccess();
  const enabled = !!runtime;
  const machines = useVisibleMachineIdSet({ enabled });
  const projects = useVisibleLocalProjectKeySet({ enabled });
  const latest = useRef({ runtime, sessionAccess, machines, projects });
  latest.current = { runtime, sessionAccess, machines, projects };
  return useCallback(
    async (sessionIds: readonly SessionId[], preferences = false) => {
      // Local-only composition has no team grants.
      if (platform.kind === 'local' || (runtime?.contentMode !== 'e2ee' && !platform.sessionAccess))
        return;
      if (!runtime) throw new SessionManagementDeniedError(t('sessions.historyMachineUnavailable'));
      const deny = () => {
        throw new SessionManagementDeniedError(t('sessions.historyMachineUnavailable'));
      };
      const assertScope = () => {
        const userId = store.get(userAtom)?.id;
        const session = platform.identity.session.get();
        if (
          store.get(activeWorkspaceRuntimeAtom) !== runtime ||
          store.get(currentWorkspaceIdAtom) !== runtime.workspaceId ||
          latest.current.runtime !== runtime ||
          !(store.get(userAtom)?.id ?? runtime.accountId) ||
          (runtime.accountId && userId && userId !== runtime.accountId) ||
          (platform.kind === 'cloud' &&
            ((session.status === 'unauthenticated' && !session.uncertain) ||
              (session.status === 'authenticated' &&
                session.user.id !== (runtime.accountId ?? userId))))
        )
          deny();
      };
      assertScope();
      const entries = await Promise.all(
        [...new Set(sessionIds)].map(async (id) => ({
          id,
          entry: await runtime.repo.getDocMeta(getSessionRoomId(id)),
        }))
      );
      assertScope();
      const access = latest.current;
      for (const { id, entry } of entries) {
        if (!entry || isLoroRepoDocDeleted(entry)) deny();
        const meta = { ...(entry!.meta as SessionMeta), id };
        if (
          isSessionVisibleToUser(
            meta,
            access.machines.visibleMachineIds,
            access.projects.visibleLocalProjectKeys,
            store.get(userAtom)?.id ?? runtime.accountId,
            access.machines.ownedMachineIds
          )
        )
          continue;
        if (!preferences || !access.sessionAccess.port) deny();
        const records = new Map<string, SessionMeta>([[id, meta]]);
        if (meta.parentSessionId) {
          const parentId = meta.parentSessionId;
          const parent = await runtime.repo.getDocMeta(getSessionRoomId(parentId));
          assertScope();
          if (parent && !isLoroRepoDocDeleted(parent)) {
            const parentMeta = { ...(parent.meta as SessionMeta), id: parentId };
            if (isContainedSession(meta, parentMeta)) records.set(parentId, parentMeta);
          }
        }
        const view = await access.sessionAccess.port!.read(runtime.workspaceId, meta.machineId);
        assertScope();
        for (const [recordId, record] of records) {
          const current = await runtime.repo.getDocMeta(getSessionRoomId(recordId as SessionId));
          assertScope();
          if (
            !current ||
            isLoroRepoDocDeleted(current) ||
            current.meta.machineId !== record.machineId ||
            current.meta.parentSessionId !== record.parentSessionId ||
            current.meta.childSessionPlacement !== record.childSessionPlacement
          )
            deny();
        }
        if (!isSessionReadShared(meta, new Map([[view.machineId, view]]), records)) deny();
      }
    },
    [runtime, store, platform, t]
  );
}
