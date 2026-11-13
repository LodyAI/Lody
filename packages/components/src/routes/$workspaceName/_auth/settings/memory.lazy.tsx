import { createLazyFileRoute } from '@tanstack/react-router';
import { MemorySetting } from '@/components/settings/memory-setting';
export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/memory')({
  component: MemorySetting,
});
