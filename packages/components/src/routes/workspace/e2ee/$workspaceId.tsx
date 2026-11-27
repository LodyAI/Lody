import { createFileRoute } from '@tanstack/react-router';
// Relative on purpose: the e2ee-client browser suite bundles this route and replaces
// every `@/` import with its injected ports.
import { E2eeWorkspaceConsole } from '../../../components/pages/e2ee-workspace-console';
import {
  E2EE_CONSOLE_TABS,
  type E2eeConsoleTab,
} from '../../../components/pages/e2ee-console-section';
import { useE2eeWorkspaceRemoval } from '../../../components/pages/e2ee-workspace-removal';

const CONSOLE_TAB_SET = new Set<string>(E2EE_CONSOLE_TABS);

export const Route = createFileRoute('/workspace/e2ee/$workspaceId')({
  validateSearch: (search: Record<string, unknown>): { tab?: E2eeConsoleTab } =>
    typeof search.tab === 'string' && CONSOLE_TAB_SET.has(search.tab)
      ? { tab: search.tab as E2eeConsoleTab }
      : {},
  component: WorkspaceControlRoute,
});

function WorkspaceControlRoute() {
  const { workspaceId } = Route.useParams();
  const { tab } = typeof Route.useSearch === 'function' ? Route.useSearch() : {};
  const workspaceRemoval = useE2eeWorkspaceRemoval();
  return (
    <E2eeWorkspaceConsole
      workspaceId={workspaceId}
      presentation="page"
      {...(tab ? { initialTab: tab } : {})}
      {...(workspaceRemoval ? { workspaceRemoval } : {})}
    />
  );
}
