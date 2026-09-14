// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { createLoroSessionData } from '@lody/shared/session-data';
import {
  useConversationStreamItems,
  type ConversationStreamItems,
} from '../src/hooks/use-conversation-stream-items';
import { createConversationViewFromReader } from '../src/lib/conversation-view';
import {
  buildFixtureHistory,
  buildSessionDoc,
  FIXTURE_SESSION_ID,
} from './conversation-view-fixtures';

it('opening leaves old previews unread; hover reads the question and reply only', async () => {
  const doc = buildSessionDoc(buildFixtureHistory(50));
  const data = createLoroSessionData({ doc, sessionId: FIXTURE_SESSION_ID });
  const reads: string[] = [];
  const view = createConversationViewFromReader(
    {
      ...data.history,
      readTurn: (id) => {
        reads.push(id);
        return data.history.readTurn(id);
      },
    },
    {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      yieldToEventLoop: () => Promise.resolve(),
      scheduleIdle: (task) => {
        let live = true;
        queueMicrotask(() => {
          if (live) task({ timeRemaining: () => 50 });
        });
        return () => {
          live = false;
        };
      },
    }
  );
  const element = document.createElement('div');
  const root = createRoot(element);
  let current!: ConversationStreamItems;
  function Probe() {
    current = useConversationStreamItems(view, FIXTURE_SESSION_ID);
    return null;
  }
  try {
    await view.ready;
    expect(view.turnCount).toBe(100);
    expect(reads).toEqual([]);
    await act(async () => {
      root.render(createElement(Probe));
    });
    expect(reads).not.toContain('u-0');
    expect(view.index(0)?.summary).toBeUndefined();
    let done!: () => void;
    const completed = new Promise<void>((resolve) => {
      done = resolve;
    });
    const unsub = view.subscribe(() => {
      if (view.index(0)?.summary && view.index(1)?.summary) done();
    });
    await act(async () => {
      current.onOutlinePreviewRound(0);
      await completed;
    });
    unsub();
    expect(view.index(0)?.summary?.headText).toContain('Round 0');
    expect(view.index(1)?.summary).toBeDefined();
    expect(reads.filter((id) => ['u-0', 'a-0', 'u-1', 'a-1'].includes(id))).toEqual(['u-0', 'a-0']);
    expect(view.index(2)?.summary).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    view.dispose();
    data.dispose();
    doc.free();
  }
});
