import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { useAtom, useStore } from 'jotai';
import { useTranslation } from 'react-i18next';
import {
  getServerNow,
  type AgentRoleId,
  type MessageQueueItem,
  type SessionId,
  type SessionInputBlock,
} from '@lody/shared';
import {
  sessionAgentRoleDurableSnapshotAtomFamily,
  sessionAgentRoleSelectionAtomFamily,
} from '@/atoms/session-agent-roles';
import {
  discardSessionRunConfigDraftAtom,
  type SessionRunConfigDraftScope,
} from '@/atoms/session-run-config-drafts';
import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import { toast } from '@/lib/toast';
import type { UseSessionDocResult } from '@/hooks/use-session-doc';
import {
  QUEUED_EDIT_RENEW_INTERVAL_MS,
  beginQueuedMessageEdit,
  queuedEditLeaseNeedsRenewal,
  queuedMessageEditAtomFamily,
  resolveQueuedMessageEdit,
  type QueuedMessageEditSave,
  type QueuedMessageEditState,
  type QueuedRunConfig,
} from './queued-message-edit';

/** What the composer exposes for an edit; see `SessionChatInputAreaHandle`. */
export type QueuedEditComposer = {
  beginQueueEdit: (text: string) => void;
  finishQueueEdit: (mode: 'restore' | 'keep') => void;
};

/** The Role a queued edit was saved with, as the composer resolved it. */
export type QueuedEditRole =
  | {
      agentRoleId: AgentRoleId;
      agentRoleRevision?: number;
    }
  | null
  | undefined;

export const queuedEditRoleScope = (sessionId: string, cid: string) =>
  `queue-edit:${sessionId}:${cid}`;

/**
 * Owns one Session's composer edit of a queued message: the row lock and its
 * renewal while the editor is visible, saving through the shared admission,
 * and ending the edit when its row is gone.
 */
export function useQueuedMessageComposerEdit({
  sessionId,
  items,
  ready,
  visible,
  composerRef,
  updateMessageQueueItem,
  saveMessageQueueEdit,
  editor,
  runConfigDraftScope,
  finishDraftWithoutComposer,
  onEvent,
}: {
  sessionId: SessionId;
  items: readonly MessageQueueItem[];
  /** False while the Session document hydrates; a missing row then proves nothing. */
  ready: boolean;
  /** The editor is on screen: the Session is shown and the page is visible. */
  visible: boolean;
  composerRef: RefObject<QueuedEditComposer | null>;
  updateMessageQueueItem: UseSessionDocResult['updateMessageQueueItem'];
  saveMessageQueueEdit: UseSessionDocResult['saveMessageQueueEdit'];
  editor: { userId: string; userName?: string };
  /** The edit's own run-config draft scope, discarded when the edit ends. */
  runConfigDraftScope?: SessionRunConfigDraftScope;
  /** Ends the edit's hold on the composer draft while no composer is mounted. */
  finishDraftWithoutComposer: (sessionId: SessionId, mode: 'restore' | 'keep') => void;
  onEvent?: (event: string, properties: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const store = useStore();
  const [edit, setEdit] = useAtom(queuedMessageEditAtomFamily(sessionId));
  const editingItem = edit ? items.find((item) => item.$cid === edit.cid) : undefined;
  const position = edit ? items.findIndex((item) => item.$cid === edit.cid) + 1 : 0;
  // When this device last wrote the lock; the synced row can lag one render.
  const lockedAtRef = useRef(0);
  const scopeRef = useRef(runConfigDraftScope);
  scopeRef.current = runConfigDraftScope;

  /** Forget the edit's local state: its run-config draft and Role choice. */
  const retire = useCallback(
    (current: QueuedMessageEditState) => {
      setEdit(undefined);
      const scope = scopeRef.current;
      if (scope) store.set(discardSessionRunConfigDraftAtom, scope);
      const roleScope = queuedEditRoleScope(sessionId, current.cid);
      sessionAgentRoleSelectionAtomFamily.remove(roleScope);
      sessionAgentRoleDurableSnapshotAtomFamily.remove(roleScope);
    },
    [sessionId, setEdit, store]
  );

  const releaseLock = useCallback(
    async (cid: string) => {
      await updateMessageQueueItem(cid, (current) =>
        current.isEditing ? { ...current, isEditing: false, editingStartedAt: undefined } : current
      );
    },
    [updateMessageQueueItem]
  );

  const start = useCallback(
    async (item: MessageQueueItem) => {
      if (edit) return;
      try {
        // Only the lock is written now; content and configuration wait for save.
        const startedAt = getServerNow();
        await updateMessageQueueItem(item.$cid, (current) => ({
          ...current,
          isEditing: true,
          editingStartedAt: startedAt,
        }));
        lockedAtRef.current = startedAt;
      } catch (error) {
        console.error('Failed to start editing queued message', error);
        toast.error(t('sessions.queueEditError', 'Failed to edit message'));
        return;
      }
      const next = beginQueuedMessageEdit(item);
      setEdit(next);
      composerRef.current?.beginQueueEdit(next.text);
      onEvent?.('session/queue_item_edit_started', { queue_item_id: item.$cid });
    },
    [composerRef, edit, onEvent, setEdit, t, updateMessageQueueItem]
  );

  /** The composer already restored its own draft. */
  const cancel = useCallback(() => {
    if (!edit) return;
    retire(edit);
    onEvent?.('session/queue_item_edit_cancelled', { queue_item_id: edit.cid });
    void releaseLock(edit.cid).catch((error: unknown) => {
      console.warn('Failed to release a queued edit lock', error);
    });
  }, [edit, onEvent, releaseLock, retire]);

  const removeKeptBlock = useCallback(
    (index: number) => {
      setEdit((current) =>
        current
          ? { ...current, keptBlocks: current.keptBlocks.filter((_, i) => i !== index) }
          : current
      );
    },
    [setEdit]
  );

  /** Returns whether the composer may hand its draft back (the save was accepted). */
  const save = useCallback(
    async (args: {
      composerBlocks: readonly SessionInputBlock[];
      attachments: readonly SessionAttachmentDraft[];
      runConfig: QueuedRunConfig;
      buildConfig: QueuedMessageEditSave['buildConfig'];
      onAccepted?: () => void;
    }): Promise<boolean> => {
      if (!edit) return false;
      const result = resolveQueuedMessageEdit({ edit, editor, ...args });
      if (result.kind === 'empty') {
        toast.error(t('sessions.messageQueue.editEmpty', 'A queued message cannot be empty.'));
        return false;
      }
      if (result.kind === 'unchanged') {
        retire(edit);
        void releaseLock(edit.cid).catch(() => undefined);
        return true;
      }
      try {
        await saveMessageQueueEdit(edit.cid, result.patch, {
          attachments: [...args.attachments],
          onAccepted: args.onAccepted,
        });
      } catch (error) {
        console.error('Failed to save queued message edit', error);
        toast.error(t('sessions.queueEditError', 'Failed to edit message'), {
          description: error instanceof Error ? error.message : undefined,
        });
        onEvent?.('session/queue_item_edit_save_failed', { queue_item_id: edit.cid });
        return false;
      }
      retire(edit);
      onEvent?.('session/queue_item_edit_saved', {
        queue_item_id: edit.cid,
        held_attachments: args.attachments.length,
      });
      return true;
    },
    [edit, editor, onEvent, releaseLock, retire, saveMessageQueueEdit, t]
  );

  // Renew only while the editor is on screen. Hidden, left or closed, the
  // lease lapses within the CLI's window and the row runs as it was.
  const renewing = visible && editingItem !== undefined;
  const editingItemRef = useRef(editingItem);
  editingItemRef.current = editingItem;
  const cid = edit?.cid;
  useEffect(() => {
    if (!renewing || !cid) return undefined;
    const renew = (force: boolean) => {
      const item = editingItemRef.current;
      const now = getServerNow();
      if (
        !item ||
        (!force &&
          (now - lockedAtRef.current < QUEUED_EDIT_RENEW_INTERVAL_MS ||
            !queuedEditLeaseNeedsRenewal(item, now)))
      )
        return;
      lockedAtRef.current = now;
      void updateMessageQueueItem(cid, (current) => ({
        ...current,
        isEditing: true,
        editingStartedAt: now,
      })).catch((error: unknown) => {
        console.warn('Failed to renew a queued edit lease', error);
      });
    };
    renew(false);
    const timer = setInterval(() => renew(true), QUEUED_EDIT_RENEW_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [cid, renewing, updateMessageQueueItem]);

  // The row ran or was removed meanwhile: the edit becomes an ordinary draft.
  const gone = ready && edit !== undefined && editingItem === undefined;
  useEffect(() => {
    if (!gone || !edit) return;
    retire(edit);
    const composer = composerRef.current;
    if (composer) composer.finishQueueEdit('keep');
    else finishDraftWithoutComposer(sessionId, 'keep');
    toast.info(
      t(
        'sessions.messageQueue.editTargetGoneDraft',
        'This message was already sent or removed. Your changes are kept as a draft.'
      )
    );
    onEvent?.('session/queue_item_edit_target_gone', { queue_item_id: edit.cid });
  }, [composerRef, edit, finishDraftWithoutComposer, gone, onEvent, retire, sessionId, t]);

  /** A held save was discarded before it replaced the row: release the row. */
  const discardPendingSave = useCallback(
    (item: MessageQueueItem) => {
      void releaseLock(item.$cid).catch(() => undefined);
    },
    [releaseLock]
  );

  return {
    edit,
    editingItem,
    position,
    start,
    cancel,
    save,
    removeKeptBlock,
    discardPendingSave,
  };
}
