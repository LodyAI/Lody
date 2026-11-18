import { resolveSessionHistoryStatus } from '../schema';

export type AutoMarkLatestUserHistoryAsReadHandle = {
  dispose: () => void;
};

export const latestPendingUserHistoryId = (
  history: Pick<
    import('@lody/shared/session-data').LoroSessionData['history'],
    'count' | 'readDirectory'
  >
): string | undefined => {
  for (let position = history.count() - 1; position >= 0; position--) {
    const row = history.readDirectory(position, position + 1)[0];
    if (row?.scalars?.role !== 'user') continue;
    return row.turnId && resolveSessionHistoryStatus(row.scalars) === 'pending'
      ? row.turnId
      : undefined;
  }
  return undefined;
};

/** Observe only shallow directory fields. Assistant bodies are never read just
 * to acknowledge the newest user turn. Composition alone does not arm this policy. */
export const attachAutoMarkLatestUserHistoryAsRead = (
  data: import('@lody/shared/session-data').LoroSessionData,
  markTurnSeen: (id: string) => boolean
): AutoMarkLatestUserHistoryAsReadHandle => {
  let disposed = false;
  let marking: string | undefined;
  const check = () => {
    if (disposed) return;
    const id = latestPendingUserHistoryId(data.history);
    if (!id || marking === id) return;
    marking = id;
    try {
      markTurnSeen(id);
    } finally {
      marking = undefined;
    }
  };
  const observation = data.history.observe(check);
  check();
  return {
    dispose() {
      disposed = true;
      observation.unsubscribe();
    },
  };
};
