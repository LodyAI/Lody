// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import {
  MOBILE_CHAT_PREVIEW_MAX_ROOTS,
  MobileChatList,
} from '../src/components/mobile/mobile-chat-list';
import type { MobileConversationItem } from '../src/components/mobile/mobile-project-screen';
import { sidebarCollapsedOpenedBySessionsAtom } from '../src/atoms/focus-layer';
import { initI18n } from '../src/i18n';

/**
 * Every bucket of the mobile chat list previews at most
 * `MOBILE_CHAT_PREVIEW_MAX_ROOTS` TOP-LEVEL rows and ends in a "Show all (N)"
 * toggle — the same model the desktop sidebar's `MAX_VISIBLE_SESSIONS` applies
 * per group. Without it, one busy project buries every other project and
 * worktree below the fold.
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

/** `count` unpinned rows in one project bucket, newest first. */
function makeProjectItems(
  count: number,
  projectKey = 'p1',
  startIndex = 0
): MobileConversationItem[] {
  return Array.from({ length: count }, (_, index) =>
    makeItem({
      id: `${projectKey}-${startIndex + index}`,
      projectKey,
      projectLabel: projectKey,
      latestMessageAt: NOW - (startIndex + index) * HOUR,
    })
  );
}

let container: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof createStore>;

beforeEach(async () => {
  await initI18n();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  store = createStore();
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function render(
  chats: MobileConversationItem[],
  props: Partial<React.ComponentProps<typeof MobileChatList>> = {}
) {
  flushSync(() => {
    root.render(
      <Provider store={store}>
        <MobileChatList chats={chats} groupBy="project" capGroupPreviews {...props} />
      </Provider>
    );
  });
}

function rows(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.mobile-project-conversation-row'));
}

function titles(): string[] {
  return rows().map((row) => row.textContent?.trim() ?? '');
}

function toggles(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('[data-chat-list-preview-toggle]')
  );
}

function toggleLabels(): string[] {
  return toggles().map((button) => button.textContent?.trim() ?? '');
}

describe('mobile chat list group preview cap', () => {
  it('caps only when the caller opts in, independently of grouping', () => {
    // Both directions matter, and neither follows from the other. The
    // in-project list drills into one project deliberately, so it opts out and
    // must render everything. And the cap must NOT be inferred from `groupBy`:
    // the project page is only `none` because `chat-landing.tsx` pins it for
    // heading reasons, so deriving the cap from grouping would silently switch
    // it on there the day that page grows a date mode — hiding the very
    // worktree rows the cap exists to expose.
    render(makeProjectItems(9, 'p1'), { capGroupPreviews: false });
    expect(rows()).toHaveLength(9);
    expect(toggles()).toHaveLength(0);

    render(makeProjectItems(9, 'p1'), { groupBy: 'none' });
    expect(rows()).toHaveLength(MOBILE_CHAT_PREVIEW_MAX_ROOTS);
    expect(toggleLabels()).toEqual(['Show all (9)']);
  });


  it('previews five rows per overflowing bucket and leaves the rest alone', () => {
    // Three boundary points in one list: over the cap (trimmed, toggle),
    // exactly at it (untouched, no toggle — an off-by-one in the `>` would
    // surface here and nowhere else), and under it (untouched, no toggle).
    render([
      ...makeProjectItems(9, 'p1'),
      ...makeProjectItems(MOBILE_CHAT_PREVIEW_MAX_ROOTS, 'p2'),
      ...makeProjectItems(2, 'p3'),
    ]);
    expect(titles()).toEqual([
      'Session p1-0',
      'Session p1-1',
      'Session p1-2',
      'Session p1-3',
      'Session p1-4',
      'Session p2-0',
      'Session p2-1',
      'Session p2-2',
      'Session p2-3',
      'Session p2-4',
      'Session p3-0',
      'Session p3-1',
    ]);
    expect(toggleLabels()).toEqual(['Show all (9)']);
  });

  it('expands and re-collapses only the bucket that was tapped', () => {
    render([...makeProjectItems(9, 'p1'), ...makeProjectItems(8, 'p2')]);
    expect(toggleLabels()).toEqual(['Show all (9)', 'Show all (8)']);

    act(() => {
      toggles()[0]!.click();
    });
    expect(titles().filter((title) => title.includes('p1-'))).toHaveLength(9);
    // The untapped bucket keeps its preview.
    expect(titles().filter((title) => title.includes('p2-'))).toHaveLength(5);
    expect(toggleLabels()).toEqual(['Show less', 'Show all (8)']);
    expect(toggles()[0]!.getAttribute('aria-expanded')).toBe('true');

    act(() => {
      toggles()[0]!.click();
    });
    expect(titles().filter((title) => title.includes('p1-'))).toHaveLength(5);
    expect(toggleLabels()).toEqual(['Show all (9)', 'Show all (8)']);
    expect(toggles()[0]!.getAttribute('aria-expanded')).toBe('false');
  });

  it('counts top-level rows, so a preview never splits an opener', () => {
    // Four standalone rows plus an opener with three opened Sessions is five
    // TOP-LEVEL rows: nothing overflows, and all eight rows render. Counting
    // raw rows instead would cut inside the opener's group.
    const chats = [
      ...makeProjectItems(4, 'p1'),
      makeItem({
        id: 'opener',
        projectKey: 'p1',
        projectLabel: 'p1',
        latestMessageAt: NOW - 10 * HOUR,
      }),
      ...['a', 'b', 'c'].map((suffix, index) =>
        makeItem({
          id: `opened-${suffix}`,
          projectKey: 'p1',
          projectLabel: 'p1',
          openedBySessionId: 'opener',
          openedByRowSessionId: 'opener',
          latestMessageAt: NOW - (11 + index) * HOUR,
        })
      ),
    ];
    render(chats);
    expect(rows()).toHaveLength(8);
    expect(toggles()).toHaveLength(0);
  });

  it('keeps a kept root together with the Sessions it opened', () => {
    // Six top-level rows, the last of which opened two Sessions. The cap drops
    // the sixth root entirely rather than showing it without its children.
    const chats = [
      ...makeProjectItems(5, 'p1'),
      makeItem({
        id: 'opener',
        projectKey: 'p1',
        projectLabel: 'p1',
        latestMessageAt: NOW - 20 * HOUR,
      }),
      ...['a', 'b'].map((suffix, index) =>
        makeItem({
          id: `opened-${suffix}`,
          projectKey: 'p1',
          projectLabel: 'p1',
          openedBySessionId: 'opener',
          openedByRowSessionId: 'opener',
          latestMessageAt: NOW - (21 + index) * HOUR,
        })
      ),
    ];
    render(chats);
    expect(titles()).not.toContain('Session opener');
    expect(titles()).not.toContain('Session opened-a');
    expect(toggleLabels()).toEqual(['Show all (8)']);

    act(() => {
      toggles()[0]!.click();
    });
    expect(titles().slice(5)).toEqual([
      'Session opener',
      'Session opened-a',
      'Session opened-b',
    ]);
  });

  it('truncates the pinned-first order rather than reshuffling it', () => {
    // A pinned row outranks fresher unpinned ones, so it must survive the cap
    // even though it is the stalest row in the bucket.
    render([
      ...makeProjectItems(6, 'p1'),
      makeItem({
        id: 'stale-pin',
        isPinned: true,
        projectKey: 'p1',
        projectLabel: 'p1',
        latestMessageAt: NOW - 99 * HOUR,
      }),
    ]);
    // Pinned rows lift into their own bucket, which is itself capped.
    expect(titles()).toEqual([
      'Session stale-pin',
      'Session p1-0',
      'Session p1-1',
      'Session p1-2',
      'Session p1-3',
      'Session p1-4',
    ]);
    expect(toggleLabels()).toEqual(['Show all (6)']);
  });

  it('pulls the toggle back into view when a bucket collapses', () => {
    // Measured in Chromium with `overflow-anchor: none` (Safari/iOS ships no
    // scroll anchoring): collapsing a 14-row bucket drops the toggle from
    // y=328 to y=-68, off the top of the viewport. With this correction it
    // lands at y=0. jsdom has no layout, so what is observable here is WHICH
    // element the list asks the browser to keep on screen.
    let scrolled: { target: Element; options: unknown } | null = null;
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(options) {
      scrolled = { target: this, options };
    };
    try {
      render(makeProjectItems(9, 'p1'));
      act(() => {
        toggles()[0]!.click();
      });
      // Expanding only appends rows BELOW the toggle. Moving the viewport
      // there would yank the list out from under the reader.
      expect(scrolled).toBeNull();

      act(() => {
        toggles()[0]!.click();
      });
      expect(scrolled).not.toBeNull();
      expect(scrolled!.target).toBe(toggles()[0]);
      expect(scrolled!.options).toEqual({ block: 'nearest' });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('does not write the preview state into the shared opener-fold atom', () => {
    // The fold atom is shared with the drawer sidebar; how many rows a mobile
    // bucket previews is this surface's business alone.
    render(makeProjectItems(9, 'p1'));
    act(() => {
      toggles()[0]!.click();
    });
    expect(store.get(sidebarCollapsedOpenedBySessionsAtom)).toEqual({});
  });

  it('shows every row while multi-select is active', () => {
    // "Select all" operates on every id in the list, so a capped surface would
    // let the user confirm a permanent delete of rows it never showed.
    vi.useFakeTimers();
    try {
      const chats = makeProjectItems(9, 'p1');
      render(chats, { archived: true, onPermanentDelete: () => {} });
      expect(rows()).toHaveLength(MOBILE_CHAT_PREVIEW_MAX_ROOTS);

      // Long-press the first row: pointerdown, then let the injected clock run
      // past the 500ms hold. No wall-clock sleep is involved.
      act(() => {
        rows()[0]!.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, clientX: 8, clientY: 8 })
        );
      });
      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(rows()).toHaveLength(chats.length);
      expect(toggles()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
