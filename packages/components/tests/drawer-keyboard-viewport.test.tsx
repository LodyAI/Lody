// @vitest-environment jsdom

// @vitest-environment jsdom
import { act, useState } from 'react';

import { Menu } from '@lody/ui/menu';

import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerDescription,
  type DrawerContentProps,
} from '../src/ui/drawer';
import { SessionMobileDiffDrawer } from '../src/components/sessions/session-mobile-diff-drawer';

const runtime = vi.hoisted(() => ({ native: true, ios: false }));
vi.mock('../src/lib/native-platform', () => ({
  isNativeAppShell: () => runtime.native,
  isNativeIOSAppShell: () => runtime.native && runtime.ios,
}));
vi.mock('../src/lib/utils', async () => {
  const { clsx } = await import('clsx');
  return { cn: clsx };
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

function renderDrawer(
  repositionInputs = true,
  bottomPadding?: DrawerContentProps['bottomPadding']
) {
  act(() => {
    root.render(
      <Drawer direction="right" open modal={false} repositionInputs={repositionInputs}>
        <DrawerContent aria-describedby={undefined} bottomPadding={bottomPadding}>
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

describe('legacy drawer description size', () => {
  it('applies an explicit physical size while retaining caller style priority and accessible description', async () => {
    await act(async () =>
      root.render(
        <Drawer open repositionInputs={false}>
          <DrawerContent>
            <DrawerTitle>Size control</DrawerTitle>
            <DrawerDescription fontSize="0.78rem" style={{ fontSize: '19px', lineHeight: '1.75' }}>
              Details
            </DrawerDescription>
          </DrawerContent>
        </Drawer>
      )
    );
    const description = document.querySelector<HTMLElement>('[data-slot="drawer-description"]')!;
    expect(description.style.fontSize).toBe('19px');
    expect(description.style.lineHeight).toBe('1.75');
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-describedby')).toBe(
      description.id
    );
  });

  it('keeps slotted child style and ref, then clears an omitted explicit size on update', async () => {
    const ref = { current: null as HTMLParagraphElement | null };
    const render = (fontSize?: React.CSSProperties['fontSize']) => (
      <Drawer open repositionInputs={false}>
        <DrawerContent>
          <DrawerTitle>Size control</DrawerTitle>
          <DrawerDescription ref={ref} asChild fontSize={fontSize}>
            <p style={{ fontSize: '21px' }}>Child details</p>
          </DrawerDescription>
          <DrawerDescription data-size-update="" fontSize={fontSize}>
            Updated details
          </DrawerDescription>
        </DrawerContent>
      </Drawer>
    );
    await act(async () => root.render(render(0)));
    expect(ref.current?.style.fontSize).toBe('21px');
    const updated = document.querySelector<HTMLElement>('[data-size-update]')!;
    expect(updated.style.fontSize).toBe('0px');
    await act(async () => root.render(render()));
    expect(ref.current?.style.fontSize).toBe('21px');
    expect(updated.style.fontSize).toBe('');
  });
});

describe('native side-drawer keyboard layout', () => {
  it('retains Vaul name nodes, refs, ids and inline styles when hidden names are shown', () => {
    const title = { current: null as HTMLHeadingElement | null };
    const description = { current: null as HTMLParagraphElement | null };
    const view = (visuallyHidden?: boolean) => (
      <Drawer direction="right" open modal={false}>
        <DrawerContent>
          <DrawerTitle
            ref={title}
            visuallyHidden={visuallyHidden}
            asChild
            className="retained-vaul-name"
            style={{ marginRight: 7 }}
          >
            <h3>Retained Vaul name</h3>
          </DrawerTitle>
          <DrawerDescription ref={description} visuallyHidden={visuallyHidden}>
            Retained Vaul description
          </DrawerDescription>
          <input aria-label="Retained drawer input" defaultValue="Original value" />
        </DrawerContent>
      </Drawer>
    );
    act(() => root.render(view(true)));
    const panel = document.querySelector('[role="dialog"]')!;
    const titleNode = title.current!;
    const descriptionNode = description.current!;
    const titleId = titleNode.id;
    const descriptionId = descriptionNode.id;
    const input = panel.querySelector('input')!;
    act(() => input.focus());
    input.value = 'Edited value';
    for (const hidden of [false, undefined, true]) {
      act(() => root.render(view(hidden)));
      expect(title.current).toBe(titleNode);
      expect(description.current).toBe(descriptionNode);
      expect(titleNode.tagName).toBe('H3');
      expect(titleNode.classList.contains('retained-vaul-name')).toBe(true);
      expect(titleNode.id).toBe(titleId);
      expect(descriptionNode.id).toBe(descriptionId);
      expect(panel.getAttribute('aria-labelledby')).toBe(titleId);
      expect(panel.getAttribute('aria-describedby')).toBe(descriptionId);
      expect(titleNode.textContent).toBe('Retained Vaul name');
      expect(descriptionNode.textContent).toBe('Retained Vaul description');
      expect(titleNode.hasAttribute('visuallyHidden')).toBe(false);
      expect(titleNode.hasAttribute('aria-hidden')).toBe(false);
      expect(descriptionNode.hasAttribute('aria-hidden')).toBe(false);
      expect(titleNode.style.marginRight).toBe('7px');
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe('Edited value');
    }
  });

  it.each([undefined, 'safeArea'] as const)(
    'restores CSS sizing after the keyboard hides with bottomPadding=%s and input still focused',
    (bottomPadding) => {
      const drawer = renderDrawer(true, bottomPadding);
      expect(drawer.hasAttribute('bottomPadding')).toBe(false);
      resize(480, 480);
      resize(800, 800);
      expect(document.activeElement).toBe(drawer.querySelector('textarea'));
      expect(drawer.style.height).toBe('');
      expect(drawer.style.bottom).toBe('0px');
    }
  );
});
