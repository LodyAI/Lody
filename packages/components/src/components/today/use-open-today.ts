import { useNavigate } from '@tanstack/react-router';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback } from 'react';
import { todayFeatureEnabledAtom } from '@/atoms/settings';
import { todayPinnedAtom, todayPinnedTargetAtom } from '@/atoms/sidebar-state';
import { useIsCompactDesktop } from '@/hooks/use-mobile';
import { todayRouteOutcome } from './today-stream';

/**
 * Opens a member's day. While Today is pinned beside the sidebar of this
 * workspace the column shows it and the main area stays where it is; otherwise
 * the Today page opens. An empty target means today, the viewer's own page.
 * Behavior: specs/today-outline.md (Switch and entry).
 */
export function useOpenToday(): (input: {
  workspaceSlug: string;
  /** The day belongs to the workspace this window shows. */
  sameWorkspace: boolean;
  member?: string;
  date?: string;
}) => void {
  const navigate = useNavigate();
  const enabled = useAtomValue(todayFeatureEnabledAtom);
  const pinned = useAtomValue(todayPinnedAtom);
  const compact = useIsCompactDesktop();
  const setPinnedTarget = useSetAtom(todayPinnedTargetAtom);
  return useCallback(
    ({ workspaceSlug, sameWorkspace, member, date }) => {
      const target = { ...(member ? { member } : {}), ...(date ? { date } : {}) };
      if (sameWorkspace && todayRouteOutcome({ enabled, pinned, compact }) === 'to-column') {
        setPinnedTarget(target);
        return;
      }
      void navigate({
        to: '/$workspaceName/today',
        params: { workspaceName: workspaceSlug },
        search: target,
      });
    },
    [compact, enabled, navigate, pinned, setPinnedTarget]
  );
}
