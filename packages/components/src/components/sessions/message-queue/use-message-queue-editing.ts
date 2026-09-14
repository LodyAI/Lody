import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageQueueItem } from '@lody/shared';
import { extractPromptPreviewFromInputBlocks, normalizeSessionInputBlocks } from '@lody/shared';

export function getEditableTaskText(item: MessageQueueItem): string {
  const blocks = normalizeSessionInputBlocks(
    item.acpSessionConfig?.inputBlocks,
    item.acpSessionConfig?.prompt ?? ''
  );
  const text = extractPromptPreviewFromInputBlocks(blocks);
  return text || item.acpSessionConfig?.prompt || item.task;
}

export type MessageQueueEditingCallbacks = {
  onEditStart: (item: MessageQueueItem) => void | Promise<void>;
  onEditCancel: (item: MessageQueueItem) => void | Promise<void>;
  onEditSave: (item: MessageQueueItem, task: string) => void | Promise<void>;
};

export type MessageQueueEditing = {
  editingCid: string | null;
  editingItem: MessageQueueItem | null;
  editValue: string;
  pendingCid: string | null;
  setEditValue: (value: string) => void;
  startEdit: (item: MessageQueueItem) => Promise<void>;
  cancelEdit: (item: MessageQueueItem) => Promise<void>;
  saveEdit: (item: MessageQueueItem) => Promise<void>;
};

export function useMessageQueueEditing(
  items: MessageQueueItem[],
  callbacks: MessageQueueEditingCallbacks
): MessageQueueEditing {
  const { onEditStart, onEditCancel, onEditSave } = callbacks;
  const [editingCid, setEditingCid] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<MessageQueueItem | null>(null);
  const [editValue, setEditValue] = useState('');
  const [pendingCid, setPendingCid] = useState<string | null>(null);

  // Refs so the unmount cleanup can fire onEditCancel without re-subscribing on every render.
  const itemsRef = useRef(items);
  const editingCidRef = useRef<string | null>(null);
  const onEditCancelRef = useRef(onEditCancel);
  const dismissedLeaseRef = useRef<{ cid: string; startedAt?: number } | null>(null);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    editingCidRef.current = editingCid;
  }, [editingCid]);
  useEffect(() => {
    onEditCancelRef.current = onEditCancel;
  }, [onEditCancel]);

  // On unmount, if a row is mid-edit, surface a cancel so the doc-side `isEditing` flag clears.
  useEffect(() => {
    return () => {
      const cid = editingCidRef.current;
      const item = cid ? itemsRef.current.find((candidate) => candidate.$cid === cid) : undefined;
      if (item?.isEditing) {
        void Promise.resolve()
          .then(() => onEditCancelRef.current(item))
          .catch((error) => {
            console.error('Failed to release queued message editing lease', error);
          });
      }
    };
  }, []);

  // A displaced row must not discard an unsaved local draft.
  useEffect(() => {
    if (editingCid) {
      return;
    }

    const sharedEditor = items.find((item) => item.isEditing);
    if (sharedEditor) {
      const dismissed = dismissedLeaseRef.current;
      if (
        dismissed?.cid === sharedEditor.$cid &&
        dismissed.startedAt === sharedEditor.editingStartedAt
      )
        return;
      setEditingCid(sharedEditor.$cid);
      setEditingItem(sharedEditor);
      setEditValue(getEditableTaskText(sharedEditor));
    }
  }, [editingCid, items]);

  const startEdit = useCallback(
    async (item: MessageQueueItem) => {
      const previous =
        editingCid && editingCid !== item.$cid
          ? items.find((candidate) => candidate.$cid === editingCid)
          : undefined;
      setPendingCid(item.$cid);
      try {
        if (previous) {
          await onEditCancel(previous);
        }
        await onEditStart(item);
        dismissedLeaseRef.current = null;
        setEditingCid(item.$cid);
        setEditingItem(item);
        setEditValue(getEditableTaskText(item));
      } catch (error) {
        console.error('Failed to start queued message edit', error);
      } finally {
        setPendingCid(null);
      }
    },
    [editingCid, items, onEditCancel, onEditStart]
  );

  const cancelEdit = useCallback(
    async (item: MessageQueueItem) => {
      setPendingCid(item.$cid);
      try {
        if (itemsRef.current.some((candidate) => candidate.$cid === item.$cid))
          await onEditCancel(item);
        dismissedLeaseRef.current = { cid: item.$cid, startedAt: item.editingStartedAt };
        setEditingCid(null);
        setEditingItem(null);
        setEditValue('');
      } catch (error) {
        console.error('Failed to cancel queued message edit', error);
      } finally {
        setPendingCid(null);
      }
    },
    [onEditCancel]
  );

  const saveEdit = useCallback(
    async (item: MessageQueueItem) => {
      setPendingCid(item.$cid);
      try {
        await onEditSave(item, editValue.trim());
        // The daemon ACK can precede its CRDT delta; do not reopen the stale shared lease.
        dismissedLeaseRef.current = { cid: item.$cid, startedAt: item.editingStartedAt };
        setEditingCid(null);
        setEditingItem(null);
        setEditValue('');
      } catch (error) {
        console.error('Failed to save queued message edit', error);
      } finally {
        setPendingCid(null);
      }
    },
    [editValue, onEditSave]
  );

  return {
    editingCid,
    editingItem,
    editValue,
    pendingCid,
    setEditValue,
    startEdit,
    cancelEdit,
    saveEdit,
  };
}
