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
import { isSessionVisibleToUser } from '@/lib/session-visibility';
import { useWorkspaceHistoryAccess } from './use-workspace-history-access';
import { useVisibleMachineIdSet, useVisibleLocalProjectKeySet } from './use-visible-session-metas';

export class SessionManagementDeniedError extends Error {
  readonly code = 'session_management_denied';
}

/** Read access never admits management. Re-read every target, using the pre-history predicate. */
export function useSessionManagementGuard(runtime: WorkspaceRuntime | null) {
  const store = useStore();
  const platform = usePlatform();
  const { t } = useTranslation();
  const readable = useWorkspaceHistoryAccess();
  const enabled = runtime?.contentMode === 'e2ee' && readable;
  const machines = useVisibleMachineIdSet({ enabled });
  const projects = useVisibleLocalProjectKeySet({ enabled });
  const latest = useRef({ runtime, readable, machines, projects });
  latest.current = { runtime, readable, machines, projects };
  return useCallback(
    async (sessionIds: readonly SessionId[]) => {
      // Preserve ordinary-workspace management, which this history change never expanded.
      if (runtime?.contentMode !== 'e2ee') return;
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
          !latest.current.readable ||
          !runtime.accountId ||
          (userId && userId !== runtime.accountId) ||
          (platform.kind === 'cloud' &&
            ((session.status === 'unauthenticated' && !session.uncertain) ||
              (session.status === 'authenticated' && session.user.id !== runtime.accountId)))
        )
          deny();
      };
      assertScope();
      const entries = await Promise.all(
        [...new Set(sessionIds)].map((id) => runtime.repo.getDocMeta(getSessionRoomId(id)))
      );
      assertScope();
      const access = latest.current;
      for (const entry of entries) {
        if (
          !entry ||
          isLoroRepoDocDeleted(entry) ||
          !isSessionVisibleToUser(
            entry.meta as SessionMeta,
            access.machines.visibleMachineIds,
            access.projects.visibleLocalProjectKeys,
            runtime.accountId
          )
        )
          deny();
      }
    },
    [runtime, store, platform, t]
  );
}
