import { useMemo } from 'react';
import { useOrganization } from '@/hooks/useOrganization';
import { isLocalAppPlatform } from '@/lib/app-platform';
import { useAuthClient } from '@/providers/convex-provider';

/** The ordinary account workspace removals the lost-access page may start. Neither
 * needs this device's encryption keys; the server checks ownership and billing on
 * every call, so the page's role reading is only a hint for which one to offer. */
export interface E2eeWorkspaceRemoval {
  /** Owner deletion or member leave through the ordinary account path. Rejects with
   * the server's error, or with a transport error whose outcome is unknown. */
  submit(kind: 'delete' | 'leave', workspaceId: string): Promise<void>;
  /** Whether the account still lists the workspace: true listed, false gone, null
   * when the list itself could not be read. Answers a removal with an unknown result. */
  listed(workspaceId: string): Promise<boolean | null>;
  /** Best-effort refresh of the account's workspace list after a confirmed removal. */
  refresh(): void;
}

/** Undefined on the local-only platform, which has no account workspaces to remove. */
export function useE2eeWorkspaceRemoval(): E2eeWorkspaceRemoval | undefined {
  // The platform kind is a build-time constant, so hook order stays stable.
  if (isLocalAppPlatform()) return undefined;
  // oxlint-disable-next-line rules-of-hooks
  return useCloudWorkspaceRemoval();
}

function useCloudWorkspaceRemoval(): E2eeWorkspaceRemoval {
  const { deleteOrganization, leaveOrganization, refetchOrganizations } = useOrganization();
  const authClient = useAuthClient();
  return useMemo(
    () => ({
      submit: async (kind, workspaceId) => {
        if (kind === 'delete') await deleteOrganization(workspaceId);
        else await leaveOrganization(workspaceId);
      },
      listed: async (workspaceId) => {
        try {
          const { data, error } = await authClient.organization.list({
            fetchOptions: { disableSignal: true },
          });
          if (error || !Array.isArray(data)) return null;
          return data.some((organization) => organization.id === workspaceId);
        } catch {
          return null;
        }
      },
      refresh: () => {
        void Promise.resolve()
          .then(() => refetchOrganizations())
          .catch((error: unknown) => console.warn('Workspace list refresh failed', error));
      },
    }),
    [authClient, deleteOrganization, leaveOrganization, refetchOrganizations]
  );
}
