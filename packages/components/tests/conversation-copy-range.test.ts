import { describe, expect, it } from 'vitest';
import { conversationCopyRange } from '../src/lib/conversation-copy-range';
import { LoroMap } from 'loro-crdt';
import { buildConversationMarkdown, type WorkspaceId } from '@lody/shared';
import {
  createConversationViewFromDoc,
  createProjectedConversationView,
  readConversationHistory,
} from '../src/lib/conversation-view';
import {
  buildFixtureHistory,
  buildSessionDoc,
  createManualIdle,
  FIXTURE_SESSION_ID,
} from './conversation-view-fixtures';

describe('conversationCopyRange', () => {
  const history = [{ id: 'user' }, { id: 'assistant' }, { id: 'later' }];
  it('includes the selected user or assistant and excludes all later messages', () => {
    expect(conversationCopyRange(history, 'user')).toEqual([history[0]]);
    expect(conversationCopyRange(history, 'assistant')).toEqual(history.slice(0, 2));
    expect(conversationCopyRange(history)).toEqual(history);
  });
  it('does not silently copy everything when the boundary is missing', () => {
    expect(() => conversationCopyRange(history, 'deleted')).toThrow();
  });
});

describe('complete async history reads', () => {
  it.each(['prepend', 'delete', 'replace', 'scalar', 'projected'] as const)(
    'returns complete history after a %s during loading and releases its pins',
    async (change) => {
      const doc = buildSessionDoc(buildFixtureHistory(6));
      const idle = createManualIdle();
      let resume!: () => void;
      const gate = new Promise<void>((r) => {
        resume = r;
      });
      const base = createConversationViewFromDoc(doc, {
        sessionId: FIXTURE_SESSION_ID,
        tailKeep: 0,
        maxHydrated: 2,
        hydrateChunkSize: 2,
        scheduleIdle: idle.scheduleIdle,
        yieldToEventLoop: () => gate,
      });
      const overlay = { ...buildFixtureHistory(1)[0]!, id: 'overlay' };
      const view =
        change === 'projected'
          ? createProjectedConversationView(base, [
              {
                workspaceId: 'workspace' as WorkspaceId,
                sessionId: FIXTURE_SESSION_ID,
                entry: overlay,
                afterHistoryId: null,
              },
            ])
          : base;
      try {
        const reading = readConversationHistory(view);
        const list = doc.getList('history');
        if (change === 'delete' || change === 'replace') list.delete(0, 1);
        if (change === 'prepend' || change === 'replace' || change === 'projected') {
          const turn = list.insertContainer(0, new LoroMap());
          turn.set('id', 'new-head');
          turn.set('role', 'user');
          turn.set('items', [{ type: 'text', text: 'inserted' }]);
        }
        if (change === 'scalar') (list.get(0) as LoroMap).set('finished', false);
        doc.commit();
        resume();
        const history = await reading;
        const expected = change === 'projected' ? [overlay, ...list.toJSON()] : list.toJSON();
        expect(history).toEqual(expected);
        expect(buildConversationMarkdown({ history }).stats.entryCount).toBe(history.length);
        expect(
          Array.from({ length: base.turnCount }, (_, i) => base.isHydrated(i)).filter(Boolean)
            .length
        ).toBeLessThanOrEqual(2);
        // The result remains usable after releasing the LRU lease.
        expect(history[0]?.id).toBe(expected[0]?.id);
      } finally {
        resume();
        base.dispose();
        doc.free();
      }
    }
  );

  it('rejects an interrupted read instead of returning a partial history', async () => {
    const doc = buildSessionDoc(buildFixtureHistory(4));
    const idle = createManualIdle();
    let resume!: () => void;
    const gate = new Promise<void>((r) => {
      resume = r;
    });
    const view = createConversationViewFromDoc(doc, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      maxHydrated: 2,
      hydrateChunkSize: 1,
      scheduleIdle: idle.scheduleIdle,
      yieldToEventLoop: () => gate,
    });
    const reading = readConversationHistory(view);
    view.dispose();
    resume();
    try {
      await expect(reading).rejects.toThrow('no longer available');
    } finally {
      doc.free();
    }
  });
});
