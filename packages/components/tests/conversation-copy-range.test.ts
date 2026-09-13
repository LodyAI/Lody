import { openReaderView } from './conversation-view-fixtures';
import { describe, expect, it } from 'vitest';
import { conversationCopyRange } from '../src/lib/conversation-copy-range';
import { buildConversationMarkdown, type WorkspaceId } from '@lody/shared';
import {
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
  it('exports one authoritative snapshot even if history changes or the view closes', async () => {
    const doc = buildSessionDoc(buildFixtureHistory(6));
    const view = await openReaderView(doc, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      scheduleIdle: createManualIdle().scheduleIdle,
    });
    const expected = doc.getList('history').toJSON();
    const projected = createProjectedConversationView(view, [
      {
        workspaceId: 'workspace' as WorkspaceId,
        sessionId: FIXTURE_SESSION_ID,
        entry: { ...buildFixtureHistory(1)[0]!, id: 'overlay' },
        afterHistoryId: null,
      },
    ]);
    const reading = readConversationHistory(projected);
    doc.getList('history').delete(0, 1);
    doc.commit();
    view.dispose();
    const history = await reading;
    expect(history).toEqual(expected);
    expect(history.some((t) => t.id === 'overlay')).toBe(false);
    expect(buildConversationMarkdown({ history }).stats.entryCount).toBe(expected.length);
    doc.free();
  });
});
