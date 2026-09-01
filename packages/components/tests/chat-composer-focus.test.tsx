// @vitest-environment jsdom

import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/mentions/mention-session-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionMentionItems: () => [],
}));

vi.mock('../src/components/mentions/mention-agent-role-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgentRoleMentionItems: () => [],
}));

import { ChatComposer } from '../src/components/chat/chat-composer';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('ChatComposer focusOnContainerClick', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('focuses textarea when clicking container background with focusOnContainerClick=true', async () => {
    const promptRef = createRef<HTMLTextAreaElement>();
    await act(async () => {
      root.render(
        createElement(ChatComposer, {
          promptRef,
          promptValue: '',
          onPromptChange: () => undefined,
          focusOnContainerClick: true,
        })
      );
    });

    const boxContainer = container.querySelector('.group.relative') as HTMLElement;
    expect(boxContainer).not.toBeNull();
    expect(document.activeElement).not.toBe(promptRef.current);

    await act(async () => {
      boxContainer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.activeElement).toBe(promptRef.current);
  });

  it('does not focus textarea when focusOnContainerClick is false', async () => {
    const promptRef = createRef<HTMLTextAreaElement>();
    await act(async () => {
      root.render(
        createElement(ChatComposer, {
          promptRef,
          promptValue: '',
          onPromptChange: () => undefined,
          focusOnContainerClick: false,
        })
      );
    });

    const boxContainer = container.querySelector('.group.relative') as HTMLElement;
    await act(async () => {
      boxContainer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.activeElement).not.toBe(promptRef.current);
  });

  it('does not focus textarea when clicking a button, input, or portalled element', async () => {
    const promptRef = createRef<HTMLTextAreaElement>();
    const customInputRef = createRef<HTMLInputElement>();

    await act(async () => {
      root.render(
        createElement(ChatComposer, {
          promptRef,
          promptValue: '',
          onPromptChange: () => undefined,
          focusOnContainerClick: true,
          footerSelector: createElement('input', {
            ref: customInputRef,
            'aria-label': 'custom-input',
          }),
        })
      );
    });

    const input = customInputRef.current;
    expect(input).not.toBeNull();

    await act(async () => {
      input?.focus();
      input?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.activeElement).toBe(input);
    expect(document.activeElement).not.toBe(promptRef.current);
  });
});
