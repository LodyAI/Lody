// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/mentions/mention-session-source', async (importOriginal) => ({
  ...(await importOriginal()),
  useSessionMentionItems: () => [],
}));

// Agent Roles read the visible-machine index, which needs the authenticated
// Convex context; the same reason the session source above is stubbed.
vi.mock('../src/components/mentions/mention-agent-role-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgentRoleMentionItems: () => [],
}));

import { ChatLandingView } from '../src/components/chat/chat-landing-view';
import { initI18n } from '../src/i18n';
import { composerIn } from './composer-test-utils';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('ChatLandingView submission feedback', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(async () => {
    await initI18n('en');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  const render = async (submissionPending: boolean) => {
    if (!container) {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
    await act(async () => {
      root?.render(
        createElement(ChatLandingView, {
          tone: 'light',
          title: 'New chat',
          promptValue: 'preserved draft',
          onPromptChange: () => undefined,
          submitDisabled: submissionPending,
          submissionPending,
          submitLabel: 'Send',
          submittingLabel: 'Sending',
          errorLabels: { tryAgain: 'Crash fallback retry' },
        })
      );
    });
  };

  it('hides but preserves the draft while durable acceptance is pending', async () => {
    await render(true);

    const textarea = composerIn(container!);
    expect(
      Array.from(container?.querySelectorAll('button') ?? []).some(
        (button) => button.textContent === 'Crash fallback retry'
      )
    ).toBe(false);
    expect(textarea?.value).toBe('');
    expect(textarea?.disabled).toBe(true);
    expect(container?.querySelector('button[aria-label="Sending"]')).not.toBeNull();

    await render(false);

    expect(
      Array.from(container?.querySelectorAll('button') ?? []).some(
        (button) => button.textContent === 'Crash fallback retry'
      )
    ).toBe(false);
    expect(composerIn(container!).value).toBe('preserved draft');
    expect(composerIn(container!).disabled).toBe(false);
    expect(container?.querySelector('button[aria-label="Send"]')).not.toBeNull();
  });
});
