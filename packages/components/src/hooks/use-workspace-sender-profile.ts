import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import type { WorkspaceId } from '@lody/shared';
import { useCloudQuery, usePlatform } from '@lody/platform/react';
import { userAtom } from '@/atoms';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useWorkspaceLocalAccountId } from '@/lib/e2ee-account';
import {
  buildWorkspaceSenderScopeKey,
  readRetainedSenderProfile,
  readRetainedWorkspaceMemberUser,
  subscribeRetainedSenderProfile,
  subscribeRetainedWorkspaceMembers,
  writeRetainedSenderProfile,
  type CachedSenderProfile,
} from '@/lib/workspace-sender-identity';

export function useWorkspaceSenderProfile({
  userId,
  workspaceId,
  enabled = true,
}: {
  userId: string | null | undefined;
  workspaceId?: WorkspaceId | null;
  enabled?: boolean;
}): CachedSenderProfile | undefined {
  const platform = usePlatform();
  const accountId = useWorkspaceLocalAccountId();
  const currentUser = useAtomValue(userAtom);
  const normalizedUserId = userId?.trim() || null;
  const scopeKey = useMemo(
    () => (enabled ? buildWorkspaceSenderScopeKey(accountId, workspaceId) : null),
    [accountId, enabled, workspaceId]
  );

  const userInfo = useCloudQuery(
    cloudOperations.auth.getUserById,
    enabled && normalizedUserId && workspaceId ? { userId: normalizedUserId, workspaceId } : 'skip'
  );

  useEffect(() => {
    if (!enabled || !scopeKey || !normalizedUserId || userInfo === undefined) {
      return;
    }
    writeRetainedSenderProfile(platform.cloudApi, scopeKey, normalizedUserId, userInfo);
  }, [enabled, normalizedUserId, platform.cloudApi, scopeKey, userInfo]);

  const subscribeProfile = useCallback(
    (onChange: () => void) =>
      subscribeRetainedSenderProfile(platform.cloudApi, scopeKey, normalizedUserId, onChange),
    [normalizedUserId, platform.cloudApi, scopeKey]
  );
  const getProfileSnapshot = useCallback(
    () => readRetainedSenderProfile(platform.cloudApi, scopeKey, normalizedUserId),
    [normalizedUserId, platform.cloudApi, scopeKey]
  );
  const retainedProfile = useSyncExternalStore(
    subscribeProfile,
    getProfileSnapshot,
    getProfileSnapshot
  );

  const subscribeDirectory = useCallback(
    (onChange: () => void) =>
      subscribeRetainedWorkspaceMembers(platform.cloudApi, scopeKey, onChange),
    [platform.cloudApi, scopeKey]
  );
  const getDirectorySnapshot = useCallback(
    () => readRetainedWorkspaceMemberUser(platform.cloudApi, scopeKey, normalizedUserId),
    [normalizedUserId, platform.cloudApi, scopeKey]
  );
  const directoryMember = useSyncExternalStore(
    subscribeDirectory,
    getDirectorySnapshot,
    getDirectorySnapshot
  );

  const matchingCurrentUser =
    normalizedUserId &&
    currentUser?.id === normalizedUserId &&
    (!accountId || accountId === currentUser.id)
      ? currentUser
      : null;

  return useMemo(() => {
    if (!enabled || !normalizedUserId) {
      return undefined;
    }
    if (userInfo !== undefined) {
      return userInfo;
    }
    if (retainedProfile !== undefined) {
      return retainedProfile;
    }
    if (directoryMember !== undefined) {
      return {
        id: directoryMember.userId,
        name: directoryMember.name?.trim() || matchingCurrentUser?.name || undefined,
        email: matchingCurrentUser?.email ?? undefined,
        image: directoryMember.image ?? matchingCurrentUser?.image ?? null,
      };
    }
    if (matchingCurrentUser) {
      return {
        id: matchingCurrentUser.id,
        name: matchingCurrentUser.name,
        email: matchingCurrentUser.email,
        image: matchingCurrentUser.image,
      };
    }
    return undefined;
  }, [directoryMember, enabled, matchingCurrentUser, normalizedUserId, retainedProfile, userInfo]);
}
