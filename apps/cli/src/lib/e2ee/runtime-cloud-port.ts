import type { CloudPort } from '@lody/platform';

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
export function encryptedRuntimeCloudPort(port: CloudPort): CloudPort {
  const notifications = port.notifications;
  const accountId = port.identity.userId;
  return {
    ...port,
    streamsTokens: null,
    notifications: notifications
      ? {
          notifySessionCompleted: async (input) => {
            if (input.userId === accountId) await notifications.notifySessionCompleted(input);
          },
          notifyPermissionRequested: async (input) => {
            if (input.userId === accountId) await notifications.notifyPermissionRequested(input);
          },
          recordPermissionRequested: async (input) => {
            if (input.userId === accountId) await notifications.recordPermissionRequested(input);
          },
          resolvePermissionRequested: async (input) => {
            if (input.userId === accountId) await notifications.resolvePermissionRequested(input);
          },
          syncLiveActivitySummary: async (input) => {
            if (input.userId !== accountId) return { sent: false, reason: 'different_recipient' };
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
    githubTokens: null,
  };
}
