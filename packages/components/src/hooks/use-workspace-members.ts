import { useMemo } from 'react';

import { useAuthClient } from '../providers/convex-provider';

export type WorkspaceMember = {
  userId: string;
  /** Display name, falling back to the email when the account has no name. */
  name: string;
  email?: string | null;
  image?: string | null;
};

/**
 * Workspace members of the active organization, shaped for owner/assignee
 * pickers. Reads better-auth's organization state directly (same source as
 * `use-session-sharing.ts`) rather than the heavier `useOrganization()`, which
 * also drives org list retries and mutations.
 *
 * `isMultiMember` is the gate for ownership UI: a solo workspace has nobody to
 * hand a session to, so those controls must not render at all.
 */
export function useWorkspaceMembers(): {
  members: WorkspaceMember[];
  isMultiMember: boolean;
  isLoading: boolean;
} {
  const authClient = useAuthClient();
  const { data: activeOrganization, isPending } = authClient.useActiveOrganization();
  const rawMembers = activeOrganization?.members;

  return useMemo(() => {
    const members: WorkspaceMember[] = [];
    for (const member of rawMembers ?? []) {
      const name = member.user?.name?.trim() || member.user?.email?.trim() || '';
      if (!name) continue;
      members.push({
        userId: member.userId,
        name,
        email: member.user?.email ?? null,
        image: member.user?.image ?? null,
      });
    }
    members.sort((a, b) => a.name.localeCompare(b.name));
    return {
      members,
      isMultiMember: members.length > 1,
      isLoading: !!isPending || rawMembers === undefined,
    };
  }, [rawMembers, isPending]);
}
