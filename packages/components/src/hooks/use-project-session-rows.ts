import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { findFreshSessionPresenceState, type SessionStatus } from '@lody/shared';
import { userAtom } from '@/atoms';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '@/atoms/presence';
import { useVisibleSessionMetas } from '@/hooks/use-visible-session-metas';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { useOrganization } from '@/hooks/useOrganization';
import { buildSessionListRows } from '@/components/sessions/session-list-rows';
import type { SessionListRow } from '@/components/session-list';

/**
 * Project hub prototype: every visible top-level Session row in the workspace,
 * built the same way the sidebar builds its rows, so status, PR and unread
 * flags agree with the sidebar. Callers group them by `projectGroup.id`.
 *
 * This subscribes to presence; mount it only in a page leaf (the project hub)
 * or a sidebar leaf that already re-renders on presence, never in layout.
 */
export function useWorkspaceSessionRows(): { rows: SessionListRow[]; loading: boolean } {
  const { t } = useTranslation();
  const user = useAtomValue(userAtom);
  const { activeOrganization } = useOrganization();
  const { sessions, allActiveSessions, workspaceHistoryReadable } = useVisibleSessionMetas();
  const onlineMachineIds = useOnlineMachineIds();
  const presenceStates = useAtomValue(lodyPresenceStatesAtom);
  const presenceNowMs = useAtomValue(lodyPresenceNowMsAtom);
  const defaultTitle = t('sessions.untitled', 'Untitled session');

  const liveSessionStatuses = useMemo(() => {
    const next = new Map<string, SessionStatus>();
    for (const session of allActiveSessions) {
      const status = findFreshSessionPresenceState(
        presenceStates,
        session.id,
        presenceNowMs
      )?.status;
      if (status) next.set(session.id, status);
    }
    return next;
  }, [allActiveSessions, presenceNowMs, presenceStates]);

  const rows = useMemo(
    () =>
      workspaceHistoryReadable
        ? buildSessionListRows(
            sessions,
            {
              scope: 'team',
              currentUserId: user?.id ?? null,
              defaultTitle,
              onlineMachineIds,
              members: activeOrganization?.members,
              liveSessionStatuses,
            },
            allActiveSessions
          )
        : [],
    [
      activeOrganization?.members,
      allActiveSessions,
      defaultTitle,
      liveSessionStatuses,
      onlineMachineIds,
      sessions,
      user?.id,
      workspaceHistoryReadable,
    ]
  );
  return { rows, loading: !workspaceHistoryReadable && sessions.length === 0 };
}

/** The four buckets of the project hub's right panel, in display order. */
export type ProjectHubBucket = 'needsYou' | 'running' | 'done' | 'idle';
export const PROJECT_HUB_BUCKETS: readonly ProjectHubBucket[] = [
  'needsYou',
  'running',
  'done',
  'idle',
];

/**
 * "Needs you" is anything blocked on the user: a permission or question
 * waiting. "Done" is a finished run the user has not read yet. Everything
 * else at rest is idle.
 */
export function classifyProjectHubRow(row: SessionListRow): ProjectHubBucket {
  if (row.isWaitingPermission) return 'needsYou';
  if (row.isWorking) return 'running';
  if (row.hasUnreadMessages) return 'done';
  return 'idle';
}
