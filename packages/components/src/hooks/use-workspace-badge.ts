import { useEffect, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { sessionListAtom } from '@/atoms/doc-meta';
import { userAtom } from '@/atoms';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '@/atoms/presence';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { findFreshSessionPresenceState } from '@lody/shared';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';

type WindowBadge = { unread: number; waiting: number };

const DEBOUNCE_MS = 150;
const ZERO: WindowBadge = { unread: 0, waiting: 0 };

/**
 * Compute the OS dock/taskbar badge for *this window*: how many sessions in
 * the current workspace, owned by the current user, are unread or
 * waiting-on-permission. Pushed to the Electron main process, which sums the
 * contributions across all windows and writes the OS badge.
 *
 * On the web there is no OS badge, so this hook is a no-op there. The
 * per-tab favicon is driven separately by `useTabStatus`.
 *
 * Mount once per authenticated workspace layout.
 */
export function useWorkspaceBadge(): void {
  const sessions = useAtomValue(sessionListAtom);
  const presenceStates = useAtomValue(lodyPresenceStatesAtom);
  const presenceNowMs = useAtomValue(lodyPresenceNowMsAtom);
  const user = useAtomValue(userAtom);
  const { workspaceId: currentWorkspaceId } = useResolvedWorkspaceScope();
  const userId = user?.id ?? null;

  const badge = useMemo<WindowBadge>(() => {
    if (!userId || !currentWorkspaceId) return ZERO;
    let unread = 0;
    let waiting = 0;
    for (const session of sessions) {
      if (session.userId !== userId) continue;
      const liveStatus = findFreshSessionPresenceState(
        presenceStates,
        session.id,
        presenceNowMs
      )?.status;
      if (liveStatus?.type === 'requestPermission') {
        waiting += 1;
        continue;
      }
      const lastMessageAt =
        typeof session.lastMessageAt === 'number' ? session.lastMessageAt : null;
      const lastReadAt = typeof session.lastReadAt === 'number' ? session.lastReadAt : null;
      if (lastMessageAt !== null && (lastReadAt === null || lastMessageAt > lastReadAt)) {
        unread += 1;
      }
    }
    return { unread, waiting };
  }, [sessions, presenceNowMs, presenceStates, userId, currentWorkspaceId]);

  const { unread, waiting } = badge;
  useEffect(() => {
    const services = getIpcServices();
    if (!isElectronRenderer() || !services) return undefined;

    const handle = window.setTimeout(() => {
      void services.app.setWindowBadge({ unread, waiting });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(handle);
    };
  }, [unread, waiting]);

  // Clear our contribution when the hook unmounts (workspace switch / logout).
  useEffect(() => {
    return () => {
      void getIpcServices()?.app.setWindowBadge(ZERO);
    };
  }, []);
}
