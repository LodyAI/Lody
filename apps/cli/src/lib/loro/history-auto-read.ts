import {
  getLegacyReadForSessionHistoryStatus,
  resolveSessionHistoryStatus,
  type SessionDoc,
  type SessionHistoryInput,
} from '@lody/shared';

type SessionDocMirror = {
  subscribe: (listener: (next: SessionDoc) => void) => () => void;
  getState: () => SessionDoc;
  setState: (updater: (prev: SessionDoc) => SessionDoc) => void;
};

export type AutoMarkLatestUserHistoryAsReadHandle = {
  dispose: () => void;
};

const findLatestUserHistoryEntry = (
  history: SessionHistoryInput[]
): SessionHistoryInput | undefined => {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry?.role === 'user') {
      return entry;
    }
  }
  return undefined;
};

/**
 * Attaches a small policy on top of the session history:
 * - Whenever history changes, if there is a new user message, mark the latest one as seen.
 *
 * Notes:
 * - We defer the write into a microtask to avoid nested `setState()` inside `subscribe()`,
 *   which can lead to re-entrant updates and harder-to-reason-about ordering.
 * - The operation is idempotent and only touches the latest unread user entry.
 */
export const attachAutoMarkLatestUserHistoryAsRead = (
  mirror: SessionDocMirror
): AutoMarkLatestUserHistoryAsReadHandle => {
  let disposed = false;
  let pendingTurnId: string | null = null;

  const unsubscribe = mirror.subscribe((next) => {
    if (disposed) {
      return;
    }

    const history = (next.history as SessionHistoryInput[]) ?? [];
    const latestUserEntry = findLatestUserHistoryEntry(history);
    if (!latestUserEntry || resolveSessionHistoryStatus(latestUserEntry) !== 'pending') {
      return;
    }

    const turnId = latestUserEntry.id;
    if (pendingTurnId === turnId) {
      return;
    }
    pendingTurnId = turnId;

    void Promise.resolve().then(() => {
      if (disposed) {
        return;
      }
      if (pendingTurnId !== turnId) {
        return;
      }
      pendingTurnId = null;

      const current = mirror.getState().history ?? [];
      const shouldMarkRead = current.some(
        (entry) => entry?.id === turnId && resolveSessionHistoryStatus(entry) === 'pending'
      );
      if (!shouldMarkRead) {
        return;
      }

      mirror.setState((prev) => {
        const histories = prev.history ?? [];
        for (let i = histories.length - 1; i >= 0; i--) {
          const entry = histories[i];
          if (entry?.id === turnId && resolveSessionHistoryStatus(entry) === 'pending') {
            entry.status = 'seen';
            entry.read = getLegacyReadForSessionHistoryStatus('seen');
            break;
          }
        }
        return prev;
      });
    });
  });

  return {
    dispose: () => {
      disposed = true;
      pendingTurnId = null;
      unsubscribe();
    },
  };
};
