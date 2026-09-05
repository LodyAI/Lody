import { createFileRoute } from '@tanstack/react-router';
import { lazy } from 'react';
import { RouteSuspense } from '@/components/route-suspense';

const LazyArchiveView = lazy(async () => {
  const module = await import('@/components/archive/archive-view');
  return { default: module.ArchiveView };
});

export const Route = createFileRoute('/$workspaceName/_auth/archive')({
  component: ArchiveRoute,
});

function ArchiveRoute() {
  return (
    <RouteSuspense scope="content">
      <LazyArchiveView />
    </RouteSuspense>
  );
}
