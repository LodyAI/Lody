import { useEffect } from 'react';
import { useWorkspaceSyncStuckReport } from '@/hooks/use-workspace-sync-stuck-report';
import { useWorkspaceDataScopeState } from '@/hooks/use-workspace-data-scope-state';
import { reportRecoveryOutcome } from '@/lib/recovery-outcome';

/**
 * Renders nothing. Mounted beside the workspace layout rather than inside the
 * sidebar, which compact and mobile layouts unmount while it is closed — the
 * user is stuck behind the content placeholder either way. Readiness is the
 * route's own (`useResolvedWorkspaceScope`), so this never opens a second
 * organization query. It also closes the loop on a boot-time clear: a workspace
 * that reaches `ready` afterwards is that clear's success.
 */
export function WorkspaceSyncStuckReporter(): null {
  const { targetSlug, scope, workspaceId, organizationsReady, docMetaScanErrorType } =
    useWorkspaceDataScopeState();
  useWorkspaceSyncStuckReport({
    targetSlug,
    scope,
    workspaceId,
    organizationsReady,
    docMetaScanErrorType,
  });
  const ready = scope?.status === 'ready';
  useEffect(() => {
    if (ready) reportRecoveryOutcome('ready', null);
  }, [ready]);
  return null;
}
