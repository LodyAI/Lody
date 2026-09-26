import { useCallback, useEffect } from 'react';
import { atom, useAtomValue, useStore } from 'jotai';
import { allActiveSessionsAtom } from '@/atoms/doc-meta';
import { userAtom } from '@/atoms';
import { sessionLiveStatusAtomFamily } from '@/atoms/presence';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import {
  buildChildSessionsByParent,
  getEffectiveSessionActivitySummary,
} from '@/components/sessions/session-list-rows';

type WindowBadge = { unread: number; waiting: number };

const RECONCILE_MS = 30_000;
const ZERO: WindowBadge = { unread: 0, waiting: 0 };

/** Absolute count of owned sidebar rows, including their child conversations. */
export const workspaceBadgeAtom = atom<WindowBadge>((get) => {
  const userId = get(userAtom)?.id;
  if (!userId) return ZERO;
  const sessions = get(allActiveSessionsAtom);
  const children = buildChildSessionsByParent(sessions);
  const statuses = new Map(
    sessions.flatMap((session) => {
      const status = get(sessionLiveStatusAtomFamily(session.id));
      return status ? [[session.id, status] as const] : [];
    })
  );
  let unread = 0;
  let waiting = 0;
  for (const session of sessions) {
    if (session.parentSessionId || session.userId !== userId) continue;
    const activity = getEffectiveSessionActivitySummary(session, children, statuses);
    if (activity.isWaitingPermission) waiting += 1;
    else if (activity.hasUnreadMessages) unread += 1;
  }
  return { unread, waiting };
});

function publishBadge(badge: WindowBadge): void {
  const services = getIpcServices();
  if (!isElectronRenderer() || !services) return;
  void services.app.setWindowBadge(badge).then(
    (result) => {
      if (!result.ok) console.warn('Failed to update window badge', result.error);
    },
    (error: unknown) => console.warn('Failed to update window badge', error)
  );
}

/**
 * Compute the OS dock/taskbar badge for *this window*: how many sessions in
 * the current workspace, owned by the current user, are unread or
 * waiting-on-permission. Pushed to the Electron main process, which sums the
 * contributions across all windows and writes the OS badge.
 *
 * On the web there is no OS badge, so this hook is a no-op there. The
 * per-tab favicon is driven separately by `useTabStatus`.
 *
 * Mount only in the ready workspace's elected window. Reassert the full count
 * even when unchanged, so a failed IPC or an externally stale OS badge heals.
 */
export function useWorkspaceBadge(): void {
  const store = useStore();
  const { unread, waiting } = useAtomValue(workspaceBadgeAtom);
  const { workspaceId: currentWorkspaceId } = useResolvedWorkspaceScope();
  const publishCurrent = useCallback(() => {
    publishBadge(currentWorkspaceId ? store.get(workspaceBadgeAtom) : ZERO);
  }, [store, currentWorkspaceId]);

  // Changes publish immediately, including the transition to zero.
  useEffect(() => {
    publishCurrent();
  }, [unread, waiting, publishCurrent]);

  // Keep the deadline independent of count changes. Focus/visibility restores
  // also reconcile after sleep or Chromium background timer throttling.
  useEffect(() => {
    if (!isElectronRenderer()) return undefined;
    const interval = window.setInterval(publishCurrent, RECONCILE_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') publishCurrent();
    };
    window.addEventListener('focus', publishCurrent);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', publishCurrent);
      document.removeEventListener('visibilitychange', onVisible);
      publishBadge(ZERO);
    };
  }, [publishCurrent]);
}
