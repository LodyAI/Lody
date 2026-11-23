import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { docMetaCacheScopeAtom } from '@/atoms/doc-meta';
import { activeWorkspaceRuntimeAtom, workspaceRuntimeInitFailureAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import {
  resolveWorkspaceDataScope,
  type WorkspaceDataScopeState,
} from '@/lib/workspace-data-scope';
import { useWorkspaceRouteTargetSlug } from '../providers/workspace-route-target';

export type WorkspaceDataScopeObservation = {
  targetSlug: string | null;
  scope: WorkspaceDataScopeState | null;
  /** The active runtime's workspace id, which may not be the target's yet. */
  workspaceId: string | null;
  organizationsReady: boolean;
  docMetaScanErrorType: string | null;
  runtimeInitErrorType: string | null;
};

/**
 * The workspace data scope with the diagnostics behind it, for the leaves that
 * explain a scope stuck short of `ready`. Readiness inputs match
 * `useResolvedWorkspaceScope` (`currentWorkspaceIdAtom` as the organization
 * signal), so no second organization query starts here.
 */
export function useWorkspaceDataScopeState(): WorkspaceDataScopeObservation {
  const routeTargetSlug = useWorkspaceRouteTargetSlug();
  const atomWorkspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const runtimeInitFailure = useAtomValue(workspaceRuntimeInitFailureAtom);
  const docMetaScope = useAtomValue(docMetaCacheScopeAtom);
  const targetSlug = routeTargetSlug ?? atomWorkspaceSlug ?? null;
  const scope = useMemo(
    () =>
      targetSlug
        ? resolveWorkspaceDataScope({
            targetSlug,
            runtime,
            runtimeInitFailure,
            docMetaScope,
            organizationsReady: currentWorkspaceId !== null,
            expectedWorkspaceId: currentWorkspaceId,
          })
        : null,
    [currentWorkspaceId, docMetaScope, runtime, runtimeInitFailure, targetSlug]
  );
  return {
    targetSlug,
    scope,
    workspaceId: runtime?.workspaceId ?? null,
    organizationsReady: currentWorkspaceId !== null,
    docMetaScanErrorType:
      docMetaScope && docMetaScope.runtime === runtime
        ? (docMetaScope.scanFailure?.errorType ?? null)
        : null,
    runtimeInitErrorType:
      runtimeInitFailure && runtimeInitFailure.workspaceSlug === targetSlug
        ? runtimeInitFailure.errorType
        : null,
  };
}
