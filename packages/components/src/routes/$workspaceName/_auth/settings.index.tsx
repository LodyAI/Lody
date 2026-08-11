import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useIsMobile } from '@/hooks/use-mobile';
import { SettingsCategoryList } from '@/components/settings/settings-category-list';

export const Route = createFileRoute('/$workspaceName/_auth/settings/')({
  component: SettingsIndexComponent,
});

function SettingsIndexComponent() {
  const isMobile = useIsMobile();
  const { workspaceName } = Route.useParams();

  if (!isMobile) {
    return (
      <Navigate
        to="/$workspaceName/settings/preferences"
        params={{ workspaceName }}
        search={(prev) => prev}
        replace
      />
    );
  }

  return <SettingsCategoryList workspaceName={workspaceName} />;
}
