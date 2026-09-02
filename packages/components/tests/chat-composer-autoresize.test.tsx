// @vitest-environment jsdom

import { act, createRef } from 'react';
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

import { ChatComposer } from '../src/components/chat/chat-composer';
import { ForceMobileLayoutProvider } from '../src/hooks/use-mobile';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('ChatComposer auto resize', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
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

  it('grows through 11 rows and becomes internally scrollable after that', async () => {
    const promptRef = createRef<HTMLTextAreaElement>();
    const skipNextViewportResizeAutoScrollRef = { current: false };
    const renderComposer = (promptValue: string) => (
      <ChatComposer
        variant="session"
        promptRef={promptRef}
        promptValue={promptValue}
        onPromptChange={() => undefined}
        promptRows={2}
        primaryAction={null}
        autoResize
        maxRows={11}
        skipNextViewportResizeAutoScrollRef={skipNextViewportResizeAutoScrollRef}
      />
    );

    await act(async () => root.render(renderComposer('one line')));

    const textarea = promptRef.current;
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    expect(skipNextViewportResizeAutoScrollRef.current).toBe(false);
    textarea!.style.lineHeight = '24px';
    let scrollHeight = 240;
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });

    await act(async () => root.render(renderComposer('ten\n'.repeat(10))));

    expect(textarea?.style.height).toBe('240px');
    expect(textarea?.style.overflowY).toBe('hidden');
    expect(skipNextViewportResizeAutoScrollRef.current).toBe(true);

    scrollHeight = 288;
    await act(async () => root.render(renderComposer('twelve\n'.repeat(12))));

    const computed = getComputedStyle(textarea!);
    const elevenRowsHeight =
      24 * 11 +
      Number.parseFloat(computed.paddingTop || '0') +
      Number.parseFloat(computed.paddingBottom || '0');
    expect(textarea?.style.height).toBe(`${elevenRowsHeight}px`);
    expect(textarea?.style.overflowY).toBe('auto');
  });

  it('allows a mobile session composer to start taller than the compact default', async () => {
    const promptRef = createRef<HTMLTextAreaElement>();

    await act(async () =>
      root.render(
        <ForceMobileLayoutProvider force>
          <ChatComposer
            variant="session"
            promptRef={promptRef}
            promptValue=""
            onPromptChange={() => undefined}
            mobileSessionPromptRows={3}
            primaryAction={null}
            autoResize
            maxRows={8}
          />
        </ForceMobileLayoutProvider>
      )
    );

    const textarea = promptRef.current;
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    expect(textarea?.getAttribute('rows')).toBe('3');

    const computed = getComputedStyle(textarea!);
    const threeRowsHeight =
      24 * 3 +
      Number.parseFloat(computed.paddingTop || '0') +
      Number.parseFloat(computed.paddingBottom || '0');
    expect(textarea?.style.height).toBe(`${threeRowsHeight}px`);
  });
});
