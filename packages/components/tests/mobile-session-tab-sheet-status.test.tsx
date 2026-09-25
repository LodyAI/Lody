// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MobileSessionTabSheet,
  type ConversationTabEntry,
} from '../src/components/mobile/mobile-session-tab-sheet';

/**
 * A background tab blocked on a permission request is the ONLY signal the tab
 * sheet carries that the user has to act on. It must not read as one more
 * spinner: a subagent tab waiting for approval is otherwise indistinguishable
 * from a subagent tab that is merely busy, and the run stays stalled.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}));

vi.mock('../src/ui/drawer', async () => {
  const React = await import('react');
  const Passthrough = ({ children }: { readonly children?: ReactNode }) =>
    React.createElement('div', null, children);
  return {
    Drawer: Passthrough,
    DrawerContent: Passthrough,
    DrawerTitle: Passthrough,
    DrawerDescription: Passthrough,
  };
});

const WAITING_LABEL = 'Waiting for permission';

function entry(overrides: Partial<ConversationTabEntry> & { id: string }): ConversationTabEntry {
  return {
    title: `Tab ${overrides.id}`,
    active: false,
    running: false,
    unread: false,
    lastActivityAt: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

/** Conversation rows, in render order (viewer rows are excluded by the caller). */
function renderRows(conversations: ConversationTabEntry[]): HTMLElement[] {
  flushSync(() => {
    root.render(
      createElement(MobileSessionTabSheet, {
        open: true,
        onOpenChange: vi.fn(),
        conversations,
        viewers: [],
        onSelectConversation: vi.fn(),
        onNewConversation: vi.fn(),
        onSelectViewer: vi.fn(),
      })
    );
  });
  return Array.from(container.querySelectorAll<HTMLElement>('button[aria-current]'));
}

const hand = (row: HTMLElement) => row.querySelector(`[aria-label="${WAITING_LABEL}"]`);
const spinner = (row: HTMLElement) =>
  row.querySelector('.animate-spin, [data-slot="spinner"]');
const unreadDot = (row: HTMLElement) => row.querySelector('[aria-label="Unread messages"]');

describe('mobile session tab sheet status slot', () => {
  it('marks a subagent tab waiting for approval with the hand', () => {
    const [main, subagent] = renderRows([
      entry({ id: 'main', main: true, active: true }),
      entry({ id: 'subagent', running: true, waitingPermission: true }),
    ]);
    expect(hand(subagent!)).not.toBeNull();
    expect(spinner(subagent!)).toBeNull();
    expect(hand(main!)).toBeNull();
  });

  it('keeps the spinner for a tab that is working but not blocked', () => {
    const [working] = renderRows([entry({ id: 'working', running: true })]);
    expect(spinner(working!)).not.toBeNull();
    expect(hand(working!)).toBeNull();
  });

  it('ranks waiting above unread when a tab is both', () => {
    const [both] = renderRows([
      entry({ id: 'both', running: true, waitingPermission: true, unread: true }),
    ]);
    expect(hand(both!)).not.toBeNull();
    expect(unreadDot(both!)).toBeNull();
  });
});

describe('archive and closed conversations', () => {
  function renderSheet(onNewConversation: (() => void) | undefined) {
    flushSync(() => {
      root.render(
        createElement(MobileSessionTabSheet, {
          open: true,
          onOpenChange: vi.fn(),
          conversations: [entry({ id: 'main', main: true, active: true })],
          archivedConversations: [
            { id: 'closed', title: 'Closed child', lastActivityAt: null },
            {
              id: 'archived',
              title: 'Archived child',
              lastActivityAt: null,
              restoresArchive: true,
            },
          ],
          viewers: [],
          onSelectConversation: vi.fn(),
          onNewConversation,
          onSelectViewer: vi.fn(),
          onRestoreConversation: vi.fn(),
        })
      );
    });
    flushSync(() => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'))
        .find((button) => button.textContent?.startsWith('Closed'))!
        .click();
    });
  }

  it('labels an archived child of a live workspace Restore and a closed tab Reopen', () => {
    renderSheet(vi.fn());
    expect(container.textContent).toContain('New Chat');
    const labels = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label]'),
      (button) => [button.textContent?.trim(), button.getAttribute('aria-label')]
    ).filter(([text]) => text === 'Closed child' || text === 'Archived child');
    expect(labels).toEqual([
      ['Closed child', 'Reopen conversation'],
      ['Archived child', 'Restore session'],
    ]);
  });

  it('offers no New Chat in a review-only archived workspace', () => {
    renderSheet(undefined);
    expect(container.textContent).not.toContain('New Chat');
  });
});
