// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { MobileChatListCard } from '../src/components/mobile/mobile-chat-list';
import type { MobileConversationItem } from '../src/components/mobile/mobile-project-screen';
import { sidebarCollapsedOpenedBySessionsAtom } from '../src/atoms/focus-layer';
import { initI18n } from '../src/i18n';

/**
 * The mobile chat list renders the SAME opened-by model as the desktop sidebar
 * (`lib/session-opened-by-tree.ts`): a Session created by the
 * `lody_session_create` MCP tool indents one level under its opener, and the
 * opener carries a fold control backed by the shared collapse atom.
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 3, 22, 10, 0, 0);

function makeItem(overrides: Partial<MobileConversationItem> & { id: string }) {
  return {
    kind: 'chat',
    title: `Session ${overrides.id}`,
    latestMessageAt: NOW - HOUR,
    ...overrides,
  } satisfies MobileConversationItem;
}

/** Opener + three opened independent Sessions, plus one unrelated row. */
function makeOpenerItems(): MobileConversationItem[] {
  return [
    makeItem({ id: 'opener', latestMessageAt: NOW }),
    makeItem({
      id: 'opened-1',
      openedBySessionId: 'opener',
      openedByRowSessionId: 'opener',
      latestMessageAt: NOW - HOUR,
    }),
    makeItem({
      id: 'opened-2',
      openedBySessionId: 'opener',
      openedByRowSessionId: 'opener',
      latestMessageAt: NOW - 2 * HOUR,
    }),
    makeItem({
      id: 'opened-3',
      openedBySessionId: 'opener',
      openedByRowSessionId: 'opener',
      latestMessageAt: NOW - 3 * HOUR,
    }),
    makeItem({ id: 'unrelated', latestMessageAt: NOW - 4 * HOUR }),
  ];
}

let container: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof createStore>;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await initI18n();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  store = createStore();
});

afterEach(async () => {
  // Unmount and drain React work before jsdom removes window. flushSync alone
  // leaves scheduled work behind even when the DOM is already up to date.
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(chats: MobileConversationItem[]) {
  await act(async () => {
    root.render(
      <Provider store={store}>
        <MobileChatListCard chats={chats} />
      </Provider>
    );
  });
  return rows();
}

function rows(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.mobile-project-conversation-row'));
}

function titles(list: HTMLElement[]): string[] {
  return list.map((row) => row.textContent?.trim() ?? '');
}

function isNested(row: HTMLElement): boolean {
  return row.querySelector('[data-conversation-tree-connector]') !== null;
}

/** The opener's fold control is a SIBLING of the row button, never a child. */
function toggleFor(row: HTMLElement): HTMLButtonElement | null {
  return (
    row.parentElement?.querySelector<HTMLButtonElement>('[data-conversation-tree-toggle]') ?? null
  );
}

describe('mobile chat list opened-by tree', () => {
  it('renders opened sessions directly after their opener', async () => {
    const list = await render(makeOpenerItems());
    expect(titles(list)).toEqual([
      'Session opener',
      'Session opened-1',
      'Session opened-2',
      'Session opened-3',
      'Session unrelated',
    ]);
    expect(list.map(isNested)).toEqual([false, true, true, true, false]);
  });

  it('indents an opened session by widening its leading slot, not the row', async () => {
    const list = await render(makeOpenerItems());
    const slot = (row: HTMLElement) =>
      row.querySelector<HTMLElement>('[data-conversation-row-leading-slot]')?.className ?? '';
    // The node must not move: only the slot after it widens (16px -> 32px), so
    // the opener, its opened Sessions, and unrelated rows share one node x
    // while the content indents.
    expect(slot(list[0]!)).toContain('w-4');
    expect(slot(list[4]!)).toContain('w-4');
    expect(slot(list[1]!)).toContain('w-8');
    expect(slot(list[1]!)).toContain('justify-start');
    // Every row keeps the flat px-4; nothing shifts the row background.
    for (const row of list) expect(row.className).toContain('px-4');
  });

  it('keeps the flat DOM in a bucket with no nesting', async () => {
    // The regression that matters most: an ordinary list must not change shape
    // just because the feature exists.
    const list = await render([makeItem({ id: 'a' }), makeItem({ id: 'b' })]);
    expect(list[0]?.className).toContain('px-4');
    expect(
      list[0]?.querySelector('[data-conversation-row-leading-slot]')?.className
    ).toContain('w-4');
    expect(toggleFor(list[0]!)).toBeNull();
  });

  it('gives an ACTIVE opened session its status instead of the connector', async () => {
    // One node, one meaning: "this session needs you" outranks "this session
    // was opened by that one". Same rule the desktop sidebar row applies.
    const list = await render([
      makeItem({ id: 'opener', latestMessageAt: NOW }),
      makeItem({
        id: 'busy',
        isWorking: true,
        openedBySessionId: 'opener',
        openedByRowSessionId: 'opener',
        latestMessageAt: NOW - HOUR,
      }),
      makeItem({
        id: 'idle',
        openedBySessionId: 'opener',
        openedByRowSessionId: 'opener',
        latestMessageAt: NOW - 2 * HOUR,
      }),
    ]);
    expect(isNested(list[1]!)).toBe(false);
    expect(isNested(list[2]!)).toBe(true);
    // It still indents — losing the lines must not also lose the hierarchy.
    expect(
      list[1]?.querySelector('[data-conversation-row-leading-slot]')?.className
    ).toContain('w-8');
  });

  it('gives an ACTIVE opener its status instead of the fold control', async () => {
    const list = await render([
      makeItem({ id: 'opener', isWorking: true, latestMessageAt: NOW }),
      makeItem({
        id: 'opened',
        openedBySessionId: 'opener',
        openedByRowSessionId: 'opener',
        latestMessageAt: NOW - HOUR,
      }),
    ]);
    expect(toggleFor(list[0]!)).toBeNull();
    // The tree itself is untouched — only the affordance yields.
    expect(isNested(list[1]!)).toBe(true);
  });

  it('renders the fold control only on the opener, outside the row button', async () => {
    const list = await render(makeOpenerItems());
    const toggle = toggleFor(list[0]!);
    expect(toggle).not.toBeNull();
    // Nesting a button inside the row button would be invalid HTML and
    // unreachable to assistive tech.
    expect(list[0]!.querySelector('[data-conversation-tree-toggle]')).toBeNull();
    expect(toggle!.getAttribute('aria-expanded')).toBe('true');
    expect(toggleFor(list[1]!)).toBeNull();
    expect(toggleFor(list[4]!)).toBeNull();
  });

  it('folds and unfolds the opened sessions when the control is tapped', async () => {
    // Assert the fold STATE, not the row count: `AnimatePresence` keeps a
    // removed row mounted for its 400ms exit, so counting DOM rows right after
    // the tap would be a race on the animation clock.
    await render(makeOpenerItems());
    await act(async () => {
      toggleFor(rows()[0]!)!.click();
    });
    expect(store.get(sidebarCollapsedOpenedBySessionsAtom)).toEqual({ opener: true });
    expect(toggleFor(rows()[0]!)!.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      toggleFor(rows()[0]!)!.click();
    });
    expect(store.get(sidebarCollapsedOpenedBySessionsAtom)).toEqual({ opener: false });
    expect(toggleFor(rows()[0]!)!.getAttribute('aria-expanded')).toBe('true');
  });

  it('reads its folded state from the shared sidebar atom', async () => {
    // Folding in the sidebar drawer and in the mobile list must never disagree.
    store.set(sidebarCollapsedOpenedBySessionsAtom, { opener: true });
    const list = await render(makeOpenerItems());
    expect(titles(list)).toEqual(['Session opener', 'Session unrelated']);
  });

  it('stops the connector trunk at the last opened session', async () => {
    const list = await render(makeOpenerItems());
    const trunkOf = (row: HTMLElement) =>
      row.querySelector('[data-conversation-tree-connector] > span')?.className ?? '';
    // Middle children carry the trunk into the next row; the last one ends it
    // at the elbow so it does not dangle past the group.
    expect(trunkOf(list[1]!)).toContain('bottom-0');
    expect(trunkOf(list[2]!)).toContain('bottom-0');
    expect(trunkOf(list[3]!)).toContain('h-1/2');
    expect(trunkOf(list[3]!)).not.toContain('bottom-0');
  });

  it('keeps a session whose opener is missing from this list at top level', async () => {
    // The orphan fallback: an opener that is archived, filtered out, or in
    // another bucket must never hide the Session it opened.
    const list = await render([
      makeItem({ id: 'visible', latestMessageAt: NOW }),
      makeItem({
        id: 'orphan',
        openedBySessionId: 'gone',
        openedByRowSessionId: 'gone',
        latestMessageAt: NOW - HOUR,
      }),
    ]);
    expect(titles(list)).toEqual(['Session visible', 'Session orphan']);
    expect(list.map(isNested)).toEqual([false, false]);
  });

  it('ranks an opener by its freshest opened session', async () => {
    // The opener is the oldest row in the list but it opened the newest one, so
    // the whole group must still sort above the mid-aged standalone row —
    // otherwise nesting would silently break the list's recency order.
    const list = await render([
      makeItem({ id: 'stale-opener', latestMessageAt: NOW - 5 * HOUR }),
      makeItem({ id: 'standalone', latestMessageAt: NOW - 2 * HOUR }),
      makeItem({
        id: 'fresh-child',
        openedBySessionId: 'stale-opener',
        openedByRowSessionId: 'stale-opener',
        latestMessageAt: NOW,
      }),
    ]);
    expect(titles(list)).toEqual([
      'Session stale-opener',
      'Session fresh-child',
      'Session standalone',
    ]);
  });

  it('keeps a pinned opener above an unpinned one with fresher opened sessions', async () => {
    const list = await render([
      makeItem({ id: 'pinned', isPinned: true, latestMessageAt: NOW - 9 * HOUR }),
      makeItem({ id: 'unpinned', latestMessageAt: NOW - HOUR }),
      makeItem({
        id: 'unpinned-child',
        openedBySessionId: 'unpinned',
        openedByRowSessionId: 'unpinned',
        latestMessageAt: NOW,
      }),
    ]);
    expect(titles(list)).toEqual(['Session pinned', 'Session unpinned', 'Session unpinned-child']);
  });
});
