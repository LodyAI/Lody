// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { conversationWideModeAtom } from '../src/atoms/settings';
import { ConversationColumn } from '../src/components/shared/conversation-column';
import {
  CONVERSATION_CONTENT_WIDTH_CLASS,
  CONVERSATION_CONTENT_WIDTH_WIDE_CLASS,
} from '../src/lib/conversation-layout';

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

function renderColumn(store: ReturnType<typeof createStore>) {
  return act(async () =>
    root.render(
      createElement(
        Provider,
        { store },
        createElement(ConversationColumn, { 'data-testid': 'column' })
      )
    )
  );
}

function columnClasses(): string {
  return container.querySelector<HTMLElement>('[data-testid="column"]')?.className ?? '';
}

describe('ConversationColumn wide mode', () => {
  it('renders the capped column by default', async () => {
    const store = createStore();
    await renderColumn(store);
    for (const cls of CONVERSATION_CONTENT_WIDTH_CLASS.split(' ')) {
      expect(columnClasses()).toContain(cls);
    }
  });

  it('drops the max-width cap when wide mode is on, keeping the shared gutter', async () => {
    const store = createStore();
    store.set(conversationWideModeAtom, true);
    await renderColumn(store);

    for (const cls of CONVERSATION_CONTENT_WIDTH_WIDE_CLASS.split(' ')) {
      expect(columnClasses()).toContain(cls);
    }
    expect(columnClasses()).not.toContain('max-w-[calc(48rem+28px)]');
  });

  it('switches the column when the atom flips', async () => {
    const store = createStore();
    await renderColumn(store);
    expect(columnClasses()).toContain('max-w-[calc(48rem+28px)]');

    await act(async () => store.set(conversationWideModeAtom, true));
    expect(columnClasses()).not.toContain('max-w-[calc(48rem+28px)]');

    await act(async () => store.set(conversationWideModeAtom, false));
    expect(columnClasses()).toContain('max-w-[calc(48rem+28px)]');
  });
});
