import { createFileRoute } from '@tanstack/react-router';
import { PromptShortcutsSetting } from '@/components/settings/prompt-shortcuts-setting';

export const Route = createFileRoute('/$workspaceName/_auth/settings/prompt-shortcuts')({
  component: PromptShortcutsSetting,
});
