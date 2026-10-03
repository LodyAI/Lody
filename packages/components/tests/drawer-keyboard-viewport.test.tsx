// @vitest-environment jsdom

import { act, useState } from 'react';
import { Menu } from '@lody/ui/menu';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Drawer, DrawerContent, DrawerTitle } from '../src/ui/drawer';

const runtime = vi.hoisted(() => ({ native: true, ios: false }));
vi.mock('../src/lib/native-platform', () => ({
  isNativeAppShell: () => runtime.native,
  isNativeIOSAppShell: () => runtime.native && runtime.ios,
}));
vi.mock('../src/lib/utils', async () => {
  const { clsx } = await import('clsx');
  const { twMerge } = await import('tailwind-merge');
  return { cn: (...inputs: Parameters<typeof clsx>) => twMerge(clsx(...inputs)) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let viewport: EventTarget & { height: number; offsetTop: number; scale: number };

beforeEach(() => {
  vi.useFakeTimers();
  runtime.native = true;
  runtime.ios = false;
  viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 800);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderDrawer(repositionInputs = true) {
  act(() => {
    root.render(
      <Drawer direction="right" open modal={false} repositionInputs={repositionInputs}>
        <DrawerContent aria-describedby={undefined}>
          <DrawerTitle>Conversation</DrawerTitle>
          <textarea aria-label="Message" />
        </DrawerContent>
      </Drawer>
    );
  });
  const drawer = document.querySelector<HTMLElement>('[data-slot="drawer-content"]')!;
  // Model the browser's automatic inset:0 layout as its viewport resizes.
  vi.spyOn(drawer, 'getBoundingClientRect').mockImplementation(
    () => ({ height: window.innerHeight, top: 0 }) as DOMRect
  );
  act(() => drawer.querySelector('textarea')!.focus());
  return drawer;
}

function resize(layoutHeight: number, visualHeight: number, eventTarget: EventTarget = viewport) {
  act(() => {
    vi.stubGlobal('innerHeight', layoutHeight);
    viewport.height = visualHeight;
    eventTarget.dispatchEvent(new Event('resize'));
  });
}

describe('native side-drawer keyboard layout', () => {
  it('restores CSS sizing after a resizing keyboard hides with the input still focused', () => {
    const drawer = renderDrawer();
    resize(480, 480);
    resize(800, 800);
    expect(document.activeElement).toBe(drawer.querySelector('textarea'));
    expect(drawer.style.height).toBe('');
    expect(drawer.style.bottom).toBe('0px');
  });

  it('tracks overlay keyboard height through intermediate changes and repeated open/hide cycles', () => {
    const drawer = renderDrawer();
    for (const height of [480, 400, 460, 800, 500, 800]) {
      resize(800, height);
      expect(drawer.style.bottom).toBe(`${800 - height}px`);
      expect(drawer.style.height).toBe('');
    }
  });

  it('handles window-only resize notifications and switches between resize and overlay modes', () => {
    const drawer = renderDrawer();
    resize(800, 480);
    expect(drawer.style.bottom).toBe('320px');
    resize(480, 480, window);
    expect(drawer.style.bottom).toBe('0px');
    resize(800, 800, window);
    expect(drawer.style.height).toBe('');
    expect(drawer.style.bottom).toBe('0px');
  });

  it('measures an already-open keyboard on mount and accounts for viewport panning', () => {
    viewport.height = 450;
    viewport.offsetTop = 30;
    const drawer = renderDrawer();
    expect(drawer.style.bottom).toBe('320px');
    act(() => {
      viewport.offsetTop = 50;
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(drawer.style.bottom).toBe('300px');
    resize(800, 800);
    expect(drawer.style.bottom).toBe('0px');
  });

  it.each([0.999, 1.0000001])('tracks keyboard occlusion at near-unit scale %s', (scale) => {
    const drawer = renderDrawer();
    viewport.scale = scale;
    resize(800, 480);
    expect(drawer.style.bottom).toBe('320px');
    resize(800, 800);
    expect(drawer.style.bottom).toBe('0px');
    expect(drawer.style.height).toBe('');
  });

  it.each([0.98, 1.02, 2])(
    'does not treat pinch zoom at scale %s as keyboard occlusion',
    (scale) => {
      const drawer = renderDrawer();
      viewport.scale = scale;
      resize(800, 400);
      expect(drawer.style.bottom).toBe('0px');
    }
  );

  it('keeps CSS sizing when visualViewport is unavailable', () => {
    vi.stubGlobal('visualViewport', undefined);
    const drawer = renderDrawer();
    resize(480, 480, window);
    resize(800, 800, window);
    expect(drawer.style.height).toBe('');
    expect(drawer.style.bottom).toBe('0px');
  });

  it.each(['web', 'ios', 'disabled'] as const)('does not take over %s positioning', (mode) => {
    runtime.native = mode !== 'web';
    runtime.ios = mode === 'ios';
    const drawer = renderDrawer(mode !== 'disabled');
    expect(drawer.style.bottom).toBe('');
  });
});

function DrawerMenu({ initiallyOpen }: { initiallyOpen: boolean }) {
  const [selection, setSelection] = useState('Unchanged');
  return (
    <Drawer direction="right" open repositionInputs={false}>
      <DrawerContent aria-describedby={undefined}>
        <DrawerTitle>Simulator</DrawerTitle>
        <output>{selection}</output>
        <Menu.Root defaultOpen={initiallyOpen}>
          <Menu.Trigger>More controls</Menu.Trigger>
          <Menu.Content>
            <Menu.Item onClick={() => setSelection('Rotated')}>Rotate left</Menu.Item>
          </Menu.Content>
        </Menu.Root>
      </DrawerContent>
    </Drawer>
  );
}

describe('drawer floating controls', () => {
  it.each([false, true])(
    'keeps a menu interactive in the modal scope (initially open: %s)',
    async (initiallyOpen) => {
      await act(async () => {
        root.render(<DrawerMenu initiallyOpen={initiallyOpen} />);
      });
      if (!initiallyOpen) {
        await act(async () => {
          document
            .querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
            .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
          await vi.advanceTimersByTimeAsync(32);
        });
      }
      const drawer = document.querySelector<HTMLElement>('[data-slot="drawer-content"]')!;
      const item = document.querySelector<HTMLElement>('[role="menuitem"]')!;
      expect(drawer.contains(item)).toBe(true);
      expect(item.closest('[data-vaul-no-drag]')).not.toBeNull();
      // A body portal inherits the modal pointer lock, so its clicks hit the iframe below.
      expect(getComputedStyle(document.body).pointerEvents).toBe('none');
      expect(getComputedStyle(item).pointerEvents).not.toBe('none');
      await act(async () => {
        item.focus();
        await vi.advanceTimersByTimeAsync(32);
      });
      expect(document.activeElement).toBe(item);
      await act(async () => {
        item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(32);
      });
      expect(drawer.querySelector('output')?.textContent).toBe('Rotated');
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(drawer.getAttribute('data-state')).toBe('open');
    }
  );
});
