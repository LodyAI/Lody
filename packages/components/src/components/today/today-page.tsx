import { useNavigate, useParams } from '@tanstack/react-router';
import { useSetAtom } from 'jotai';
import { todayPinnedAtom } from '@/atoms/sidebar-state';
import { TodayView } from './today-view';

/**
 * Full-page Today surface. Behavior: specs/today-outline.md.
 * Leaving the route unmounts every Today subscription and releases its pages.
 */
export function TodayPage(props: { memberId?: string; anchorDate?: string; focus?: string }) {
  const navigate = useNavigate();
  const setPinned = useSetAtom(todayPinnedAtom);
  const { workspaceName } = useParams({ strict: false }) as { workspaceName: string };
  return (
    <TodayView
      target={{ member: props.memberId, date: props.anchorDate, focus: props.focus }}
      onTogglePin={() => {
        // Pinning moves Today beside the sidebar; the main area returns to chat.
        setPinned(true);
        void navigate({ to: '/$workspaceName/chat', params: { workspaceName }, replace: true });
      }}
      onNavigate={(target) => {
        void navigate({
          to: '/$workspaceName/today',
          params: { workspaceName },
          search: {
            ...(target.member ? { member: target.member } : {}),
            ...(target.date ? { date: target.date } : {}),
            ...(target.focus ? { focus: target.focus } : {}),
          },
        });
      }}
    />
  );
}
