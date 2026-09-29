/**
 * @vitest-environment jsdom
 */

import React, { act } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionInfoHoverCard } from '../src/components/session-info-hover-card';
import { movePointer } from './helpers/pointer-boundary';

const TITLE = 'Synthetic session title';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function pointer(type: string, target: EventTarget, init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

const cardIsOpen = () => document.body.textContent?.includes(TITLE) ?? false;

describe('SessionInfoHoverCard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('stays shut after a press until the pointer actually moves', async () => {
    await act(async () => {
      root!.render(
        <SessionInfoHoverCard title={TITLE} latestMessageAt={null} now={new Date(0)}>
          <button type="button">row</button>
        </SessionInfoHoverCard>
      );
    });
    const trigger = container!.querySelector('button')!.parentElement!;

    // The first hover warms up, then opens; leaving closes after the grace.
    await act(async () => {
      movePointer(document.body, trigger);
      vi.advanceTimersByTime(700);
    });
    expect(cardIsOpen()).toBe(true);
    await act(async () => {
      movePointer(trigger, document.body);
      vi.advanceTimersByTime(200);
    });
    expect(cardIsOpen()).toBe(false);

    // Cards are warm now, so a hover would open instantly. A press navigates,
    // and the re-rendered row fires another enter under a still pointer.
    await act(async () => {
      movePointer(document.body, trigger);
    });
    expect(cardIsOpen()).toBe(true);
    await act(async () => {
      pointer('pointerdown', trigger, { button: 0, clientX: 10, clientY: 10 });
      movePointer(trigger, document.body);
      movePointer(document.body, trigger);
    });
    expect(cardIsOpen()).toBe(false);

    // A jitter below the tolerance is not a move.
    await act(async () => {
      pointer('pointermove', document, { clientX: 12, clientY: 11 });
      movePointer(trigger, document.body);
      movePointer(document.body, trigger);
    });
    expect(cardIsOpen()).toBe(false);

    // Real movement lifts the suppression: the next hover opens as before.
    await act(async () => {
      pointer('pointermove', document, { clientX: 30, clientY: 40 });
      movePointer(trigger, document.body);
      movePointer(document.body, trigger);
    });
    expect(cardIsOpen()).toBe(true);
  });

  it('treats a portalled descendant of the trigger as outside it', async () => {
    // A popover opened from inside the trigger portals away, yet stays in the
    // trigger's React tree, so React's enter/leave count its menu as the trigger.
    const menuHost = document.createElement('div');
    document.body.appendChild(menuHost);
    await act(async () => {
      root!.render(
        <SessionInfoHoverCard title={TITLE} latestMessageAt={null} now={new Date(0)}>
          <button type="button">row</button>
          {createPortal(<div data-testid="menu">menu</div>, menuHost)}
        </SessionInfoHoverCard>
      );
    });
    const row = container!.querySelector('button')!;
    const menu = menuHost.querySelector('[data-testid="menu"]')!;

    // Moving from the row into the menu leaves the trigger: a pending warmup is
    // cancelled, or an already-warm card closes after its grace.
    await act(async () => {
      movePointer(document.body, row);
      vi.advanceTimersByTime(300);
      movePointer(row, menu);
      vi.advanceTimersByTime(700);
    });
    expect(cardIsOpen()).toBe(false);

    // Arriving straight in the menu is not a hover on the trigger either.
    await act(async () => {
      movePointer(menu, document.body);
      movePointer(document.body, menu);
      vi.advanceTimersByTime(700);
    });
    expect(cardIsOpen()).toBe(false);

    // A press in the menu does not suppress the trigger's own next hover.
    await act(async () => {
      pointer('pointerdown', menu, { button: 0, clientX: 600, clientY: 600 });
      movePointer(menu, row);
      vi.advanceTimersByTime(700);
    });
    expect(cardIsOpen()).toBe(true);
  });
});
