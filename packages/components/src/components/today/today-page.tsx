import { useNavigate, useParams } from '@tanstack/react-router';
import { TodayView } from './today-view';

/**
 * Full-page Today surface. Behavior: specs/today-outline.md.
 * Leaving the route unmounts every Today subscription and releases its pages.
 */
export function TodayPage(props: { memberId?: string; anchorDate?: string }) {
  const navigate = useNavigate();
  const { workspaceName } = useParams({ strict: false }) as { workspaceName: string };
  return (
    <TodayView
      target={{ member: props.memberId, date: props.anchorDate }}
      onNavigate={(target) => {
        void navigate({
          to: '/$workspaceName/today',
          params: { workspaceName },
          search: {
            ...(target.member ? { member: target.member } : {}),
            ...(target.date ? { date: target.date } : {}),
          },
        });
      }}
    />
  );
}
