import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { MessageQueueItem, SessionId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import type { PendingSessionSend } from '@/lib/session-pending-sends';
import { selectPendingQueueSends } from '@/lib/session-send-status';
import { toast } from '@/lib/toast';

const EMPTY: readonly PendingSessionSend[] = [];
const emptySnapshot = () => EMPTY;
const emptySubscribe = () => () => {};

function useQueuedTurnIds(items: readonly MessageQueueItem[]) {
  return useMemo(
    () => new Set(items.flatMap((item) => (item.userTurnId ? [item.userTurnId] : []))),
    [items]
  );
}

/**
 * Queue-bound messages still uploading, for the queue sheet. Re-renders on every
 * upload progress report, so only the sheet itself may call it.
 */
export function usePendingQueueRecords(
  sessionId: SessionId,
  items: readonly MessageQueueItem[]
): PendingSessionSend[] {
  const pending = useAtomValue(activeWorkspaceRuntimeAtom)?.pendingSends;
  const sends = useSyncExternalStore(
    pending?.subscribe ?? emptySubscribe,
    pending?.getSnapshot ?? emptySnapshot,
    emptySnapshot
  );
  const queuedTurnIds = useQueuedTurnIds(items);
  return useMemo(
    () => selectPendingQueueSends(sends, sessionId, queuedTurnIds),
    [queuedTurnIds, sends, sessionId]
  );
}

/**
 * Whether the queue sheet has local rows to show. A boolean snapshot, so the
 * page that owns the sheet re-renders when rows appear or leave, never on
 * upload progress.
 */
export function useHasPendingQueueRecords(
  sessionId: SessionId,
  items: readonly MessageQueueItem[]
): boolean {
  const pending = useAtomValue(activeWorkspaceRuntimeAtom)?.pendingSends;
  const queuedTurnIds = useQueuedTurnIds(items);
  const getSnapshot = useCallback(
    () =>
      pending
        ? selectPendingQueueSends(pending.getSnapshot(), sessionId, queuedTurnIds).length > 0
        : false,
    [pending, queuedTurnIds, sessionId]
  );
  return useSyncExternalStore(pending?.subscribe ?? emptySubscribe, getSnapshot, () => false);
}

/** Retry or cancel a held queue-bound send; the conversation's FIFO resumes after it. */
export function usePendingQueueActions() {
  const { t } = useTranslation();
  const pending = useAtomValue(activeWorkspaceRuntimeAtom)?.pendingSends;
  const [busyId, setBusyId] = useState<string | null>(null);
  const run = useCallback(
    async (send: PendingSessionSend, kind: 'retry' | 'cancel') => {
      if (!pending) return;
      setBusyId(send.id);
      try {
        if (kind === 'cancel') await pending.cancel(send.id);
        else pending.retry(send.id);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('sessions.sendError'), {
          id: `pending-queue-${send.id}`,
        });
      } finally {
        setBusyId(null);
      }
    },
    [pending, t]
  );
  return { busyId, run };
}
