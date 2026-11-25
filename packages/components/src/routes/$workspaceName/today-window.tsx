import { createFileRoute } from '@tanstack/react-router';
import { useAtomValue } from 'jotai';
import { lazy, useEffect } from 'react';
import { RouteSuspense } from '@/components/route-suspense';
import { todayFeatureEnabledAtom } from '@/atoms/settings';
import { validateTodaySearch } from '@/components/today/today-stream';
import { markTodayWindowBoot } from '@/lib/today/today-window-boot-timeline';
import { closeTodayWindow, isTodayWindow } from '@/lib/desktop-window';

const loadTodayWindow = () =>
  import('@/components/today/today-window').then(({ TodayWindow }) => ({ default: TodayWindow }));
const LazyTodayWindow = lazy(loadTodayWindow);
if (isTodayWindow()) void loadTodayWindow().catch(() => {});

/**
 * The desktop's standalone Today window. It sits outside the `_auth` workspace
 * layout on purpose: no sidebar, notifications, badges, command palette or
 * window-ownership election, only what the day stream reads.
 */
export const Route = createFileRoute('/$workspaceName/today-window')({
  validateSearch: (search) => ({
    ...validateTodaySearch(search),
    bindingId:
      typeof search.bindingId === 'number' && Number.isSafeInteger(search.bindingId)
        ? search.bindingId
        : 0,
  }),
  component: TodayWindowRoute,
});

function TodayWindowRoute() {
  const enabled = useAtomValue(todayFeatureEnabledAtom);
  const search = Route.useSearch();
  markTodayWindowBoot('route');
  useEffect(() => {
    // Turning the experiment off unmounts every Today surface: the window closes.
    if (!enabled) closeTodayWindow();
  }, [enabled]);
  if (!enabled) return null;
  return (
    <RouteSuspense>
      <LazyTodayWindow
        key={search.bindingId}
        bindingId={search.bindingId}
        memberId={search.member}
        anchorDate={search.date}
      />
    </RouteSuspense>
  );
}
