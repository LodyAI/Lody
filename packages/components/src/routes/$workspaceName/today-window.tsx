import { createFileRoute } from '@tanstack/react-router';
import { useAtomValue } from 'jotai';
import { lazy, useEffect } from 'react';
import { todayFeatureEnabledAtom } from '@/atoms/settings';
import { RouteSuspense } from '@/components/route-suspense';
import { validateTodaySearch } from '@/components/today/today-stream';

const LazyTodayWindow = lazy(async () => {
  const module = await import('@/components/today/today-window');
  return { default: module.TodayWindow };
});

/**
 * The desktop's standalone Today window. It sits outside the `_auth` workspace
 * layout on purpose: no sidebar, notifications, badges, command palette or
 * window-ownership election, only what the day stream reads.
 */
export const Route = createFileRoute('/$workspaceName/today-window')({
  validateSearch: validateTodaySearch,
  component: TodayWindowRoute,
});

function TodayWindowRoute() {
  const enabled = useAtomValue(todayFeatureEnabledAtom);
  const search = Route.useSearch();
  useEffect(() => {
    // Turning the experiment off unmounts every Today surface: the window closes.
    if (!enabled) window.close();
  }, [enabled]);
  if (!enabled) return null;
  return (
    <RouteSuspense>
      <LazyTodayWindow memberId={search.member} anchorDate={search.date} />
    </RouteSuspense>
  );
}
