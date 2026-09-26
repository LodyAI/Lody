import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { docMetaCacheScopeAtom } from '@/atoms/doc-meta';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms';
import { useWorkspaceSyncStuckReport } from '@/hooks/use-workspace-sync-stuck-report';
import { resolveWorkspaceDataScope } from '@/lib/workspace-data-scope';
import { useWorkspaceRouteTargetSlug } from '../providers/workspace-route-target';

/**
 * Renders nothing. Mounted beside the workspace layout rather than inside the
 * sidebar, which compact and mobile layouts unmount while it is closed — the
 * user is stuck behind the content placeholder either way. Readiness is the
 * route's own (`useResolvedWorkspaceScope`), so this never opens a second
 * organization query.
 */
export function WorkspaceSyncStuckReporter(): null {
  const routeTargetSlug = useWorkspaceRouteTargetSlug();
  const atomWorkspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const docMetaScope = useAtomValue(docMetaCacheScopeAtom);
  const targetSlug = routeTargetSlug ?? atomWorkspaceSlug ?? null;
  const scope = useMemo(
    () =>
      targetSlug
        ? resolveWorkspaceDataScope({
            targetSlug,
            runtime,
            docMetaScope,
            organizationsReady: currentWorkspaceId !== null,
            expectedWorkspaceId: currentWorkspaceId,
          })
        : null,
    [currentWorkspaceId, docMetaScope, runtime, targetSlug]
  );
  useWorkspaceSyncStuckReport({
    targetSlug,
    scope,
    workspaceId: runtime?.workspaceId ?? null,
    organizationsReady: currentWorkspaceId !== null,
    docMetaScanErrorType:
      docMetaScope && docMetaScope.runtime === runtime
        ? (docMetaScope.scanFailure?.errorType ?? null)
        : null,
  });
  return null;
}
