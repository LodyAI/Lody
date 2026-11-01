// @vitest-environment jsdom

import { act, useState } from 'react';
import { Dialog, AlertDialog } from '../src/ui/dialog';
import { Menu } from '@lody/ui/menu';
import { Drawer as UiDrawer } from '@lody/ui/drawer';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Drawer, DrawerContent, DrawerTitle } from '../src/ui/drawer';
import { SessionMobileDiffDrawer } from '../src/components/sessions/session-mobile-diff-drawer';
import { MobileSessionMenuSheet } from '../src/components/mobile/mobile-session-menu-sheet';
import { MobileFilterDrawer } from '../src/components/mobile/mobile-filter-drawer';
import { MobileDeleteWorkspaceSheet } from '../src/components/mobile/mobile-delete-workspace-sheet';
import { MobileNewChatSheet } from '../src/components/mobile/mobile-new-chat-sheet';
import { MobileWorkspaceSwitcherSheet } from '../src/components/mobile/mobile-workspace-switcher-sheet';
import { MobileSessionTabSheet } from '../src/components/mobile/mobile-session-tab-sheet';

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

  it('keeps iOS side drawers sized by CSS through keyboard-open folding and dismissal', () => {
    runtime.ios = true;
    const drawer = renderDrawer();
    const input = drawer.querySelector('textarea')!;
    input.value = 'Unsent resize draft';
    for (const [layoutHeight, visualHeight] of [
      [800, 480],
      [1200, 880],
      [678, 378],
      [678, 678],
    ]) {
      resize(layoutHeight, visualHeight);
      expect(drawer.style.height).toBe('');
      expect(drawer.style.bottom).toBe('');
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe('Unsent resize draft');
    }
  });

  it('does not take over explicitly disabled positioning', () => {
    const drawer = renderDrawer(false);
    resize(800, 480);
    expect(drawer.style.bottom).toBe('');
  });
});

describe('fold-aware confirmation dialogs', () => {
  it('places a root confirmation on the lower panel and restores its regular position', () => {
    window.__LODY_HORIZONTAL_DIVISION__ = { top: 455.5, height: 40, viewportHeight: 951 };
    act(() =>
      root.render(
        <AlertDialog.Root open>
          <AlertDialog.Content>
            <AlertDialog.Title>Confirm action</AlertDialog.Title>
            <AlertDialog.Description>Review this action first.</AlertDialog.Description>
          </AlertDialog.Content>
        </AlertDialog.Root>
      )
    );
    const dialog = document.querySelector<HTMLElement>('[data-lody-dialog-content]')!;
    expect(dialog.style.insetBlockStart).toBe('723.25px');
    expect(dialog.style.maxHeight).toBe('423.5px');
    expect(dialog.textContent).toContain('Review this action first.');
    act(() => {
      document.documentElement.style.setProperty('--native-keyboard-height', '300px');
      window.dispatchEvent(new CustomEvent('lody:keyboard-resize', { detail: { height: 300 } }));
    });
    expect(dialog.style.insetBlockStart).toBe('');
    act(() => {
      document.documentElement.style.setProperty('--native-keyboard-height', '0px');
      window.__LODY_HORIZONTAL_DIVISION__ = null;
      window.dispatchEvent(new Event('lody:division-change'));
      window.dispatchEvent(new CustomEvent('lody:keyboard-resize', { detail: { height: 0 } }));
    });
    expect(dialog.style.insetBlockStart).toBe('');
    expect(dialog.style.maxHeight).toBe('');
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
  it.each([
    ['dialog', false],
    ['dialog', true],
    ['alert', false],
    ['alert', true],
    ['drawer', false],
    ['drawer', true],
  ] as const)(
    'keeps %s in the outer modal scope (initially open: %s)',
    async (kind, initiallyOpen) => {
      const Modal = kind === 'alert' ? AlertDialog : kind === 'drawer' ? UiDrawer : Dialog;
      function NestedModal() {
        const [open, setOpen] = useState(initiallyOpen);
        const [value, setValue] = useState('');
        return (
          <Drawer direction="right" open repositionInputs={false}>
            <DrawerContent aria-describedby={undefined}>
              <DrawerTitle>Conversation</DrawerTitle>
              <button onClick={() => setOpen(true)}>Open preview</button>
              <Modal.Root open={open} onOpenChange={setOpen}>
                <Modal.Content aria-describedby={undefined}>
                  <Modal.Title>Preview</Modal.Title>
                  <input
                    aria-label="Preview field"
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                  />
                  <Modal.Close>Done</Modal.Close>
                </Modal.Content>
              </Modal.Root>
            </DrawerContent>
          </Drawer>
        );
      }
      await act(async () => root.render(<NestedModal />));
      const outer = document.querySelector<HTMLElement>('[data-slot="drawer-content"]')!;
      if (!initiallyOpen) await act(async () => outer.querySelector('button')!.click());
      const field = document.querySelector<HTMLInputElement>('[aria-label="Preview field"]')!;
      expect(outer.contains(field)).toBe(true);
      expect(field.closest('[data-vaul-no-drag]')).not.toBeNull();
      expect(getComputedStyle(document.body).pointerEvents).toBe('none');
      expect(getComputedStyle(field).pointerEvents).not.toBe('none');
      await act(async () => {
        field.focus();
        await vi.advanceTimersByTimeAsync(32);
      });
      expect(document.activeElement).toBe(field);
      const done = Array.from(outer.querySelectorAll('button')).find(
        (button) => button.textContent === 'Done'
      )!;
      await act(async () => done.click());
      expect(document.querySelector('[aria-label="Preview field"]')).toBeNull();
      expect(outer.getAttribute('data-state')).toBe('open');
    }
  );

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

describe('session menu on a horizontal fold', () => {
  it('keeps all actions in a scrollable lower panel and restores full height when opened', () => {
    window.__LODY_HORIZONTAL_DIVISION__ = { top: 455.5, height: 40, viewportHeight: 951 };
    act(() => {
      root.render(
        <MobileSessionMenuSheet
          open
          onOpenChange={() => {}}
          title="Session menu"
          infoRows={[]}
          actions={[
            { id: 'first', label: 'First action', icon: null, onClick: () => {} },
            { id: 'last', label: 'Last action', icon: null, onClick: () => {} },
          ]}
        />
      );
    });
    const drawer = document.querySelector<HTMLElement>('[data-slot="drawer-content"]')!;
    expect(drawer.style.maxHeight).toBe('455.5px');
    expect(drawer.textContent).toContain('First action');
    expect(drawer.textContent).toContain('Last action');
    expect(drawer.querySelector('.overflow-y-auto')).not.toBeNull();
    act(() => {
      window.__LODY_HORIZONTAL_DIVISION__ = null;
      window.dispatchEvent(new Event('lody:division-change'));
    });
    expect(drawer.style.maxHeight).toBe('85dvh');
  });
  it('fits workspace switching on the lower panel and restores its regular height when unfolded', () => {
    window.__LODY_HORIZONTAL_DIVISION__ = { top: 455.5, height: 40, viewportHeight: 951 };
    act(() => {
      root.render(
        <MobileWorkspaceSwitcherSheet
          open
          onOpenChange={() => {}}
          onSelect={() => {}}
          workspaces={[
            { id: 'a', name: 'Alpha', isActive: true },
            { id: 'b', name: 'Beta' },
          ]}
        />
      );
    });
    const drawer = document.querySelector<HTMLElement>('[data-slot="drawer-content"]')!;
    expect(drawer.style.maxHeight).toBe('455.5px');
    expect(drawer.textContent).toContain('Alpha');
    expect(drawer.textContent).toContain('Beta');
    expect(drawer.querySelector('.overflow-y-auto')).not.toBeNull();
    act(() => {
      window.__LODY_HORIZONTAL_DIVISION__ = null;
      window.dispatchEvent(new Event('lody:division-change'));
    });
    expect(drawer.style.maxHeight).toBe('80dvh');
  });
  it('moves the new-chat composer below the fold without losing its draft', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ top: 0, bottom: 951, left: 0, right: 669, width: 669, height: 951 }) as DOMRect
    );
    window.__LODY_HORIZONTAL_DIVISION__ = { top: 455.5, height: 40, viewportHeight: 951 };
    act(() =>
      root.render(
        <MobileNewChatSheet
          open
          onOpenChange={() => {}}
          targetNode={<span>Machine</span>}
          composer={<textarea aria-label="Draft" defaultValue="Unsent draft" />}
        />
      )
    );
    const lower = document.querySelector<HTMLElement>('[data-new-chat-fold-lower]')!;
    const draft = lower.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(lower.style.top).toBe('495.5px');
    act(() => {
      document.documentElement.style.setProperty('--native-keyboard-height', '300px');
      window.dispatchEvent(new CustomEvent('lody:keyboard-resize', { detail: { height: 300 } }));
    });
    expect(lower.style.display).toBe('contents');
    expect(lower.querySelector('textarea')).toBe(draft);
    expect(draft.value).toBe('Unsent draft');
    act(() => {
      document.documentElement.style.setProperty('--native-keyboard-height', '0px');
      window.dispatchEvent(new CustomEvent('lody:keyboard-resize', { detail: { height: 0 } }));
    });
    expect(lower.style.top).toBe('495.5px');
    expect(draft.value).toBe('Unsent draft');
  });
  it('keeps the workspace confirmation draft while the keyboard takes over', () => {
    const confirm = vi.fn(async () => {});
    window.__LODY_HORIZONTAL_DIVISION__ = { top: 455.5, height: 40, viewportHeight: 951 };
    act(() =>
      root.render(
        <MobileDeleteWorkspaceSheet
          open
          onOpenChange={() => {}}
          workspaceName="Example"
          onConfirm={confirm}
        />
      )
    );
    const drawer = document.querySelector<HTMLElement>('[data-slot="drawer-content"]')!;
    const input = drawer.querySelector<HTMLInputElement>('input')!;
    expect(drawer.style.maxHeight).toContain('min(455.5px,');
    act(() => {
      document.documentElement.style.setProperty('--native-keyboard-height', '300px');
      window.dispatchEvent(new CustomEvent('lody:keyboard-resize', { detail: { height: 300 } }));
    });
    expect(drawer.style.maxHeight).toContain('min(92dvh,');
    expect(drawer.querySelector('input')).toBe(input);
    expect(confirm).not.toHaveBeenCalled();
  });
  it('keeps the browser filter search above an overlay keyboard', () => {
    runtime.native = false;
    act(() =>
      root.render(
        <MobileFilterDrawer
          open
          onOpenChange={() => {}}
          pills={[
            {
              kind: 'multi',
              id: 'projects',
              label: 'Projects',
              options: Array.from({ length: 9 }, (_, index) => ({
                id: `${index}`,
                label: `Project ${index}`,
              })),
              selectedIds: new Set(),
              defaultIds: new Set(),
              onChange: () => {},
            },
          ]}
        />
      )
    );
    const drawer = document.querySelector<HTMLElement>('[data-slot="drawer-content"]')!;
    const button = [...drawer.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
      node.textContent?.includes('Projects')
    )!;
    act(() => button.click());
    const input = drawer.querySelector<HTMLInputElement>('input')!;
    vi.spyOn(drawer, 'getBoundingClientRect').mockReturnValue({ height: 704, top: 96 } as DOMRect);
    act(() => input.focus());
    resize(800, 480);
    expect(drawer.style.bottom).toBe('320px');
    expect(document.activeElement).toBe(input);
  });

  it('preserves filter search while switching from the fold to the keyboard layout', () => {
    const update = vi.fn();
    const options = Array.from({ length: 9 }, (_, index) => ({
      id: `${index}`,
      label: `Project ${index}`,
    }));
    window.__LODY_HORIZONTAL_DIVISION__ = { top: 455.5, height: 40, viewportHeight: 951 };
    act(() =>
      root.render(
        <MobileFilterDrawer
          open
          onOpenChange={() => {}}
          pills={[
            {
              kind: 'multi',
              id: 'projects',
              label: 'Projects',
              options,
              selectedIds: new Set(),
              defaultIds: new Set(),
              onChange: update,
            },
          ]}
        />
      )
    );
    const drawer = document.querySelector<HTMLElement>('[data-slot="drawer-content"]')!;
    expect(drawer.style.maxHeight).toContain('min(455.5px,');
    const button = [...drawer.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
      node.textContent?.includes('Projects')
    )!;
    act(() => button.click());
    const input = drawer.querySelector<HTMLInputElement>('input')!;
    expect(input).toBeTruthy();
    act(() => {
      document.documentElement.style.setProperty('--native-keyboard-height', '300px');
      window.dispatchEvent(new CustomEvent('lody:keyboard-resize', { detail: { height: 300 } }));
    });
    expect(drawer.style.maxHeight).toContain('min(88dvh,');
    expect(drawer.querySelector('input')).toBe(input);
    expect(update).not.toHaveBeenCalled();
  });
  it('keeps the conversation tabs sheet below the fold', () => {
    window.__LODY_HORIZONTAL_DIVISION__ = { top: 455.5, height: 40, viewportHeight: 951 };
    act(() => {
      root.render(
        <MobileSessionTabSheet
          open
          onOpenChange={() => {}}
          conversations={[]}
          viewers={[]}
          onSelectConversation={() => {}}
          onSelectViewer={() => {}}
        />
      );
    });
    const drawer = document.querySelector<HTMLElement>('[data-slot="drawer-content"]')!;
    expect(drawer.style.maxHeight).toBe('455.5px');
    expect(drawer.querySelector('.overflow-y-auto')).not.toBeNull();
  });
});
