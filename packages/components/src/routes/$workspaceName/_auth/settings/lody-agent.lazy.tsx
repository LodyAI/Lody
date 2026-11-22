import { createLazyFileRoute } from '@tanstack/react-router';
import { Harness } from '@/components/harness';

export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/lody-agent')({
  component: Harness,
});
