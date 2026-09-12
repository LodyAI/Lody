import { resolveSessionHistoryStatus } from '@lody/shared';
import type { SessionData, SessionTurn } from '@lody/shared/session-data';

export type AutoMarkLatestUserHistoryAsReadHandle = {
  dispose: () => void;
};

/**
 * The newest user turn, when it is still awaiting a read acknowledgement. Scans
 * raw rows backwards through the session-data reader, so it neither materializes
 * the whole history nor depends on a full Mirror.
 */
const findLatestPendingUserTurn = async (data: SessionData): Promise<SessionTurn | undefined> => {
  const count = await data.history.count();
  for (let position = count - 1; position >= 0; position -= 1) {
    const read = await data.history.readAt(position);
    if (read.state !== 'ready' || read.turn.role !== 'user') continue;
    return resolveSessionHistoryStatus(read.turn) === 'pending' ? read.turn : undefined;
  }
  return undefined;
};

/**
 * Attaches a small policy on top of the session history:
 * - Whenever history changes, if there is a new user message, mark the latest one as seen.
 *
 * The reader is async, so a scan takes the slot count at its start. A change that
 * lands while a scan runs (its listener fires during the awaits) requests one
 * more pass; without that, a turn written after `count()` was read but before the
 * scan finished would never be marked. The observation itself is gap-free: its
 * initial directory and the listener start at the same point. Writes go through
 * the session-data port, are idempotent, and only touch the latest unread user
 * turn.
 */
export const attachAutoMarkLatestUserHistoryAsRead = (
  data: SessionData
): AutoMarkLatestUserHistoryAsReadHandle => {
  let disposed = false;
  let lastMarkedTurnId: string | null = null;
  let running = false;
  let rerunRequested = false;

  const check = () => {
    if (disposed) return;
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    void (async () => {
      try {
        do {
          rerunRequested = false;
          const turn = await findLatestPendingUserTurn(data);
          if (disposed) return;
          if (!turn || turn.id === lastMarkedTurnId) continue;
          // The command re-checks the status inside its commit and refuses to
          // regress an execution state a concurrent writer advanced. Record the
          // id only on an accepted write: a rejected precondition stays
          // retryable, and an indeterminate result is not "done".
          const result = await data.commands.markTurnSeen(turn.id);
          if (result.status === 'accepted') lastMarkedTurnId = turn.id;
        } while (rerunRequested);
      } finally {
        running = false;
      }
    })();
  };

  const observation = data.history.observe(check);
  void observation.initial.then(() => check());

  return {
    dispose: () => {
      disposed = true;
      lastMarkedTurnId = null;
      observation.unsubscribe();
    },
  };
};
