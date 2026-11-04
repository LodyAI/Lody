// @vitest-environment jsdom

// @vitest-environment jsdom
import { act, useState } from 'react';

import { Menu } from '@lody/ui/menu';

import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Drawer, DrawerContent, DrawerTitle } from '../src/ui/drawer';
import { SessionMobileDiffDrawer } from '../src/components/sessions/session-mobile-diff-drawer';

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
  delete window.__LODY_HORIZONTAL_DIVISION__;
  document.documentElement.style.removeProperty('--native-keyboard-height');
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
    'keeps the mobile diff in the session modal scope (initially open: %s)',
    async (initiallyOpen) => {
      function SessionDiff() {
        const [open, setOpen] = useState(initiallyOpen);
        const [selection, setSelection] = useState('Unchanged');
        return (
          <Drawer direction="right" open repositionInputs={false}>
            <DrawerContent aria-describedby={undefined}>
              <DrawerTitle>Conversation</DrawerTitle>
              <button onClick={() => setOpen(true)}>Open changes</button>
              <output>{selection}</output>
              <SessionMobileDiffDrawer
                open={open}
                onOpenChange={setOpen}
                changes={{
                  ready: true,
                  synced: true,
                  changeEntries: [],
                  changeFilePaths: [],
                  onOpenChangesDiff: () => {},
                }}
              >
                <button onClick={() => setSelection('Selected line')}>Select line</button>
              </SessionMobileDiffDrawer>
            </DrawerContent>
          </Drawer>
        );
      }
      await act(async () => root.render(<SessionDiff />));
      const drawer = document.querySelector<HTMLElement>('[data-slot="drawer-content"]')!;
      if (!initiallyOpen) {
        await act(async () => drawer.querySelector<HTMLButtonElement>('button')!.click());
      }
      const diff = drawer.querySelector<HTMLElement>('[data-side="bottom"]');
      expect(diff).not.toBeNull();
      expect(diff!.closest('[data-vaul-no-drag]')).not.toBeNull();
      expect(getComputedStyle(document.body).pointerEvents).toBe('none');
      expect(getComputedStyle(diff!).pointerEvents).not.toBe('none');
      const select = diff!.querySelector<HTMLButtonElement>('button:not([aria-label])')!;
      await act(async () => {
        select.focus();
        await vi.advanceTimersByTimeAsync(32);
      });
      expect(document.activeElement).toBe(select);
      await act(async () => select.click());
      expect(drawer.querySelector('output')?.textContent).toBe('Selected line');
      await act(async () =>
        diff!.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click()
      );
      expect(drawer.querySelector('[data-side="bottom"]')).toBeNull();
      expect(drawer.getAttribute('data-state')).toBe('open');
    }
  );
});
