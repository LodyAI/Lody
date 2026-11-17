import { useMemo, useRef } from 'react';
import { usePlatform } from '@lody/platform/react';
import { useWorkspaceLocalAccountId } from '@/lib/e2ee-account';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useResolvedWorkspaceScope } from './use-resolved-workspace-scope';
import { useTranslation } from 'react-i18next';
import { useAuthClient } from '../providers/convex-provider';

export type WorkspaceMember = {
  userId: string;
  /** Display name, falling back to the email when the account has no name. */
  name: string;
  email?: string | null;
  image?: string | null;
};

/** Directory labels are optional metadata, never membership or grant authority. */
export function useWorkspaceMembers() {
  const platform = usePlatform();
  const scope = useResolvedWorkspaceScope();
  const accountId = useWorkspaceLocalAccountId();
  const { t } = useTranslation();
  const authClient = useAuthClient();
  const { data: activeOrganization, isPending } = authClient.useActiveOrganization();
  const enabled =
    platform.capabilities.has('teamSharing') && scope.enabled && !!accountId && !!scope.workspaceId;
  const query = platform.cloudApi?.useOptionalAuthenticatedQuery?.(
    cloudOperations.workspaceMembers.list,
    enabled ? { workspaceId: scope.workspaceId!, accountId: accountId! } : 'skip'
  );
  const key = JSON.stringify([accountId, scope.workspaceId]);
  const retained = useRef<{
    key: string;
    api: typeof platform.cloudApi;
    rows: NonNullable<typeof query>['data'];
  } | null>(null);
  if (retained.current?.key !== key || retained.current?.api !== platform.cloudApi || !enabled)
    retained.current = null;
  if (enabled && query?.data !== undefined)
    retained.current = { key, api: platform.cloudApi, rows: query.data };
  const rows = query ? (enabled ? (query.data ?? retained.current?.rows) : undefined) : undefined;
  const live = query !== undefined;
  const error = query?.error;
  const retry = query?.retry;
  return useMemo(() => {
    const members: WorkspaceMember[] = live
      ? (rows ?? []).map((row) => ({
          ...row,
          name: row.name?.trim() || t('sessions.access.unknownMember'),
        }))
      : (activeOrganization?.members ?? []).flatMap((member) => {
          const name = member.user?.name?.trim() || member.user?.email?.trim() || '';
          return name
            ? [
                {
                  userId: member.userId,
                  name,
                  email: member.user?.email,
                  image: member.user?.image,
                },
              ]
            : [];
        });
    members.sort((a, b) => a.name.localeCompare(b.name));
    return {
      members,
      isMultiMember: members.length > 1,
      isLoading: live
        ? enabled && rows === undefined && !error
        : !!isPending || activeOrganization?.members === undefined,
      error: !!error,
      retry,
    };
  }, [rows, live, error, retry, enabled, activeOrganization, isPending, t]);
}
