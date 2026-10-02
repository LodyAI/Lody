// @vitest-environment jsdom
import { act, createRef, StrictMode, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import { EngineConversationScroller } from '../src/components/ai-gui/conversation-list/engine-conversation-scroller';
import type {
  ConversationListHandle,
  ConversationRowComponentProps,
  ConversationScrollerState,
} from '../src/components/ai-gui/conversation-list/types';
import { clearSavedScrollStates } from '../src/lib/conversation-scroll/saved-state';
import type { EngineRow } from '../src/lib/conversation-scroll/types';
import { createFrameHarness, type FrameHarness } from './support/scroll-frame-harness';

/**
 * The engine's React adapter under browser-ordered scroll events and
 * ResizeObserver deliveries (see the frame harness), with real React commits.
 * The scenario that left the removed Virtua path hidden for good must leave
 * this one covered, with the reader's row where it was. Reader input is
 * dispatched as real events; tests assert the mode and the position.
 */

const VIEWPORT = 400;
const ROW = 100;

function Row({ index, ...props }: ConversationRowComponentProps) {
  return <div {...props} data-virtual-index={index} />;
}

const meta = (key: string, turnIndex: number): EngineRow => ({
  key,
  turnId: key.split('.')[0]!,
  turnIndex,
  itemIndex: key.includes('.') ? Number(key.split('.')[1]) : null,
  itemIdentity: null,
  firstItemIndex: key.includes('.') ? Number(key.split('.')[1]) : null,
  placeholder: false,
  fixed: null,
  estimate: ROW,
});

type Ctx = {
  harness: FrameHarness;
  host: HTMLElement;
  root: ReturnType<typeof createRoot>;
  handle: { current: ConversationListHandle | null };
  state: { current: ConversationScrollerState | null };
  /** Every offset the list reported through `onScroll`. */
  scrolls: number[];
  setKeys: (keys: string[]) => void;
  viewport: () => HTMLElement;
  settle: () => Promise<void>;
};

let offsetParentDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  offsetParentDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  clearSavedScrollStates();
});

afterEach(() => {
  if (offsetParentDescriptor)
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParentDescriptor);
  vi.unstubAllGlobals();
});

function mount(
  sessionId: SessionId,
  initialKeys: string[],
  harnessToReuse?: FrameHarness,
  {
    strict = false,
    suppress,
    hidden,
    feedback = false,
    tickOnScroll = false,
  }: {
    strict?: boolean;
    suppress?: { current: boolean };
    /** The tab is inactive: `display: none`, so every offset and size reads 0. */
    hidden?: { current: boolean };
    /** A view whose state flips whenever it is told the offset is 0. */
    feedback?: boolean;
    /** A view that setStates on every onScroll, like the top-fade flag. */
    tickOnScroll?: boolean;
  } = {}
): Ctx {
  let keys = initialKeys;
  const px = (value: string | undefined) => parseFloat(value ?? '0') || 0;
  const isHidden = () => hidden?.current === true;
  const harness =
    harnessToReuse ??
    createFrameHarness({
      viewportHeight: () => (isHidden() ? 0 : VIEWPORT),
      scrollHeightOf: (viewport) => {
        if (isHidden()) return 0;
        const container = viewport.firstElementChild as HTMLElement | null;
        const spacer = container?.nextElementSibling as HTMLElement | null;
        return px(container?.style.height) + px(spacer?.style.height);
      },
      sizeOf: (element) => {
        const el = element as HTMLElement;
        if (isHidden()) return 0;
        if (el.hasAttribute('data-message-selection-scroll')) return VIEWPORT;
        if (el.hasAttribute('data-virtual-index')) return ROW;
        return undefined;
      },
      rectOf: (element, scrollTop) => {
        const el = element as HTMLElement;
        if (isHidden()) return { top: 0, height: 0 };
        if (el.hasAttribute('data-message-selection-scroll')) return { top: 0, height: VIEWPORT };
        if (
          el.parentElement?.hasAttribute('data-message-selection-scroll') &&
          !el.hasAttribute('data-conversation-reply-room')
        )
          return { top: -scrollTop, height: px(el.style.height) };
        if (el.hasAttribute('data-virtual-index'))
          return { top: px(el.style.top) - scrollTop, height: ROW };
        return undefined;
      },
    });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const handle = createRef<ConversationListHandle>() as { current: ConversationListHandle | null };
  const state: Ctx['state'] = { current: null };
  let attached = false;
  const onStateChange = (next: ConversationScrollerState) => {
    state.current = next;
    if (next.scrollElement && !attached) {
      attached = true;
      harness.attachViewport(next.scrollElement);
    }
  };
  const scrolls: number[] = [];
  function List({ listKeys }: { listKeys: string[] }) {
    // Stands in for the view's position-derived state (hydration window,
    // outline): at offset 0 it changes the rows, which commits the list again.
    const [flipped, setFlipped] = useState(false);
    const [, setTick] = useState(0);
    const shown = flipped ? ['flipped', ...listKeys] : listKeys;
    return (
      <EngineConversationScroller
        sessionId={sessionId}
        rows={shown.map((key): ReactElement => (
          <div key={key} data-row-key={key}>
            {key}
          </div>
        ))}
        rowMeta={shown.map((key, index) => meta(key, index))}
        item={Row}
        initialWindowReady
        hidden={isHidden()}
        onScroll={(offset) => {
          scrolls.push(offset);
          if (feedback && offset === 0) setFlipped((value) => !value);
          if (tickOnScroll) setTick((n) => n + 1);
        }}
        suppressAutoScrollRef={suppress}
        onStateChange={onStateChange}
        layoutKey="14"
        bufferSize={800}
        handleRef={handle}
      />
    );
  }
  const render = () => {
    const list = <List listKeys={keys} />;
    root.render(strict ? <StrictMode>{list}</StrictMode> : list);
  };
  act(render);
  return {
    harness,
    host,
    root,
    handle,
    state,
    scrolls,
    viewport: () => host.firstElementChild as HTMLElement,
    setKeys(next) {
      keys = next;
      act(render);
    },
    async settle() {
      for (let i = 0; i < 30; i++) {
        let delivered = false;
        await act(async () => {
          delivered = harness.frame();
          await Promise.resolve();
        });
        if (!delivered) return;
      }
      throw new Error('frames did not settle');
    },
  };
}

function unmount(ctx: Ctx, restoreHarness = true) {
  act(() => ctx.root.unmount());
  ctx.host.remove();
  if (restoreHarness) ctx.harness.restore();
}

const rowKeys = (count: number) => Array.from({ length: count }, (_, i) => `r${i}`);

const expandAbove = (keys: string[], n: number) =>
  keys.flatMap((key) => (key === 'r5' ? Array.from({ length: n }, (_, i) => `r5.${i}`) : [key]));

function mountedKeys(ctx: Ctx): string[] {
  return [...ctx.viewport().querySelectorAll<HTMLElement>('[data-row-key]')].map(
    (el) => el.dataset.rowKey!
  );
}

function screenTopOf(ctx: Ctx, key: string): number | null {
  const row = ctx.viewport().querySelector<HTMLElement>(`[data-row-key="${key}"]`)?.parentElement;
  if (!row) return null;
  return (parseFloat(row.style.top) || 0) - ctx.harness.scrollTop;
}

function keysOnScreen(keys: string[], scrollTop: number): string[] {
  const first = Math.floor(scrollTop / ROW);
  const last = Math.ceil((scrollTop + VIEWPORT) / ROW) - 1;
  return keys.slice(first, last + 1);
}

it('opens at the real bottom and never hides the viewport', async () => {
  const keys = rowKeys(60);
  const ctx = mount('engine-open' as SessionId, keys);
  try {
    await ctx.settle();
    expect(ctx.viewport().style.visibility).toBe('');
    expect(ctx.harness.scrollTop).toBe(60 * ROW - VIEWPORT);
    expect(ctx.state.current?.isSticky).toBe(true);
    expect(ctx.state.current?.revealed).toBe(true);
    expect(mountedKeys(ctx)).toEqual(
      expect.arrayContaining(keysOnScreen(keys, ctx.harness.scrollTop))
    );
  } finally {
    unmount(ctx);
  }
});

it('restores a reading position and keeps it covered when rows far beyond the overscan expand above it', async () => {
  const sessionId = 'engine-restore' as SessionId;
  const keys = rowKeys(60);
  const first = mount(sessionId, keys);
  await first.settle();
  await act(async () => {
    first.handle.current?.scrollRowToTop(30, { smooth: false, offset: 0 });
  });
  await first.settle();
  expect(screenTopOf(first, 'r30')).toBe(0);
  expect(first.state.current?.isSticky).toBe(false);
  unmount(first, false);

  // Reopen, and before any frame the placeholder above becomes fourteen rows.
  const ctx = mount(sessionId, keys, first.harness);
  try {
    const expanded = expandAbove(keys, 14);
    ctx.setKeys(expanded);
    await ctx.settle();
    expect(screenTopOf(ctx, 'r30')).toBe(0);
    const onScreen = keysOnScreen(expanded, ctx.harness.scrollTop);
    expect(mountedKeys(ctx)).toEqual(expect.arrayContaining(onScreen));
    expect(ctx.viewport().style.visibility).toBe('');
  } finally {
    unmount(ctx);
  }
});

it('returns to following with the handle and keeps the latest row on screen as it grows', async () => {
  const keys = rowKeys(40);
  const ctx = mount('engine-follow' as SessionId, keys);
  try {
    await ctx.settle();
    await act(async () => {
      ctx.handle.current?.scrollRowToTop(5, { smooth: false, offset: 0 });
    });
    await ctx.settle();
    expect(ctx.state.current?.isSticky).toBe(false);
    await act(async () => {
      ctx.handle.current?.scrollToBottom();
    });
    await ctx.settle();
    expect(ctx.state.current?.isSticky).toBe(true);
    ctx.setKeys([...keys, 'r40', 'r41']);
    await ctx.settle();
    expect(ctx.harness.scrollTop).toBe(42 * ROW - VIEWPORT);
    expect(mountedKeys(ctx)).toContain('r41');
  } finally {
    unmount(ctx);
  }
});

// ---- Reader input -----------------------------------------------------------
// Real events on the mounted DOM; the observable result is the mode (the
// sticky state) and whether new rows at the end move the viewport.

const BOTTOM = (count: number) => count * ROW - VIEWPORT;

/** Append two rows; a following viewport moves to the new end, a reading one stays. */
async function appendRows(ctx: Ctx, keys: string[]): Promise<string[]> {
  const next = [...keys, `r${keys.length}`, `r${keys.length + 1}`];
  ctx.setKeys(next);
  await ctx.settle();
  return next;
}

async function openFollowing(name: string, options?: Parameters<typeof mount>[3]) {
  const keys = rowKeys(40);
  const ctx = mount(name as SessionId, keys, undefined, options);
  await ctx.settle();
  expect(ctx.harness.scrollTop).toBe(BOTTOM(40));
  expect(ctx.state.current?.isSticky).toBe(true);
  return { ctx, keys };
}

function rowElement(ctx: Ctx, key: string): HTMLElement {
  return ctx.viewport().querySelector<HTMLElement>(`[data-row-key="${key}"]`)!;
}

it('an upward wheel over the conversation stops following; the reader stays put as rows arrive', async () => {
  const { ctx, keys } = await openFollowing('engine-wheel-up');
  try {
    await act(async () => {
      rowElement(ctx, 'r38').dispatchEvent(
        new WheelEvent('wheel', { deltaY: -120, bubbles: true })
      );
    });
    ctx.harness.nativeScrollTo(BOTTOM(40) - 120);
    await ctx.settle();
    expect(ctx.state.current?.isSticky).toBe(false);
    await appendRows(ctx, keys);
    expect(ctx.harness.scrollTop).toBe(BOTTOM(40) - 120);
  } finally {
    unmount(ctx);
  }
});

it('an upward wheel scrolling a nested code block or terminal keeps following', async () => {
  const { ctx, keys } = await openFollowing('engine-wheel-nested');
  try {
    const nested = document.createElement('pre');
    nested.style.overflowY = 'auto';
    Object.defineProperty(nested, 'scrollTop', { configurable: true, value: 40 });
    const line = document.createElement('span');
    nested.append(line);
    rowElement(ctx, 'r38').append(nested);
    await act(async () => {
      line.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    });
    // A downward wheel and a pinch zoom are not the reader leaving the end either.
    await act(async () => {
      rowElement(ctx, 'r38').dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }));
      rowElement(ctx, 'r38').dispatchEvent(
        new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true })
      );
    });
    expect(ctx.state.current?.isSticky).toBe(true);
    await appendRows(ctx, keys);
    expect(ctx.harness.scrollTop).toBe(BOTTOM(42));
  } finally {
    unmount(ctx);
  }
});

it('an upward navigation key in the conversation stops following; typing and other controls do not', async () => {
  const { ctx, keys } = await openFollowing('engine-keys');
  // The composer and a menu outside the list, and an edit box inside a row.
  const composer = document.createElement('textarea');
  const menu = document.createElement('button');
  document.body.append(composer, menu);
  const editor = document.createElement('textarea');
  rowElement(ctx, 'r38').append(editor);
  try {
    await act(async () => {
      for (const target of [composer, menu, editor]) {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      }
    });
    expect(ctx.state.current?.isSticky).toBe(true);
    const grown = await appendRows(ctx, keys);
    expect(ctx.harness.scrollTop).toBe(BOTTOM(42));

    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    });
    ctx.harness.nativeScrollTo(BOTTOM(42) - 400);
    await ctx.settle();
    expect(ctx.state.current?.isSticky).toBe(false);
    await appendRows(ctx, grown);
    expect(ctx.harness.scrollTop).toBe(BOTTOM(42) - 400);
  } finally {
    composer.remove();
    menu.remove();
    editor.remove();
    unmount(ctx);
  }
});

it('an upward move with no pointer or touch is corrected back to the end', async () => {
  const { ctx } = await openFollowing('engine-unowned-move');
  try {
    ctx.harness.nativeScrollTo(BOTTOM(40) - 300);
    await ctx.settle();
    expect(ctx.harness.scrollTop).toBe(BOTTOM(40));
    expect(ctx.state.current?.isSticky).toBe(true);
  } finally {
    unmount(ctx);
  }
});

it.each([
  [
    'a held scrollbar thumb',
    (viewport: HTMLElement) =>
      viewport.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true })),
    () => document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })),
  ],
  [
    'a touch pan',
    (viewport: HTMLElement) => viewport.dispatchEvent(new Event('touchstart', { bubbles: true })),
    (viewport: HTMLElement) => viewport.dispatchEvent(new Event('touchend', { bubbles: true })),
  ],
])('an upward move under %s stops following', async (_name, press, lift) => {
  const { ctx, keys } = await openFollowing(`engine-held-${_name}`);
  try {
    await act(async () => press(ctx.viewport()));
    ctx.harness.nativeScrollTo(BOTTOM(40) - 300);
    await ctx.settle();
    await act(async () => lift(ctx.viewport()));
    expect(ctx.state.current?.isSticky).toBe(false);
    await appendRows(ctx, keys);
    expect(ctx.harness.scrollTop).toBe(BOTTOM(40) - 300);
  } finally {
    unmount(ctx);
  }
});

it('a suppression (selection, a jump, search) stops following at the next change', async () => {
  const suppress = { current: false };
  const { ctx, keys } = await openFollowing('engine-suppressed', { suppress });
  try {
    suppress.current = true;
    await appendRows(ctx, keys);
    expect(ctx.harness.scrollTop).toBe(BOTTOM(40));
    expect(ctx.state.current?.isSticky).toBe(false);
  } finally {
    unmount(ctx);
  }
});

it('keeps scrolling under StrictMode, whose development remount reruns effect cleanups', async () => {
  const { ctx, keys } = await openFollowing('engine-strict', { strict: true });
  try {
    await appendRows(ctx, keys);
    expect(ctx.harness.scrollTop).toBe(BOTTOM(42));
    await act(async () => {
      ctx.handle.current?.scrollRowToTop(10, { smooth: false, offset: 0 });
    });
    await ctx.settle();
    expect(screenTopOf(ctx, 'r10')).toBe(0);
  } finally {
    unmount(ctx);
  }
});

it('a hidden tab reports no offset, so a view feeding it back cannot loop; shown again, it reads where it was', async () => {
  const hidden = { current: false };
  const { ctx, keys } = await openFollowing('engine-hidden', { hidden, feedback: true });
  try {
    await act(async () => {
      ctx.handle.current?.scrollRowToTop(20, { smooth: false, offset: 0 });
    });
    await ctx.settle();
    expect(screenTopOf(ctx, 'r20')).toBe(0);
    const reported = ctx.scrolls.length;

    // Switching tabs hides this one (dropping its offset) while it streams on.
    hidden.current = true;
    ctx.harness.nativeScrollTo(0);
    const grown = [...keys, 'r40', 'r41'];
    ctx.setKeys(grown);
    await ctx.settle();
    expect(ctx.scrolls.length).toBe(reported);

    hidden.current = false;
    ctx.setKeys(grown);
    await ctx.settle();
    expect(screenTopOf(ctx, 'r20')).toBe(0);
    expect(ctx.state.current?.isSticky).toBe(false);
    expect(ctx.scrolls.at(-1)).toBe(ctx.harness.scrollTop);
  } finally {
    unmount(ctx);
  }
});

it('a view that setStates on every onScroll does not nested-update-loop', async () => {
  const { ctx } = await openFollowing('engine-scroll-tick', { tickOnScroll: true });
  try {
    expect(ctx.harness.scrollTop).toBe(BOTTOM(40));
    expect(ctx.state.current?.revealed).toBe(true);
    expect(ctx.scrolls.length).toBeGreaterThan(0);
    expect(ctx.scrolls.length).toBeLessThan(20);
  } finally {
    unmount(ctx);
  }
});
