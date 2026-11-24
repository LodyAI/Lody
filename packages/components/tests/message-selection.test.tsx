// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectConversationMessages,
  type ConversationMessage,
  type SessionHistory,
  type SessionId,
} from '@lody/shared';
import { initI18n } from '../src/i18n';
import type { SessionDocStore, WorkspaceRuntime } from '../src/atoms/runtime';
import { readConversationCopySource } from '../src/lib/conversation-copy-source';
import { buildChatStreamItems } from '../src/components/ai-gui/build-chat-stream-items';
import { buildSessionDoc, createManualIdle, openReaderView } from './conversation-view-fixtures';
import {
  MessageSelectionContext,
  MessageSelectionOverlay,
  MessageSelectionRow,
  MessageSelectionToolbar,
  useMessageSelection,
} from '../src/components/ai-gui/message-selection';

const messages: ConversationMessage[] = [
  { id: 'user', role: 'user', text: 'Synthetic question' },
  { id: 'assistant', role: 'assistant', text: 'Synthetic answer' },
  { id: 'followup', role: 'user', text: 'Synthetic followup' },
];

function Harness({ scope = 'session-a' }: { scope?: string }) {
  const selection = useMessageSelection(scope);
  const [preview, setPreview] = useState<ConversationMessage[]>([]);
  return (
    <>
      <button onClick={() => selection.start(messages, setPreview)}>Start</button>
      <MessageSelectionContext.Provider value={selection.context}>
        <MessageSelectionRow id="user" first>
          <p>Question</p>
        </MessageSelectionRow>
        <MessageSelectionRow id="assistant" first>
          <p>Answer</p>
        </MessageSelectionRow>
        <MessageSelectionRow id="assistant" first={false}>
          <p>Answer continuation</p>
        </MessageSelectionRow>
        <MessageSelectionRow id="tool-only" first>
          <p>Tool only</p>
        </MessageSelectionRow>
        <MessageSelectionRow id="followup" first>
          <p>Followup</p>
        </MessageSelectionRow>
        <MessageSelectionOverlay />
      </MessageSelectionContext.Provider>
      <MessageSelectionToolbar selection={selection} />
      <output>{preview.map((message) => message.id).join(',')}</output>
    </>
  );
}

describe('chat message selection', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    await initI18n('en');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const click = async (text: string) => {
    const element = [...container.querySelectorAll<HTMLElement>('button,p')].find(
      (candidate) => candidate.textContent === text
    );
    expect(element).toBeDefined();
    await act(async () => element!.click());
  };

  it('selects a whole assistant message across rows and previews in history order', async () => {
    await click('Start');
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(3);
    const preview = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Preview image'
    )!;
    expect(preview.disabled).toBe(true);
    await click('Tool only');
    expect(preview.disabled).toBe(true);
    await click('Answer continuation');
    await click('Question');
    await click('Preview image');
    expect(container.querySelector('output')?.textContent).toBe('user,assistant');
    expect(container.querySelectorAll('[role="checkbox"][data-checked]')).toHaveLength(2);
    await click('Answer');
    await click('Preview image');
    expect(container.querySelector('output')?.textContent).toBe('user');
  });

  it('supports select all, clear, cancellation and scope changes', async () => {
    await click('Start');
    await click('Select all');
    await click('Preview image');
    expect(container.querySelector('output')?.textContent).toBe('user,assistant,followup');
    await click('Clear selection');
    expect(container.querySelectorAll('[role="checkbox"][data-checked]')).toHaveLength(0);
    await click('Cancel');
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
    await click('Start');
    await click('Question');
    await act(async () => root.render(<Harness scope="session-b" />));
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
  });

  it('paints a range, retracts it, and supports modifier selection', async () => {
    await click('Start');
    const row = (id: string) =>
      container.querySelector<HTMLElement>(`[data-message-selection-id="${id}"]`)!;
    const pointer = async (id: string, type: string, options: MouseEventInit = {}) => {
      await act(async () =>
        row(id).dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...options }))
      );
    };
    const release = async () => {
      await act(async () => window.dispatchEvent(new MouseEvent('pointerup')));
    };
    const selectedIds = () =>
      [...container.querySelectorAll('[data-message-selection-id]')]
        .filter((element) => element.querySelector('[role="checkbox"][data-checked]'))
        .map((element) => element.getAttribute('data-message-selection-id'));

    await pointer('user', 'pointerdown');
    await pointer('followup', 'pointerover');
    expect(selectedIds()).toEqual(['user', 'assistant', 'followup']);
    await pointer('assistant', 'pointerover');
    expect(selectedIds()).toEqual(['user', 'assistant']);
    await release();

    await pointer('user', 'pointerdown', { ctrlKey: true });
    await pointer('assistant', 'pointerover');
    expect(selectedIds()).toEqual([]);
    await release();

    await pointer('followup', 'pointerdown', { shiftKey: true });
    expect(selectedIds()).toEqual(['user', 'assistant', 'followup']);
    await release();

    await pointer('assistant', 'pointerdown');
    await pointer('followup', 'pointerover');
    expect(selectedIds()).toEqual(['user']);
    await release();
  });

  const loroTurn = (id: string, role: 'user' | 'assistant', text?: string): SessionHistory =>
    ({
      id,
      role,
      timestamp: '2026-11-25T00:00:00.000Z',
      items: text === undefined ? [] : [{ type: 'text', text }],
      ...(role === 'assistant' ? { userTurnId: 'question', finished: true } : {}),
    }) as SessionHistory;
  it.each([
    {
      name: 'a reply before its question, a repeated user id once',
      stored: [
        loroTurn('previous', 'user', 'Synthetic earlier turn'),
        loroTurn('assistant:question', 'assistant', 'Synthetic reply'),
        loroTurn('question', 'user', 'Synthetic question'),
        loroTurn('previous', 'user', 'Synthetic newer duplicate'),
      ],
      shown: [
        ['previous', 'Synthetic newer duplicate'],
        ['question', 'Synthetic question'],
        ['assistant:question', 'Synthetic reply'],
      ],
      drag: ['previous', 'question'],
      preview: 'previous:Synthetic newer duplicate,question:Synthetic question',
    },
    {
      name: 'an empty reply slot filled by a newer duplicate',
      stored: [
        loroTurn('assistant:question', 'assistant'),
        loroTurn('previous', 'user', 'Synthetic other turn'),
        loroTurn('question', 'user', 'Synthetic question'),
        loroTurn('assistant:question', 'assistant', 'Synthetic reply'),
      ],
      shown: [
        ['question', 'Synthetic question'],
        ['assistant:question', 'Synthetic reply'],
        ['previous', 'Synthetic other turn'],
      ],
      drag: ['question', 'assistant:question'],
      preview: 'question:Synthetic question,assistant:question:Synthetic reply',
    },
  ])('selects the rows the Loro chat shows: $name', async ({ stored, shown, drag, preview }) => {
    const sessionId = 'session-reversed' as SessionId;
    const view = await openReaderView(buildSessionDoc(stored), {
      sessionId,
      tailKeep: stored.length,
      scheduleIdle: createManualIdle().scheduleIdle,
    });
    const range = view.acquireRange(0, view.turnCount);
    await range.ready;
    const streamed = buildChatStreamItems(view, sessionId).items.flatMap((item) =>
      item.type === 'message'
        ? [
            [
              item.message.id,
              item.message.items.map((block) => ('text' in block ? block.text : '')).join(''),
            ],
          ]
        : []
    );
    expect(streamed).toEqual(shown);
    const runtime = {
      withSessionStore: async (_id, read) => read({ history: view } as SessionDocStore),
    } as Pick<WorkspaceRuntime, 'withSessionStore'>;
    const candidates = collectConversationMessages(
      await readConversationCopySource(runtime, sessionId, view)
    );
    expect(candidates.map((message) => [message.id, message.text])).toEqual(shown);
    function Reversed() {
      const selection = useMessageSelection('session-reversed');
      const [selected, setSelected] = useState<ConversationMessage[]>([]);
      return (
        <>
          <button onClick={() => selection.start(candidates, setSelected)}>Start</button>
          <MessageSelectionContext.Provider value={selection.context}>
            {candidates.map((message) => (
              <MessageSelectionRow key={message.id} id={message.id} first>
                <p>{message.text}</p>
              </MessageSelectionRow>
            ))}
          </MessageSelectionContext.Provider>
          <MessageSelectionToolbar selection={selection} />
          <output>{selected.map((message) => `${message.id}:${message.text}`).join(',')}</output>
        </>
      );
    }
    await act(async () => root.render(<Reversed />));
    await click('Start');
    const pointer = async (id: string, type: string) => {
      const row = container.querySelector<HTMLElement>(`[data-message-selection-id="${id}"]`)!;
      await act(async () => row.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 })));
    };
    await pointer(drag[0]!, 'pointerdown');
    await pointer(drag[1]!, 'pointerover');
    await act(async () => window.dispatchEvent(new MouseEvent('pointerup')));
    await click('Preview image');
    expect(container.querySelector('output')?.textContent).toBe(preview);
    range.release();
    view.dispose();
  });

  it('scrolls at the edge, selects newly reached messages, and stops on release', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    container.setAttribute('data-message-selection-scroll', '');
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 500,
      top: 0,
      bottom: 400,
      width: 500,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    await click('Start');
    const first = container.querySelector<HTMLElement>('[data-message-selection-id="user"]')!;
    const last = container.querySelector<HTMLElement>('[data-message-selection-id="followup"]')!;
    const original = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => (container.scrollTop > 0 ? last : first),
    });
    try {
      await act(async () => {
        first.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 395 })
        );
      });
      const overlay = container.querySelector<HTMLDivElement>('[data-message-selection-overlay]')!;
      expect(overlay.hidden).toBe(true);
      await act(async () => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 160, clientY: 390 }));
      });
      expect(overlay.hidden).toBe(false);
      expect(overlay.style.left).toBe('100px');
      expect(overlay.style.top).toBe('390px');
      expect(overlay.style.width).toBe('60px');
      expect(overlay.style.height).toBe('5px');
      for (const time of [0, 16]) {
        await act(async () => {
          const pending = [...frames.values()];
          frames.clear();
          pending.forEach((callback) => callback(time));
        });
      }
      expect(container.scrollTop).toBeGreaterThan(0);
      expect(container.querySelectorAll('[role="checkbox"][data-checked]')).toHaveLength(3);
      await act(async () => {
        window.dispatchEvent(new MouseEvent('pointerup'));
      });
      // Releasing stops the loop, which shows as scrolling that no longer
      // advances however many frames are drained. An outstanding-frame count
      // cannot show it: Base UI's scheduler deliberately leaves its last frame
      // queued and turns it into a no-op, so any checkbox in the tree keeps one.
      const settled = container.scrollTop;
      for (const time of [32, 48]) {
        await act(async () => {
          const pending = [...frames.values()];
          frames.clear();
          pending.forEach((callback) => callback(time));
        });
      }
      expect(container.scrollTop).toBe(settled);
      expect(overlay.hidden).toBe(true);
    } finally {
      if (original) Object.defineProperty(document, 'elementFromPoint', original);
      else Reflect.deleteProperty(document, 'elementFromPoint');
    }
  });
});
