import { createLazyFileRoute } from '@tanstack/react-router';
import { AccountSettingsComponent } from '@/components/settings/account-setting';

export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/people')({
  component: PeopleSettingsRoute,
});

function PeopleSettingsRoute() {
  return <AccountSettingsComponent surface="workspace" />;
}
