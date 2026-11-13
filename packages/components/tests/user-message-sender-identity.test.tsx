// @vitest-environment jsdom

// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider as JotaiProvider } from 'jotai';

import {
  getSessionRoomId,
  type SessionHistory,
  type SessionHistoryParsed,
  type SessionId,
} from '@lody/shared';

import { setDocMetaByRoomIdAtom } from '../src/atoms/doc-meta';
import { buildChatStreamItems } from '../src/components/ai-gui/build-chat-stream-items';
import { createConversationViewFromHistory } from '../src/lib/conversation-view';

import { MessageRowView } from '../src/components/ai-gui/view';
import { ForceDesktopLayoutProvider } from '../src/hooks/use-mobile';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sessionId = 'session-sender-identity' as SessionId;
const message = {
  id: 'message-from-maya',
  role: 'user',
  userId: 'user-maya',
  timestamp: '2026-09-08T10:30:00.000Z',
  read: true,
  status: 'applied',
  items: [{ type: 'text', text: 'Please show who sent this message.' }],
} as unknown as SessionHistoryParsed;
const user = { name: 'Maya Chen', email: 'maya.chen@example.com', image: null };

const click = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('user message sender identity', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          JotaiProvider,
          null,
          createElement(
            ForceDesktopLayoutProvider,
            null,
            createElement(MessageRowView, {
              message,
              sessionId,
              user,
              showSenderIdentity: true,
            })
          )
        )
      );
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  it('opens the desktop sender card from the avatar', async () => {
    const trigger = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="View profile for Maya Chen"]'
    );
    expect(trigger).toBeTruthy();
    expect(document.body.textContent).not.toContain('maya.chen@example.com');

    await click(trigger!);

    expect(document.body.textContent).toContain('Maya Chen');
    expect(document.body.textContent).toContain('maya.chen@example.com');
  });

  it('shows a Role author in a solo workspace without the human profile and exposes source model details', async () => {
    const author = {
      v: 1 as const,
      kind: 'agent' as const,
      sessionId: 'source-session',
      turnId: 'source-turn',
      name: 'Agent A',
      role: { id: 'reviewer', revision: 1, name: 'Reviewer', emoji: '🔎' },
      model: { id: 'model-a', source: 'runtime' as const },
    };
    const history = [
      { ...message, author, inputConfig: { modelId: 'model-b' } },
    ] as unknown as SessionHistory[];
    const projected = buildChatStreamItems(
      createConversationViewFromHistory({
        sessionId,
        getHistory: () => history,
        subscribe: () => () => {},
      }),
      sessionId
    ).items[0];
    if (projected?.type !== 'message') throw new Error('Expected hydrated message');
    await act(async () =>
      root?.render(
        createElement(
          JotaiProvider,
          null,
          createElement(
            ForceDesktopLayoutProvider,
            null,
            createElement(MessageRowView, {
              message: projected.message,
              sessionId,
              user,
              showSenderIdentity: false,
            })
          )
        )
      )
    );
    expect(
      container?.querySelector('[data-testid="user-message-metadata"]')?.textContent
    ).toContain('Reviewer');
    expect(
      container?.querySelector('[data-testid="user-message-source-session-link"]')
    ).toBeNull();
    expect(container?.textContent).toContain('🔎');
    expect(container?.querySelector('button[aria-label="View profile for Maya Chen"]')).toBeNull();
    const trigger = container?.querySelector('button[aria-label="View sender: Reviewer"]');
    expect(trigger).toBeTruthy();
    await click(trigger!);
    expect(document.body.textContent).toContain('Model: model-a');
    expect(document.body.textContent).not.toContain('maya.chen@example.com');
    expect(document.body.textContent).not.toContain('Model: model-b');
  });

  it('renders an inline source conversation link in the metadata row and navigates back to the source session', async () => {
    const onNavigateSession = vi.fn();
    const store = createStore();
    const author = {
      v: 1 as const,
      kind: 'agent' as const,
      sessionId: 'source-session',
      turnId: 'source-turn',
      name: 'Agent A',
      role: { id: 'reviewer', revision: 1, name: 'Reviewer', emoji: '🔎' },
    };
    const delegatedMessage = { ...message, author } as unknown as SessionHistoryParsed;

    await act(async () =>
      root?.render(
        createElement(
          JotaiProvider,
          { store },
          createElement(
            ForceDesktopLayoutProvider,
            null,
            createElement(MessageRowView, {
              message: delegatedMessage,
              sessionId,
              user,
              showSenderIdentity: false,
              onNavigateSession,
            })
          )
        )
      )
    );

    const sourceButton = container?.querySelector<HTMLButtonElement>(
      '[data-testid="user-message-source-session-link"]'
    );
    expect(sourceButton).toBeTruthy();
    expect(sourceButton?.textContent).toBe('Open source conversation');
    expect(sourceButton?.getAttribute('aria-label')).toBe('Open source conversation');

    await click(sourceButton!);
    expect(onNavigateSession).toHaveBeenCalledTimes(1);
    expect(onNavigateSession).toHaveBeenCalledWith({ sessionId: 'source-session' });

    await act(async () => {
      store.set(setDocMetaByRoomIdAtom, getSessionRoomId('source-session' as SessionId), {
        id: 'source-session',
        title: 'Coordinate PR #789 fix',
      });
    });

    const updatedButton = container?.querySelector<HTMLButtonElement>(
      '[data-testid="user-message-source-session-link"]'
    );
    expect(updatedButton?.textContent).toBe('Coordinate PR #789 fix');
    expect(updatedButton?.getAttribute('aria-label')).toBe(
      'Open source conversation: Coordinate PR #789 fix'
    );
  });

  it('keeps sender identity hidden when the workspace has one member', async () => {
    await act(async () => {
      root?.render(
        createElement(
          JotaiProvider,
          null,
          createElement(
            ForceDesktopLayoutProvider,
            null,
            createElement(MessageRowView, {
              message,
              sessionId,
              user,
              showSenderIdentity: false,
            })
          )
        )
      );
    });

    expect(
      container?.querySelector('[data-testid="user-message-metadata"]')?.textContent
    ).not.toContain('Maya Chen');
    expect(container?.querySelector('button[aria-label="View profile for Maya Chen"]')).toBeNull();
  });
});
