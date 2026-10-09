import { createFileRoute } from '@tanstack/react-router';
import { MemorySetting } from '@/components/settings/memory-setting';
export const Route = createFileRoute('/$workspaceName/_auth/settings/memory')({
  component: MemorySetting,
});
