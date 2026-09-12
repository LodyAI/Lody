import type { SessionHistory } from '@lody/shared';
import type { ConversationView } from './types';

/**
 * Read a complete current history for a one-shot copy/export. A range lease
 * owns captured CIDs, not the positions after a concurrent insert/delete.
 * Restart on structural changes; content-only streaming needs no restart.
 * Collect synchronously after the final await and release on every exit.
 */
export async function readConversationHistory(view: ConversationView): Promise<SessionHistory[]> {
  let structuralRevision = 0;
  const unsubscribe = view.subscribe((change) => {
    if (change.kind === 'structure') structuralRevision += 1;
  });
  try {
    for (;;) {
      const revision = structuralRevision;
      const count = view.turnCount;
      const range = view.acquireRange(0, count);
      try {
        await range.ready;
        if (revision !== structuralRevision) continue;
        const history: SessionHistory[] = [];
        for (let i = 0; i < count; i += 1) {
          const turn = view.turn(i);
          if (!turn) throw new Error('Conversation history is no longer available');
          history.push(turn);
        }
        return history;
      } finally {
        range.release();
      }
    }
  } finally {
    unsubscribe();
  }
}
