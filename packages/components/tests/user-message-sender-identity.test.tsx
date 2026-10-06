// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Provider as JotaiProvider } from 'jotai';
import { getAgentRoleEmoji } from '@lody/shared';
import type { SessionHistory, SessionHistoryParsed, SessionId } from '@lody/shared';

import { buildChatStreamItems } from '../src/components/ai-gui/build-chat-stream-items';
import { createConversationViewFromHistory } from '../src/lib/conversation-view';
import { MessageAuthorIdentity } from '../src/components/ai-gui/message-author-identity';
import { OpenAIIcon } from '../src/components/icons/openai-icon';
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

  it('places the sender at the right edge of the reversed metadata row', () => {
    const metadata = container?.querySelector('[data-testid="user-message-metadata"]');
    expect(metadata?.firstElementChild?.textContent).toBe('Maya Chen');
    expect(metadata?.textContent).toContain('Maya Chen');
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
    expect(container?.textContent).toContain('🔎');
    expect(container?.querySelector('button[aria-label="View profile for Maya Chen"]')).toBeNull();
    const trigger = container?.querySelector('button[aria-label="View sender: Reviewer"]');
    expect(trigger).toBeTruthy();
    await click(trigger!);
    expect(document.body.textContent).toContain('Model: model-a');
    expect(document.body.textContent).not.toContain('maya.chen@example.com');
    expect(document.body.textContent).not.toContain('Model: model-b');
  });

  it('uses the Role catalog emoji whenever a Role exists and provider logo only without a Role', async () => {
    const author = {
      v: 1 as const,
      kind: 'agent' as const,
      sessionId: 'source',
      turnId: 'turn',
      name: 'Codex',
      cliType: 'builtin' as const,
      agentType: 'codex',
      role: { id: 'reviewer', revision: 1, name: 'reviewer', emoji: '' },
    };
    await act(async () =>
      root?.render(
        createElement(
          'div',
          null,
          createElement(MessageAuthorIdentity, {
            author: { ...author, role: undefined },
          }),
          createElement('div', { 'data-testid': 'expected-provider' }, createElement(OpenAIIcon))
        )
      )
    );
    const trigger = container!.querySelector('button[aria-label="View sender: Codex"]')!;
    expect(trigger.getAttribute('aria-label')).toBe('View sender: Codex');
    expect(trigger.textContent).not.toContain('🤖');
    expect(trigger.querySelector('svg')?.innerHTML).toBe(
      container!.querySelector('[data-testid="expected-provider"] svg')?.innerHTML
    );
    await act(async () => root?.render(createElement(MessageAuthorIdentity, { author })));
    expect(container!.textContent).toContain(getAgentRoleEmoji({}));
    expect(container!.querySelector('button')?.getAttribute('aria-label')).toBe(
      'View sender: reviewer'
    );
    expect(container!.querySelector('svg')).toBeNull();
    await act(async () =>
      root?.render(
        createElement(MessageAuthorIdentity, {
          author: { ...author, role: { ...author.role, emoji: '🔎' } },
        })
      )
    );
    expect(container!.textContent).toContain('🔎');
    expect(container!.querySelector('svg')).toBeNull();
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
