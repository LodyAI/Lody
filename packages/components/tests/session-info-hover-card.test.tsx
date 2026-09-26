/**
 * @vitest-environment jsdom
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionInfoHoverCard } from '../src/components/session-info-hover-card';

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
      pointer('pointerover', trigger, { relatedTarget: document.body });
      vi.advanceTimersByTime(700);
    });
    expect(cardIsOpen()).toBe(true);
    await act(async () => {
      pointer('pointerout', trigger, { relatedTarget: document.body });
      vi.advanceTimersByTime(200);
    });
    expect(cardIsOpen()).toBe(false);

    // Cards are warm now, so a hover would open instantly. A press navigates,
    // and the re-rendered row fires another enter under a still pointer.
    await act(async () => {
      pointer('pointerover', trigger, { relatedTarget: document.body });
    });
    expect(cardIsOpen()).toBe(true);
    await act(async () => {
      pointer('pointerdown', trigger, { button: 0, clientX: 10, clientY: 10 });
      pointer('pointerout', trigger, { relatedTarget: document.body });
      pointer('pointerover', trigger, { relatedTarget: document.body });
    });
    expect(cardIsOpen()).toBe(false);

    // A jitter below the tolerance is not a move.
    await act(async () => {
      pointer('pointermove', document, { clientX: 12, clientY: 11 });
      pointer('pointerout', trigger, { relatedTarget: document.body });
      pointer('pointerover', trigger, { relatedTarget: document.body });
    });
    expect(cardIsOpen()).toBe(false);

    // Real movement lifts the suppression: the next hover opens as before.
    await act(async () => {
      pointer('pointermove', document, { clientX: 30, clientY: 40 });
      pointer('pointerout', trigger, { relatedTarget: document.body });
      pointer('pointerover', trigger, { relatedTarget: document.body });
    });
    expect(cardIsOpen()).toBe(true);
  });
});
