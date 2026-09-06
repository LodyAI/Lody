import { getSessionRoomId, isLoroRepoDocDeleted, type SessionId } from '@lody/shared';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { SessionAccountEditRecovery } from './session-account-binding-store';

/** Opens only the session identified by a pending machine-local edit journal. */
export function createSessionAccountEditRecovery(
  workspaceDocument: Pick<
    LoroDocumentManager,
    'repo' | 'getSessionHistorySnapshot' | 'persistPendingChanges'
  >,
  sessionId: SessionId
): SessionAccountEditRecovery {
  const roomId = getSessionRoomId(sessionId);
  const requireExistingSession = async () => {
    const current = await workspaceDocument.repo.getDocMeta(roomId);
    if (!current || isLoroRepoDocDeleted(current)) {
      throw new Error('Session account edit recovery requires an existing session.');
    }
  };
  return {
    readHistory: async () => {
      await requireExistingSession();
      return await workspaceDocument.getSessionHistorySnapshot(sessionId);
    },
    writeMeta: async (patch) => {
      await requireExistingSession();
      await workspaceDocument.repo.upsertDocMeta(roomId, patch);
    },
    persist: async () => {
      await workspaceDocument.persistPendingChanges('session-edit-and-resend-commit');
    },
  };
}
