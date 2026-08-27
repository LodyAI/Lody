import { useAtomValue } from 'jotai';
import type { WorkspaceId } from '@lody/shared';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { docMetaCacheScopeAtom } from '@/atoms/doc-meta';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useWorkspaceRouteTargetSlug } from '../providers/workspace-route-target';
import { resolveWorkspaceDataScope } from '@/lib/workspace-data-scope';

export type WorkspaceScopeOptions = {
  workspaceId?: WorkspaceId | null;
  enabled?: boolean;
};

/**
 * Fail closed for workspace-scoped consumers mounted under a workspace route.
 * Provider-external consumers, including RuntimeProvider, retain their existing behavior.
 */
export function useResolvedWorkspaceScope(options: WorkspaceScopeOptions = {}): {
  workspaceId: WorkspaceId | null;
  enabled: boolean;
} {
  const routeTargetSlug = useWorkspaceRouteTargetSlug();
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const docMetaScope = useAtomValue(docMetaCacheScopeAtom);
  const requestedEnabled = options.enabled ?? true;

  if (routeTargetSlug === null) {
    return {
      workspaceId: options.workspaceId === undefined ? currentWorkspaceId : options.workspaceId,
      enabled: requestedEnabled,
    };
  }

  const scope = resolveWorkspaceDataScope({
    targetSlug: routeTargetSlug,
    runtime,
    docMetaScope,
    organizationsReady: false,
    expectedWorkspaceId: null,
  });
  const readyWorkspaceId = scope.status === 'ready' ? scope.workspaceId : null;
  const requestedWorkspaceId =
    options.workspaceId === undefined ? readyWorkspaceId : options.workspaceId;

  return {
    workspaceId: requestedWorkspaceId,
    enabled:
      requestedEnabled && readyWorkspaceId !== null && requestedWorkspaceId === readyWorkspaceId,
  };
}
