import type { SessionHistory } from '@lody/shared';
import type { ConversationView } from './types';

/**
 * Read a complete current history for a one-shot copy/export.
 *
 * A port-backed view provides `readAll()`, one consistent full read; use it so a
 * concurrent content update cannot mix into the exported snapshot. The raw/rollback
 * views fall back to the lease-guarded loop: a range lease owns captured CIDs, not
 * the positions after a concurrent insert/delete, so restart on structural changes
 * while content-only streaming needs no restart. Collect synchronously after the
 * final await and release on every exit.
 */
export async function readConversationHistory(view: ConversationView): Promise<SessionHistory[]> {
  if (view.readAll) return await view.readAll();
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
