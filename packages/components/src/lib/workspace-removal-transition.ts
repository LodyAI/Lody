import type { PlatformE2eeWorkspaces } from '@lody/platform';
import type { LodyAuthClient } from './auth';

export function hasEncryptedContentMode(workspace: object | null | undefined): boolean {
  return !!workspace && 'contentMode' in workspace && workspace.contentMode === 'e2ee';
}

export async function deleteAccountWorkspace(
  organizationId: string,
  isEncrypted: boolean,
  authClient: LodyAuthClient,
  e2eeWorkspaces: PlatformE2eeWorkspaces | undefined
) {
  if (!isEncrypted) return authClient.organization.delete({ organizationId });
  if (!e2eeWorkspaces) throw new Error('Encrypted workspace deletion unavailable');
  return {
    data: await e2eeWorkspaces.deleteWorkspace({ workspaceId: organizationId }),
    error: null,
  };
}

export type WorkspaceRemovalOrganization = {
  id: string;
  slug?: string | null;
};

export type WorkspaceRemovalTransition<TOrganization extends WorkspaceRemovalOrganization> = {
  isActiveOrganization: boolean;
  removedSlug: string | null;
  fallbackOrganization: TOrganization | undefined;
};

export function resolveWorkspaceRemovalTransition<
  TOrganization extends WorkspaceRemovalOrganization,
>({
  organizationId,
  organizations,
  activeOrganization,
}: {
  organizationId: string;
  organizations: readonly TOrganization[] | undefined;
  activeOrganization: WorkspaceRemovalOrganization | null | undefined;
}): WorkspaceRemovalTransition<TOrganization> {
  const organization = organizations?.find((org) => org.id === organizationId);
  const isActiveOrganization = activeOrganization?.id === organizationId;

  return {
    isActiveOrganization,
    removedSlug:
      organization?.slug ?? (isActiveOrganization ? (activeOrganization.slug ?? null) : null),
    fallbackOrganization: organizations?.find((org) => org.id !== organizationId),
  };
}
