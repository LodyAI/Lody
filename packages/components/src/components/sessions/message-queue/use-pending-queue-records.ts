import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { MessageQueueItem, SessionId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import type { SessionSendViewRecord } from '@/lib/session-send-journal';
import { selectPendingQueueRecords } from '@/lib/session-send-status';
import { toast } from '@/lib/toast';

const EMPTY: readonly SessionSendViewRecord[] = [];
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
): SessionSendViewRecord[] {
  const journal = useAtomValue(activeWorkspaceRuntimeAtom)?.sendJournal;
  const records = useSyncExternalStore(
    journal?.subscribe ?? emptySubscribe,
    journal?.getSnapshot ?? emptySnapshot,
    emptySnapshot
  );
  const queuedTurnIds = useQueuedTurnIds(items);
  return useMemo(
    () => selectPendingQueueRecords(records, sessionId, queuedTurnIds),
    [queuedTurnIds, records, sessionId]
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
  const journal = useAtomValue(activeWorkspaceRuntimeAtom)?.sendJournal;
  const queuedTurnIds = useQueuedTurnIds(items);
  const getSnapshot = useCallback(
    () =>
      journal
        ? selectPendingQueueRecords(journal.getSnapshot(), sessionId, queuedTurnIds).length > 0
        : false,
    [journal, queuedTurnIds, sessionId]
  );
  return useSyncExternalStore(journal?.subscribe ?? emptySubscribe, getSnapshot, () => false);
}

/**
 * The recovery actions a local queue row offers, with the same semantics as the
 * conversation's pending rows: every action resumes the session's FIFO after it.
 */
export function usePendingQueueActions(sessionId: SessionId) {
  const { t } = useTranslation();
  const journal = useAtomValue(activeWorkspaceRuntimeAtom)?.sendJournal;
  const [busyId, setBusyId] = useState<string | null>(null);
  const run = useCallback(
    async (record: SessionSendViewRecord, kind: 'retry' | 'cancel' | 'discard') => {
      if (!journal) return;
      setBusyId(record.id);
      try {
        if (kind === 'cancel') await journal.cancel(record.id);
        if (kind === 'discard') await journal.discard(record.id);
        await journal.retry(sessionId);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t('sessions.sendRecoveryUnavailable'),
          { id: `pending-queue-${record.id}` }
        );
      } finally {
        setBusyId(null);
      }
    },
    [journal, sessionId, t]
  );
  return { busyId, run };
}
