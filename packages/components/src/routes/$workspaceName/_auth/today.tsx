import { Navigate, createFileRoute } from '@tanstack/react-router';
import { useAtomValue, useSetAtom } from 'jotai';
import { lazy, useEffect } from 'react';
import { parseTodayDate } from '@lody/shared';
import { todayFeatureEnabledAtom } from '@/atoms/settings';
import { todayPinnedAtom, todayPinnedTargetAtom } from '@/atoms/sidebar-state';
import { todayRouteOutcome } from '@/components/today/today-stream';
import { useIsCompactDesktop } from '@/hooks/use-mobile';
import { RouteSuspense } from '@/components/route-suspense';

const LazyTodayPage = lazy(async () => {
  const module = await import('@/components/today/today-page');
  return { default: module.TodayPage };
});

export type TodaySearch = { member?: string; date?: string };

export const Route = createFileRoute('/$workspaceName/_auth/today')({
  validateSearch: (search: Record<string, unknown>): TodaySearch => ({
    ...(typeof search.member === 'string' && search.member ? { member: search.member } : {}),
    ...(typeof search.date === 'string' && parseTodayDate(search.date)
      ? { date: search.date }
      : {}),
  }),
  component: TodayRoute,
});

function TodayRoute() {
  const enabled = useAtomValue(todayFeatureEnabledAtom);
  const pinned = useAtomValue(todayPinnedAtom);
  const { workspaceName } = Route.useParams();
  const search = Route.useSearch();
  const compact = useIsCompactDesktop();
  const setPinnedTarget = useSetAtom(todayPinnedTargetAtom);
  const outcome = todayRouteOutcome({ enabled, pinned, compact });
  useEffect(() => {
    // Pinned beside the sidebar: the column shows the requested day instead.
    if (outcome === 'to-column') setPinnedTarget({ member: search.member, date: search.date });
  }, [outcome, search.date, search.member, setPinnedTarget]);
  if (outcome !== 'page') {
    return <Navigate to="/$workspaceName/chat" params={{ workspaceName }} replace />;
  }
  return (
    <RouteSuspense>
      <LazyTodayPage memberId={search.member} anchorDate={search.date} />
    </RouteSuspense>
  );
}
