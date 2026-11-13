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
  return {
    ...port,
    streamsTokens: null,
    notifications: null,
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
