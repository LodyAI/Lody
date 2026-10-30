import { openReaderView } from './conversation-view-fixtures';
import { describe, expect, it } from 'vitest';
import { conversationCopyRange } from '../src/lib/conversation-copy-range';
import { readConversationCopySource } from '../src/lib/conversation-copy-source';
import type { SessionDocStore, WorkspaceRuntime } from '../src/atoms/runtime';
import { buildConversationMarkdown } from '@lody/shared';
import {
  buildFixtureHistory,
  buildSessionDoc,
  createManualIdle,
  FIXTURE_SESSION_ID,
} from './conversation-view-fixtures';

describe('conversationCopyRange', () => {
  const history = [{ id: 'user' }, { id: 'assistant' }, { id: 'later' }];
  it('includes the selected user or assistant and excludes all later messages', async () => {
    expect(conversationCopyRange(history, 'user')).toEqual([history[0]]);
    expect(conversationCopyRange(history, 'assistant')).toEqual(history.slice(0, 2));
    expect(conversationCopyRange(history)).toEqual(history);
  });
  it('does not silently copy everything when the boundary is missing', async () => {
    expect(() => conversationCopyRange(history, 'deleted')).toThrow();
  });
});

describe('complete async history reads', () => {
  it.each([false, true])('binds export to the owning runtime store (old view: %s)', async (old) => {
    const oldDoc = buildSessionDoc(buildFixtureHistory(1), 1);
    const currentDoc = buildSessionDoc(buildFixtureHistory(2), 2);
    const oldView = await openReaderView(oldDoc, { sessionId: FIXTURE_SESSION_ID });
    const currentView = await openReaderView(currentDoc, { sessionId: FIXTURE_SESSION_ID });
    let leased = false;
    const runtime: Pick<WorkspaceRuntime, 'withSessionStore'> = {
      withSessionStore: async (sessionId, read) => {
        expect(sessionId).toBe(FIXTURE_SESSION_ID);
        leased = true;
        try {
          return await read({ history: currentView } as SessionDocStore);
        } finally {
          leased = false;
        }
      },
    };
    try {
      const reading = readConversationCopySource(
        runtime,
        FIXTURE_SESSION_ID,
        old ? oldView : currentView
      );
      if (old) await expect(reading).rejects.toThrow('Copy source changed');
      else {
        const history = await reading;
        expect(history).toEqual(currentDoc.getList('history').toJSON());
        expect(history).not.toEqual(oldDoc.getList('history').toJSON());
      }
      expect(leased).toBe(false);
    } finally {
      oldView.dispose();
      currentView.dispose();
      oldDoc.free();
      currentDoc.free();
    }
  });
  it('exports one authoritative snapshot even if history changes or the view closes', async () => {
    const doc = buildSessionDoc(buildFixtureHistory(6));
    const view = await openReaderView(doc, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      scheduleIdle: createManualIdle().scheduleIdle,
    });
    const expected = doc.getList('history').toJSON();
    const reading = view.readAll();
    doc.getList('history').delete(0, 1);
    doc.commit();
    view.dispose();
    const history = await reading;
    expect(history).toEqual(expected);
    expect(buildConversationMarkdown({ history }).stats.entryCount).toBe(expected.length);
    doc.free();
  });
});
