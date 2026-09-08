import { lazy } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { RouteSuspense } from '@/components/route-suspense';

const LazyKeyboardShortcutsSetting = lazy(async () => {
  const module = await import('@/components/settings/keyboard-shortcuts-setting');
  return { default: module.KeyboardShortcutsSetting };
});

export const Route = createFileRoute('/$workspaceName/_auth/settings/keyboard-shortcuts')({
  component: KeyboardShortcutsSettingsRoute,
});

function KeyboardShortcutsSettingsRoute() {
  return (
    <RouteSuspense>
      <LazyKeyboardShortcutsSetting />
    </RouteSuspense>
  );
}
