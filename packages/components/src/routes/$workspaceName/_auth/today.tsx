import { Navigate, createFileRoute } from '@tanstack/react-router';
import { useAtomValue } from 'jotai';
import { lazy } from 'react';
import { parseTodayDate } from '@lody/shared';
import { todayFeatureEnabledAtom } from '@/atoms/settings';
import { todayPinnedAtom } from '@/atoms/sidebar-state';
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
  // Pinned: Today already shows beside the sidebar; never show it twice.
  if (!enabled || pinned) {
    return <Navigate to="/$workspaceName/chat" params={{ workspaceName }} replace />;
  }
  return (
    <RouteSuspense>
      <LazyTodayPage memberId={search.member} anchorDate={search.date} />
    </RouteSuspense>
  );
}
