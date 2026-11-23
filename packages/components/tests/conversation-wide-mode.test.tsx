// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { conversationWideModeAtom } from '../src/atoms/settings';
import { ConversationColumn } from '../src/components/shared/conversation-column';

/**
 * Full-width mode (Settings > Appearance) is owned by `ConversationColumn`:
 * every region sharing the column (stream rows, info bar, composer, pin,
 * permission surface) switches together, so the toggle lives in exactly one
 * place. These pin that single point of indirection.
 */

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.removeItem('lody-conversation-wide-mode');
});

describe('ConversationColumn wide mode', () => {
  it('keeps a draft and DOM identity when the shared mode changes', async () => {
    const store = createStore();
    await act(async () =>
      root.render(
        createElement(
          Provider,
          { store },
          createElement(
            ConversationColumn,
            { 'aria-label': 'Conversation', style: { minHeight: 24 } },
            createElement('input', { defaultValue: 'Draft' })
          )
        )
      )
    );
    const column = container.querySelector<HTMLDivElement>('[data-slot="conversation-column"]')!;
    const input = container.querySelector('input')!;
    input.value = 'Draft still being edited';
    await act(async () => store.set(conversationWideModeAtom, true));
    expect(container.querySelector('[data-slot="conversation-column"]')).toBe(column);
    expect(container.querySelector('input')).toBe(input);
    expect(input.value).toBe('Draft still being edited');
    expect(column.getAttribute('aria-label')).toBe('Conversation');
    expect(column.style.minHeight).toBe('24px');
    await act(async () => store.set(conversationWideModeAtom, false));
    expect(container.querySelector('[data-slot="conversation-column"]')).toBe(column);
    expect(input.value).toBe('Draft still being edited');
  });
});
