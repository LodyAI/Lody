// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionId } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildChatStreamItems } from '../src/components/ai-gui/build-chat-stream-items';
import { SessionChatStreamView } from '../src/components/ai-gui/view';
import { initI18n } from '../src/i18n';
import { createConversationViewFromHistory } from '../src/lib/conversation-view';

vi.mock('virtua', () => ({
  Virtualizer: ({ children }: { children: import('react').ReactNode }) => children,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sessionId = 'activity-session' as SessionId;

const toolCall = (id: string) => ({
  type: 'tool_call' as const,
  toolCallId: id,
  title: `Run check ${id}`,
  kind: 'execute' as const,
  status: 'completed' as const,
});

/** A live (unfinished) assistant turn with the given items. */
const liveTurn = (items: unknown[]) => [
  {
    id: 'user-turn',
    role: 'user',
    timestamp: '2026-09-19T00:00:00Z',
    items: [{ type: 'text', text: 'Please check the build.' }],
  },
  {
    id: 'assistant-turn',
    role: 'assistant',
    timestamp: '2026-09-19T00:00:01Z',
    items,
    fileDiff: [],
    finished: false,
  },
];

describe('live agent status', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = async (
    history: unknown[],
    status: { label: string; tone?: 'primary' | 'warning' },
    options: { withTurnFooter?: boolean } = {}
  ) => {
    const view = createConversationViewFromHistory({
      sessionId,
      getHistory: () => history as never,
      subscribe: () => () => {},
    });
    const { items } = buildChatStreamItems(view, sessionId);
    view.dispose();
    await act(async () =>
      root.render(
        createElement(SessionChatStreamView, {
          items,
          sessionId,
          renderMessageRow: () => null,
          agentActivityLabel: status.label,
          agentActivityTone: status.tone ?? 'primary',
          // Copy-context makes a live turn render its footer (copy/fork actions).
          ...(options.withTurnFooter ? { onCopyContext: () => {} } : {}),
        })
      )
    );
  };

  const statusRow = () => container.querySelector('[data-agent-activity-row]');
  const shimmering = () =>
    Array.from(container.querySelectorAll('.agent-shimmer')).map((el) => el.textContent);

  it('shimmers the collapsed tool group at the bottom of a working turn instead of adding a row', async () => {
    await render(liveTurn([{ type: 'text', text: 'Checking.' }, toolCall('a'), toolCall('b')]), {
      label: 'Working',
    });
    expect(statusRow()).toBeNull();
    expect(shimmering()).toEqual(['Ran 2 commands']);
  });

  it('adds a shimmering status row when the working turn does not end in a collapsed group', async () => {
    await render(liveTurn([toolCall('a'), toolCall('b'), { type: 'text', text: 'Now writing.' }]), {
      label: 'Working',
    });
    expect(statusRow()?.textContent).toBe('Working');
    expect(shimmering()).toEqual(['Working']);
  });

  it('keeps a still status row while waiting on the user', async () => {
    await render(liveTurn([{ type: 'text', text: 'May I run this?' }]), {
      label: 'Waiting for permission',
      tone: 'warning',
    });
    expect(statusRow()?.textContent).toBe('Waiting for permission');
    expect(shimmering()).toEqual([]);
  });

  it('places the status inside a live turn, above its footer actions', async () => {
    await render(
      liveTurn([toolCall('a'), toolCall('b'), { type: 'text', text: 'Now writing.' }]),
      { label: 'Working' },
      { withTurnFooter: true }
    );
    expect(statusRow()).toBeNull();
    const status = container.querySelector('[data-agent-activity-status]');
    expect(status?.textContent).toBe('Working');
    expect(
      status?.closest('[data-assistant-turn-id]')?.getAttribute('data-assistant-turn-id')
    ).toBe('assistant-turn');
    const copyContext = container.querySelector('[aria-label="Copy context as Markdown"]');
    expect(copyContext).not.toBeNull();
    // Status precedes the footer's actions in reading order.
    expect(
      status!.compareDocumentPosition(copyContext!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
