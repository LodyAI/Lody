import { createFileRoute } from '@tanstack/react-router';
import { ShareManagementSetting } from '@/components/settings/share-management-setting';

export const Route = createFileRoute('/$workspaceName/_auth/settings/shares')({
  component: ShareManagementSetting,
});
