import { useCallback } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useAtomValue, useSetAtom } from 'jotai';
import type { WorkspaceId } from '@lody/shared';
import { currentWorkspaceIdAtom, setWorkspaceContextAtom } from '@/atoms';
import { isNavigableWorkspaceSlug, writePreferredWorkspaceSlug } from '@/lib/workspace';
import { useOrganization } from './useOrganization';

type UseWorkspaceSwitcherOptions = {
  targetSlug?: string;
};

/** One entry point for workspace identity, active-organization, and route transitions. */
export function useWorkspaceSwitcher(options?: UseWorkspaceSwitcherOptions) {
  const organizationState = useOrganization(options);
  const { organizations, switchOrganization } = organizationState;
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom);
  const setWorkspaceContext = useSetAtom(setWorkspaceContextAtom);
  const router = useRouter();

  const switchWorkspace = useCallback(
    (workspaceId: string): boolean => {
      const target = organizations?.find((organization) => organization.id === workspaceId);
      if (!target?.slug || !isNavigableWorkspaceSlug(target.slug)) return false;
      if (target.id === currentWorkspaceId) return true;

      writePreferredWorkspaceSlug(target.slug);
      setWorkspaceContext({
        slug: target.slug,
        workspaceId: target.id as WorkspaceId,
      });
      void switchOrganization(target.id);
      void router.navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: target.slug },
      });
      return true;
    },
    [currentWorkspaceId, organizations, router, setWorkspaceContext, switchOrganization]
  );

  return { ...organizationState, switchWorkspace };
}
