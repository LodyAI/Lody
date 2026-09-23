// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Provider as JotaiProvider } from 'jotai';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';

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
