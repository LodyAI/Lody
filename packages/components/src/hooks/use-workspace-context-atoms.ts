import { useEffect, useLayoutEffect } from 'react';
import { useSetAtom } from 'jotai';
import { clearWorkspaceContextForSlugAtom, setWorkspaceContextAtom } from '@/atoms';
import { writePreferredWorkspaceSlug } from '@/lib/workspace';
import type { WorkspaceId } from '@lody/shared';

/** Minimal shape of `convexApi.auth.getWorkspaceAccessBySlug`'s result we depend on. */
type WorkspaceAccessForContext = { status?: string; organizationId?: string } | null | undefined;

/**
 * Establish the workspace-context atoms (`currentWorkspaceSlugAtom` +
 * `currentWorkspaceIdAtom`) from a slug. The `RuntimeProvider` keys the
 * workspace runtime off these atoms — it does NOT read the router — so any
 * surface can drive a workspace by setting them, not only the `$workspaceName`
 * route.
 *
 * Mirrors the slug→atoms sync in `routes/$workspaceName.tsx`; keep the two in step.
 */
export function useWorkspaceContextAtoms(
  workspaceSlug: string | null,
  access: WorkspaceAccessForContext
): void {
  const setWorkspaceContext = useSetAtom(setWorkspaceContextAtom);
  const clearWorkspaceContextForSlug = useSetAtom(clearWorkspaceContextForSlugAtom);

  // Optimistic, before paint: publish the URL target and invalidate any id from
  // the previous route as one observable state change. RuntimeProvider can still
  // resolve this slug through the offline workspace cache.
  useLayoutEffect(() => {
    setWorkspaceContext({ slug: workspaceSlug, workspaceId: null });
  }, [setWorkspaceContext, workspaceSlug]);

  useEffect(() => {
    if (workspaceSlug && access?.status === 'member' && access.organizationId) {
      writePreferredWorkspaceSlug(workspaceSlug);
      setWorkspaceContext({
        slug: workspaceSlug,
        workspaceId: access.organizationId as WorkspaceId,
      });
    }
  }, [access, setWorkspaceContext, workspaceSlug]);

  // A route cleanup may run after the next route has already published its
  // target. Only clear the scope owned by this hook instance.
  useEffect(() => {
    if (!workspaceSlug) return undefined;
    return () => {
      clearWorkspaceContextForSlug(workspaceSlug);
    };
  }, [clearWorkspaceContextForSlug, workspaceSlug]);
}
