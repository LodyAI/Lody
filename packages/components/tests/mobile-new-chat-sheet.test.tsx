// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// use-gesture picks its touch device at import time; jsdom exposes no `ontouchstart`.
const runtime = vi.hoisted(() => {
  Object.assign(window, { ontouchstart: null });
  return { native: true };
});

vi.mock('../src/lib/native-platform', () => ({
  isNativeAppShell: () => runtime.native,
  isNativeIOSAppShell: () => runtime.native,
}));

import {
  MOBILE_NEW_CHAT_SLIDE_MS,
  MobileNewChatSheet,
} from '../src/components/mobile/mobile-new-chat-sheet';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;

function renderSheet() {
  act(() =>
    root.render(
      <MobileNewChatSheet
        open
        onOpenChange={onOpenChange}
        labels={{ backAriaLabel: 'Back' }}
        targetNode="New chat"
        summary={<button type="button">Project</button>}
        composer={<textarea aria-label="Message" />}
      />
    )
  );
}

function projectButton(): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Project'
  )!;
}

function panel(): HTMLElement {
  return container.querySelector<HTMLElement>('.fixed.inset-0 > div')!;
}

function touch(type: string, target: Element, x: number, y = 300) {
  const point = { identifier: 1, target, clientX: x, clientY: y };
  const ended = type === 'touchend';
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    touches: ended ? [] : [point],
    targetTouches: ended ? [] : [point],
    changedTouches: [point],
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function swipe(target: Element, fromX: number, toX: number) {
  touch('touchstart', target, fromX);
  const steps = 4;
  for (let step = 1; step <= steps; step += 1) {
    touch('touchmove', target, fromX + ((toX - fromX) * step) / steps);
  }
  touch('touchend', target, toX);
}

beforeEach(() => {
  vi.useFakeTimers();
  runtime.native = true;
  onOpenChange = vi.fn<(open: boolean) => void>();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('MobileNewChatSheet', () => {
  it('enters from the right and slides out before Back closes it', () => {
    renderSheet();
    expect(panel().classList.contains('mobile-drill-in')).toBe(true);

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click());
    expect(panel().style.transform).toBe('translate3d(100%, 0, 0)');
    expect(panel().classList.contains('mobile-drill-in')).toBe(false);
    expect(onOpenChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(MOBILE_NEW_CHAT_SLIDE_MS);
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('follows a native left-edge swipe and closes once it passes the threshold', () => {
    renderSheet();
    const target = projectButton();

    touch('touchstart', target, 10);
    const move = touch('touchmove', target, 70);
    expect(move.defaultPrevented).toBe(true);
    // The page follows the finger (less use-gesture's 1px intent threshold).
    expect(panel().style.transform).toMatch(/^translate3d\((59|60)px, 0, 0\)$/);
    touch('touchmove', target, 170);
    touch('touchend', target, 170);

    expect(panel().style.transform).toBe('translate3d(100%, 0, 0)');
    act(() => {
      vi.advanceTimersByTime(MOBILE_NEW_CHAT_SLIDE_MS);
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('snaps back a short swipe and clears the resting transform', () => {
    renderSheet();
    const target = projectButton();

    touch('touchstart', target, 10);
    touch('touchmove', target, 40);
    touch('touchend', target, 40);
    expect(panel().style.transform).toBe('translate3d(0px, 0, 0)');

    act(() => {
      vi.advanceTimersByTime(MOBILE_NEW_CHAT_SLIDE_MS);
    });
    expect(panel().style.transform).toBe('');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('leaves swipes from the composer, mid-screen, or on web to the content', () => {
    renderSheet();
    swipe(container.querySelector('textarea')!, 10, 200);
    swipe(projectButton(), 120, 320);
    act(() => {
      vi.runAllTimers();
    });
    expect(panel().style.transform).toBe('');
    expect(onOpenChange).not.toHaveBeenCalled();

    act(() => root.unmount());
    root = createRoot(container);
    runtime.native = false;
    renderSheet();
    swipe(projectButton(), 10, 200);
    act(() => {
      vi.runAllTimers();
    });
    expect(panel().style.transform).toBe('');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('closes immediately when the host hides it after first-send presentation', () => {
    renderSheet();
    act(() =>
      root.render(
        <MobileNewChatSheet
          open={false}
          onOpenChange={onOpenChange}
          targetNode="New chat"
          composer={null}
        />
      )
    );
    expect(container.querySelector('.fixed')).toBeNull();
  });
});
