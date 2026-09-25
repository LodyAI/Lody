import { Navigate, createFileRoute } from '@tanstack/react-router';
import { KeyboardShortcutsSetting } from '@/components/settings/keyboard-shortcuts-setting';
import { useIsMobile } from '@/hooks/use-mobile';

export const Route = createFileRoute('/$workspaceName/_auth/settings/keyboard-shortcuts')({
  component: KeyboardShortcutsSettingsRoute,
});

export function KeyboardShortcutsSettingsRoute() {
  const isMobile = useIsMobile();
  const { workspaceName } = Route.useParams();

  if (isMobile) {
    return (
      <Navigate
        to="/$workspaceName/settings"
        params={{ workspaceName }}
        search={(previous) => previous}
        replace
      />
    );
  }

  return <KeyboardShortcutsSetting />;
}
