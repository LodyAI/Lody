import { resolveSessionHistoryStatus } from '@lody/shared';

export type AutoMarkLatestUserHistoryAsReadHandle = {
  dispose: () => void;
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
    for (let position = data.history.count() - 1; position >= 0; position--) {
      const row = data.history.readDirectory(position, position + 1)[0];
      if (row?.scalars?.role !== 'user') continue;
      if (
        !row.turnId ||
        marking === row.turnId ||
        resolveSessionHistoryStatus(row.scalars) !== 'pending'
      )
        return;
      marking = row.turnId;
      try {
        markTurnSeen(row.turnId);
      } finally {
        marking = undefined;
      }
      return;
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
