// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import {
  countUpdatedItemRoots,
  getVisibleUpdatedItems,
  SHOW_FULL_BUCKET_THRESHOLD,
  SidebarUpdatedSessionList,
  sortUpdatedItems,
  updatedBucketOverflowsPreview,
  type SidebarUpdatedItem,
} from '../src/components/sidebar-updated-session-list';
import { sidebarCollapsedOpenedBySessionsAtom } from '../src/atoms/focus-layer';
import { initI18n } from '../src/i18n';

function makeItem(overrides: Partial<SidebarUpdatedItem> & { id: string }): SidebarUpdatedItem {
  return {
    kind: 'chat',
    title: `Session ${overrides.id}`,
    sectionLabel: 'Chats',
    latestMessageAt: '2026-04-22T00:00:00.000Z',
    ...overrides,
  };
}

/** Opener + three opened independent Sessions, plus one unrelated row. */
function makeOpenerItems(): SidebarUpdatedItem[] {
  return [
    makeItem({ id: 'opener', latestMessageAt: '2026-04-22T10:00:00.000Z' }),
    makeItem({
      id: 'opened-1',
      openedBySessionId: 'opener',
      isWorking: true,
      latestMessageAt: '2026-04-22T09:30:00.000Z',
    }),
    makeItem({
      id: 'opened-2',
      openedBySessionId: 'opener',
      hasUnreadMessages: true,
      latestMessageAt: '2026-04-22T09:20:00.000Z',
    }),
    makeItem({
      id: 'opened-3',
      openedBySessionId: 'opener',
      latestMessageAt: '2026-04-22T09:10:00.000Z',
    }),
    makeItem({ id: 'unrelated', latestMessageAt: '2026-04-22T08:00:00.000Z' }),
  ];
}

describe('updated bucket opened-by tree', () => {
  it('renders opened sessions directly after their opener', () => {
    const ordered = sortUpdatedItems(makeOpenerItems());
    expect(getVisibleUpdatedItems(ordered, true, false).map((item) => item.id)).toEqual([
      'opener',
      'opened-1',
      'opened-2',
      'opened-3',
      'unrelated',
    ]);
  });

  it('ranks an opener by its freshest opened session, keeping Updated truly recency-ordered', () => {
    // The opener itself is the oldest row in the list, but it opened the newest
    // one — the whole group must still sort above the mid-aged standalone row.
    const ordered = sortUpdatedItems([
      makeItem({ id: 'standalone', latestMessageAt: '2026-04-22T09:00:00.000Z' }),
      makeItem({ id: 'stale-opener', latestMessageAt: '2026-04-20T00:00:00.000Z' }),
      makeItem({
        id: 'fresh-opened',
        openedBySessionId: 'stale-opener',
        latestMessageAt: '2026-04-22T11:00:00.000Z',
      }),
    ]);

    expect(getVisibleUpdatedItems(ordered, true, false).map((item) => item.id)).toEqual([
      'stale-opener',
      'fresh-opened',
      'standalone',
    ]);
  });

  it('hides opened sessions behind a collapsed opener', () => {
    const ordered = sortUpdatedItems(makeOpenerItems());
    expect(
      getVisibleUpdatedItems(ordered, true, false, { opener: true }).map((item) => item.id)
    ).toEqual(['opener', 'unrelated']);
  });

  it('leaves an opened session top-level when its opener is in another section', () => {
    // Mirrors the pinned/updated split: this list holds the opened Session only.
    const ordered = sortUpdatedItems([
      makeItem({ id: 'opened', openedBySessionId: 'pinned-opener' }),
      makeItem({ id: 'other' }),
    ]);
    expect(getVisibleUpdatedItems(ordered, true, false).map((item) => item.id)).toEqual([
      'opened',
      'other',
    ]);
    expect(countUpdatedItemRoots(ordered)).toBe(2);
  });

  it('measures the preview threshold in top-level rows', () => {
    const openerGroup = sortUpdatedItems([
      makeItem({ id: 'opener' }),
      ...Array.from({ length: SHOW_FULL_BUCKET_THRESHOLD }, (_unused, index) =>
        makeItem({ id: `opened-${index}`, openedBySessionId: 'opener' })
      ),
    ]);
    expect(updatedBucketOverflowsPreview(openerGroup)).toBe(false);
    expect(getVisibleUpdatedItems(openerGroup, true, false)).toHaveLength(
      SHOW_FULL_BUCKET_THRESHOLD + 1
    );

    const flat = sortUpdatedItems(
      Array.from({ length: SHOW_FULL_BUCKET_THRESHOLD + 1 }, (_unused, index) =>
        makeItem({ id: `flat-${index}` })
      )
    );
    expect(updatedBucketOverflowsPreview(flat)).toBe(true);
    expect(getVisibleUpdatedItems(flat, true, false)).toHaveLength(SHOW_FULL_BUCKET_THRESHOLD);
  });
});

describe('SidebarUpdatedSessionList opened-by rendering', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  function render(
    items: SidebarUpdatedItem[],
    options: { collapsed?: Record<string, boolean>; selectedItemId?: string } = {}
  ) {
    const store = createStore();
    store.set(sidebarCollapsedOpenedBySessionsAtom, options.collapsed ?? {});
    const onSelectItem = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(SidebarUpdatedSessionList, {
            items,
            now: new Date('2026-04-22T12:00:00.000Z'),
            selectedItemId: options.selectedItemId ?? null,
            onSelectItem,
          })
        )
      );
    });

    return { onSelectItem };
  }

  function depthOf(id: string): string | null | undefined {
    const row = container?.querySelector(`[data-sidebar-updated-id="${id}"]`);
    return row?.closest('[data-session-tree-depth]')?.getAttribute('data-session-tree-depth');
  }

  it('indents opened sessions under their opener', () => {
    render(makeOpenerItems());
    expect(depthOf('opener')).toBe('0');
    expect(depthOf('opened-1')).toBe('1');
    expect(depthOf('opened-3')).toBe('1');
    expect(depthOf('unrelated')).toBe('0');
  });

  it('keeps a flat list flat, with no tree gutter', () => {
    render([makeItem({ id: 'a' }), makeItem({ id: 'b' })]);
    expect(container?.querySelector('[data-session-tree-depth]')).toBeNull();
  });

  it('renders one disclosure toggle on the opener and collapses on click', () => {
    const { onSelectItem } = render(makeOpenerItems());
    const toggles = container?.querySelectorAll('[data-session-opened-by-toggle]') ?? [];
    expect(toggles).toHaveLength(1);

    flushSync(() => {
      toggles[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(container?.querySelector('[data-sidebar-updated-id="opener"]')).not.toBeNull();
    expect(container?.querySelector('[data-sidebar-updated-id="opened-1"]')).toBeNull();
    // Toggling the tree must never navigate.
    expect(onSelectItem).not.toHaveBeenCalled();
  });

  it('shares the tree affordance slot with the row menu button', () => {
    render(makeOpenerItems());
    const openerSlot = container
      ?.querySelector('[data-sidebar-updated-id="opener"]')
      ?.querySelector('[data-session-row-leading-slot]');
    expect(openerSlot?.querySelector('[data-session-opened-by-toggle]')).not.toBeNull();
    expect(openerSlot?.querySelector('button[aria-label="More actions"]')).not.toBeNull();

    const childSlot = container
      ?.querySelector('[data-sidebar-updated-id="opened-3"]')
      ?.querySelector('[data-session-row-leading-slot]');
    expect(childSlot?.querySelectorAll('[data-session-tree-connector]')).toHaveLength(2);
    expect(childSlot?.querySelector('[data-session-tree-connector="trunk"]')).not.toBeNull();
    expect(childSlot?.querySelector('[data-session-tree-connector="elbow"]')).not.toBeNull();
    expect(childSlot?.querySelector('button[aria-label="More actions"]')).not.toBeNull();
  });

  it('keeps the connectors on a working or unread child and puts status at the row end', () => {
    // `opened-1` is working and `opened-2` is unread: the rows most likely to be
    // watched are exactly the ones that used to lose their ├/└ to a status mark.
    render(makeOpenerItems());

    const rowOf = (id: string) => container?.querySelector(`[data-sidebar-updated-id="${id}"]`);

    for (const id of ['opened-1', 'opened-2', 'opened-3']) {
      expect(
        rowOf(id)
          ?.querySelector('[data-session-row-leading-slot]')
          ?.querySelectorAll('[data-session-tree-connector]')
      ).toHaveLength(2);
    }

    expect(
      rowOf('opened-1')?.querySelector(
        '[data-session-row-end-slot] [data-session-working-spinner]'
      )
    ).not.toBeNull();
    expect(
      rowOf('opened-2')?.querySelector('[data-session-row-end-slot] [data-session-row-indicator]')
    ).not.toBeNull();
    expect(
      rowOf('opened-3')?.querySelector('[data-session-row-end-slot] [data-session-row-indicator]')
    ).toBeNull();
  });

  it('offers collapse from the opener context menu', () => {
    render(makeOpenerItems());
    const opener = container?.querySelector('[data-sidebar-updated-id="opener"]');

    flushSync(() => {
      opener?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });

    const collapseItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
      item.textContent?.includes('Hide opened sessions')
    );
    expect(collapseItem).toBeDefined();

    flushSync(() => {
      collapseItem?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(container?.querySelector('[data-sidebar-updated-id="opened-1"]')).toBeNull();
  });

  it('routes an opener action through the root Session and restores its child Tab', () => {
    const { onSelectItem } = render([
      makeItem({ id: 'root' }),
      makeItem({
        id: 'opened-from-tab',
        openedBySessionId: 'child-tab',
        openedByRowSessionId: 'root',
      }),
    ]);
    const opened = container?.querySelector('[data-sidebar-updated-id="opened-from-tab"]');

    flushSync(() => {
      opened?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const openerItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
      item.textContent?.includes('Go to Opener Session')
    );
    flushSync(() => {
      openerItem?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(onSelectItem).toHaveBeenCalledWith('root', 'child-tab');
  });

  it('renders a working and an unread opened session with their own row state', () => {
    render(makeOpenerItems(), { selectedItemId: 'opened-2' });
    const working = container?.querySelector('[data-sidebar-updated-id="opened-1"]');
    expect(working?.querySelector('[data-session-working-spinner]')).not.toBeNull();
    const selected = container?.querySelector('[data-sidebar-updated-id="opened-2"]');
    expect(selected).not.toBeNull();
  });

  it('renders an orphan opened session as a top-level row with no gutter', () => {
    render([makeItem({ id: 'orphan', openedBySessionId: 'elsewhere' }), makeItem({ id: 'plain' })]);
    expect(container?.querySelector('[data-session-tree-depth]')).toBeNull();
    expect(container?.querySelector('[data-sidebar-updated-id="orphan"]')).not.toBeNull();
  });
});
