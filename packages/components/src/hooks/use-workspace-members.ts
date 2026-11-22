import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { usePlatform } from '@lody/platform/react';
import { useWorkspaceLocalAccountId } from '@/lib/e2ee-account';
import { preloadAvatarBlobUrl, resolveAvatarBlobUrl } from '@/lib/avatar-cache';
import { cloudOperations } from '@/lib/cloud-api-operations';
import {
  buildWorkspaceSenderScopeKey,
  readRetainedWorkspaceMembers,
  subscribeRetainedWorkspaceMembers,
  writeRetainedWorkspaceMembers,
} from '@/lib/workspace-sender-identity';
import { useResolvedWorkspaceScope } from './use-resolved-workspace-scope';
import { useTranslation } from 'react-i18next';
import { useAuthClient } from '../providers/convex-provider';

export type WorkspaceMember = {
  userId: string;
  /** Display name, falling back to the email when the account has no name. */
  name: string;
  displayName?: string | null;
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
  const scopeKey = useMemo(
    () => (enabled ? buildWorkspaceSenderScopeKey(accountId, scope.workspaceId) : null),
    [accountId, enabled, scope.workspaceId]
  );
  useEffect(() => {
    if (!scopeKey || query?.data === undefined) return;
    writeRetainedWorkspaceMembers(platform.cloudApi, scopeKey, query.data);
  }, [platform.cloudApi, query?.data, scopeKey]);
  const subscribeRetained = useCallback(
    (onChange: () => void) =>
      subscribeRetainedWorkspaceMembers(platform.cloudApi, scopeKey, onChange),
    [platform.cloudApi, scopeKey]
  );
  const getRetainedSnapshot = useCallback(
    () => readRetainedWorkspaceMembers(platform.cloudApi, scopeKey),
    [platform.cloudApi, scopeKey]
  );
  const retainedRows = useSyncExternalStore(
    subscribeRetained,
    getRetainedSnapshot,
    getRetainedSnapshot
  );
  const rows = query ? (enabled ? (query.data ?? retainedRows) : undefined) : undefined;
  const live = query !== undefined;
  const error = query?.error;
  const retry = query?.retry;
  const result = useMemo(() => {
    const members: WorkspaceMember[] = live
      ? (rows ?? []).map((row) => {
          const displayName = row.name?.trim() || null;
          return {
            ...row,
            displayName,
            name: displayName ?? t('sessions.access.unknownMember'),
          };
        })
      : (activeOrganization?.members ?? []).flatMap((member) => {
          const name = member.user?.name?.trim() || member.user?.email?.trim() || '';
          return name
            ? [
                {
                  userId: member.userId,
                  name,
                  displayName: name,
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

  useEffect(() => {
    for (const member of result.members) {
      if (!member.image) continue;
      void resolveAvatarBlobUrl(member.image)
        .then(() => preloadAvatarBlobUrl(member.image))
        .catch(() => {});
    }
  }, [result.members]);

  return result;
}
