import type { CloudPort, CloudGithubTokenPort } from '@lody/platform';

/** Encrypted CLI keys cannot delegate another account's personal GitHub identity. */
export function encryptedGithubTokenPort(
  source: CloudGithubTokenPort | null,
  accountId?: string
): CloudGithubTokenPort | null {
  return (
    source && {
      createTokenManager(workspaceId) {
        const manager = source.createTokenManager(workspaceId);
        const ownAccount = (requester: string) => !!accountId && requester === accountId;
        return {
          startAutoRefresh: () => manager.startAutoRefresh(),
          shutdown: () => manager.shutdown(),
          retainRepoOwner: (repo) => manager.retainRepoOwner(repo),
          invalidate: (repo, context) => manager.invalidate(repo, context),
          invalidateAll: () => manager.invalidateAll(),
          getAppTokenForRepo: (repo) => manager.getAppTokenForRepo(repo),
          getAppTokenInfoForRepo: (repo) => manager.getAppTokenInfoForRepo(repo),
          getCredentialPolicy: (context, signal) =>
            ownAccount(context.requesterUserId)
              ? manager.getCredentialPolicy(context, signal)
              : Promise.resolve({ personalEnabled: false }),
          getCredentialCandidate: (repo, context, source, invalidated) => {
            if (ownAccount(context.requesterUserId))
              return manager.getCredentialCandidate(repo, context, source, invalidated);
            if (source === 'personal')
              return Promise.resolve({ available: false, reason: 'personal_unavailable' });
            return manager
              .getAppTokenForRepo(repo)
              .then((token) => ({ token, tokenSource: 'app' as const }));
          },
          getWriteTokenForRepo: (repo, context) =>
            ownAccount(context.requesterUserId)
              ? manager.getWriteTokenForRepo(repo, context)
              : manager.getAppTokenForRepo(repo),
          getWriteTokenInfoForRepo: (repo, context) =>
            ownAccount(context.requesterUserId)
              ? manager.getWriteTokenInfoForRepo(repo, context)
              : manager.getAppTokenInfoForRepo(repo),
        };
      },
    }
  );
}

/**
 * Cloud capabilities an encrypted workspace runtime may keep. Unimplemented
 * channels cannot inherit their ordinary plaintext sinks.
 *
 * - The attachment relay base URL stays: encrypted attachments upload and download
 *   opaque parts there with the workspace-scoped attachment token, and
 *   MessageHandler fences every plaintext attachment path in encrypted workspaces.
 * - Remote preview tunnels stay available: encrypted preview controls arrive through
 *   verified feature RPC and reuse the Quick Tunnel
 *   ([decision](../../../../../.agents/notes/implemented/feature/2026-10-28-e2ee-file-preview-availability.md)).
 *   The ordinary cloud proof verifier and simulator relay stay closed.
 */
export function encryptedRuntimeCloudPort(port: CloudPort, accountId?: string): CloudPort {
  const notifications = port.notifications;
  const notificationAccountId = notifications ? port.identity.userId : undefined;
  return {
    ...port,
    streamsTokens: null,
    notifications: notifications
      ? {
          notifySessionCompleted: async (input) => {
            if (input.userId === notificationAccountId)
              await notifications.notifySessionCompleted(input);
          },
          notifyPermissionRequested: async (input) => {
            if (input.userId === notificationAccountId)
              await notifications.notifyPermissionRequested(input);
          },
          recordPermissionRequested: async (input) => {
            if (input.userId === notificationAccountId)
              await notifications.recordPermissionRequested(input);
          },
          resolvePermissionRequested: async (input) => {
            if (input.userId === notificationAccountId)
              await notifications.resolvePermissionRequested(input);
          },
          syncLiveActivitySummary: async (input) => {
            if (input.userId !== notificationAccountId)
              return { sent: false, reason: 'different_recipient' };
            return notifications.syncLiveActivitySummary({
              ...input,
              items: input.items.map(({ permissionRequestId: _requestId, ...item }) => item),
              permissionAlert: undefined,
            });
          },
        }
      : null,
    remotePreview: {
      verifyControl: async () => {
        throw new Error('Remote preview authorization is unavailable.');
      },
    },
    remoteAutomation: undefined,
    sessionSharing: null,
    prAssociation: null,
    githubTokens: encryptedGithubTokenPort(port.githubTokens, accountId),
  };
}
