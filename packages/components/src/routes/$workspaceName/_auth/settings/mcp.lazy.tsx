import { createLazyFileRoute } from '@tanstack/react-router';
import { McpSetting } from '@/components/settings/mcp-setting';

export const Route = createLazyFileRoute('/$workspaceName/_auth/settings/mcp')({
  component: McpSetting,
});
