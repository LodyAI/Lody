import { createLazyFileRoute } from '@tanstack/react-router';
import { ShareManagementSetting } from '@/components/settings/share-management-setting';

export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/shares')({
  component: ShareManagementSetting,
});
