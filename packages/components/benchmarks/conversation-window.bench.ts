import { bench, expect } from 'vitest';
import { createConversationSession } from '../src/lib/conversation-view/create-conversation-session';
import {
  buildFixtureHistory,
  buildSessionDoc,
  FIXTURE_SESSION_ID,
} from '../tests/conversation-view-fixtures';

// Synthetic library benchmark, not a desktop/mobile acceptance result.
// Snapshot decoding is outside this measurement; directory construction is inside.
const history = buildFixtureHistory(1500); // 3000 history entries
const doc = buildSessionDoc(history);

bench(
  'open reader and hydrate last 30 of 3000 entries',
  async () => {
    const session = createConversationSession(doc, {
      sessionId: FIXTURE_SESSION_ID,
      windowed: true,
      tailKeep: 0,
      scheduleIdle: () => () => {},
    });
    const view = session.history;
    try {
      await new Promise<void>((resolve) => {
        const unsubscribe = view.subscribe((event) => {
          if (event.kind !== 'structure') return;
          unsubscribe();
          resolve();
        });
      });
      expect(view.turnCount).toBe(history.length);
      const lease = view.acquireRange(history.length - 30, history.length);
      try {
        await lease.ready;
        expect(view.turn(history.length - 1)?.id).toBe(history.at(-1)?.id);
        expect(view.turn(0)).toBeUndefined();
      } finally {
        lease.release();
      }
    } finally {
      session.dispose();
    }
  },
  { iterations: 5, time: 200 }
);
