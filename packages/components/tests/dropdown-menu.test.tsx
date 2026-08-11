// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../src/ui/dropdown-menu';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;

  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

describe('DropdownMenu', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'PointerEvent', {
      configurable: true,
      value: TestPointerEvent,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    document.body.innerHTML = '';
    root = undefined;
    container = undefined;
  });

  it('opens on mouse down and keeps only the latest hovered submenu open', async () => {
    await act(async () => {
      root?.render(
        <DropdownMenu>
          <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
          <DropdownMenuContent data-testid="root-menu">
            <DropdownMenuItem>Root item</DropdownMenuItem>
            <DropdownMenuCheckboxItem checked>Checked item</DropdownMenuCheckboxItem>
            <DropdownMenuRadioGroup value="radio">
              <DropdownMenuRadioItem value="radio">Radio item</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>First submenu</DropdownMenuSubTrigger>
              <DropdownMenuSubContent data-testid="first-submenu">
                <DropdownMenuItem>First nested item</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Second submenu</DropdownMenuSubTrigger>
              <DropdownMenuSubContent data-testid="second-submenu">
                <DropdownMenuItem>Second nested item</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    });

    const trigger = getButton('Open menu');
    await act(async () => {
      trigger.dispatchEvent(
        new TestPointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        })
      );
    });

    expect(document.body.textContent).toContain('Root item');
    expect(document.body.textContent).not.toContain('First nested item');
    expect(document.body.textContent).not.toContain('Second nested item');
    const rootMenu = document.querySelector('[data-testid="root-menu"]');
    expect(rootMenu?.className).not.toMatch(/transition|animate-|fade-|zoom-|slide-/);

    const rootMenuItems = rootMenu?.querySelectorAll(
      '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'
    );
    expect(rootMenuItems).toHaveLength(5);
    for (const menuItem of rootMenuItems ?? []) {
      expect(menuItem.className).not.toMatch(/transition/);
    }

    const firstSubTrigger = getMenuItem('First submenu');
    await act(async () => {
      firstSubTrigger.dispatchEvent(
        new TestPointerEvent('pointerover', {
          bubbles: true,
          pointerType: 'touch',
        })
      );
    });
    expect(document.body.textContent).not.toContain('First nested item');

    await act(async () => {
      firstSubTrigger.dispatchEvent(
        new TestPointerEvent('pointerover', {
          bubbles: true,
          pointerType: 'mouse',
        })
      );
    });

    expect(document.body.textContent).toContain('First nested item');
    expect(document.body.textContent).not.toContain('Second nested item');

    const secondSubTrigger = getMenuItem('Second submenu');
    await act(async () => {
      secondSubTrigger.dispatchEvent(
        new TestPointerEvent('pointerover', {
          bubbles: true,
          pointerType: 'mouse',
        })
      );
    });

    expect(document.body.textContent).not.toContain('First nested item');
    expect(document.body.textContent).toContain('Second nested item');
    const submenu = document.querySelector('[data-testid="second-submenu"]');
    expect(submenu?.className).not.toMatch(/transition|animate-|fade-|zoom-|slide-/);
    for (const menuItem of submenu?.querySelectorAll('[role="menuitem"]') ?? []) {
      expect(menuItem.className).not.toMatch(/transition/);
    }
  });

  it('preserves keyboard submenu navigation and focus', async () => {
    await act(async () => {
      root?.render(
        <DropdownMenu>
          <DropdownMenuTrigger>Open keyboard menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Keyboard submenu</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>Keyboard nested item</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    });

    const trigger = getButton('Open keyboard menu');
    await act(async () => {
      trigger.dispatchEvent(
        new TestPointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        })
      );
    });

    const subTrigger = getMenuItem('Keyboard submenu');
    await act(async () => {
      subTrigger.focus();
      subTrigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    const nestedItem = getMenuItem('Keyboard nested item');
    expect(document.activeElement).toBe(nestedItem);

    await act(async () => {
      nestedItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });

    expect(document.body.textContent).not.toContain('Keyboard nested item');
    expect(document.activeElement).toBe(subTrigger);
  });

  it('does not return focus to the trigger after selecting an item', async () => {
    await act(async () => {
      root?.render(
        <DropdownMenu>
          <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Choose model</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    });

    const trigger = getButton('Open menu');
    await act(async () => {
      trigger.dispatchEvent(
        new TestPointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        })
      );
    });

    const item = getMenuItem('Choose model');
    await act(async () => {
      item.focus();
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(document.body.textContent).not.toContain('Choose model');
    expect(document.activeElement).not.toBe(trigger);

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });
    expect(document.body.textContent).not.toContain('Choose model');
  });

  it('restores composer focus after selecting, including keep-open then dismiss', async () => {
    await act(async () => {
      root?.render(
        <div>
          <textarea data-keyboard-nav="composer" defaultValue="hello" />
          <DropdownMenu>
            <DropdownMenuTrigger>Run config</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                onSelect={(event) => {
                  // Keep-open multi-pick (model/agent rows)
                  event.preventDefault();
                }}
              >
                Pick model
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger>Permission</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>Agent mode</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      );
    });

    const textarea = document.querySelector('textarea')!;
    const runConfig = getButton('Run config');
    const permission = getButton('Permission');

    // Keep-open select on run config, then Esc-dismiss → composer, not trigger.
    await act(async () => {
      runConfig.dispatchEvent(
        new TestPointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        })
      );
    });
    const modelItem = getMenuItem('Pick model');
    await act(async () => {
      modelItem.focus();
      modelItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(document.body.textContent).toContain('Pick model');

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    // Radix FocusScope fires onCloseAutoFocus from effect cleanup; allow it to settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(textarea);
    expect(document.activeElement).not.toBe(runConfig);

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });
    expect(document.body.textContent).not.toContain('Pick model');

    // Permission mode close-on-select also returns focus to the composer.
    await act(async () => {
      permission.dispatchEvent(
        new TestPointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        })
      );
    });
    const modeItem = getMenuItem('Agent mode');
    await act(async () => {
      modeItem.focus();
      modeItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).not.toContain('Agent mode');
    expect(document.activeElement).toBe(textarea);
    expect(document.activeElement).not.toBe(runConfig);
    expect(document.activeElement).not.toBe(permission);
  });

  it('touch tap opens the menu without leaking the synthetic pointerdown to ancestors', async () => {
    // Simulates a vaul Drawer.Content ancestor: it grabs the pointer in
    // onPointerDown via setPointerCapture, which throws NotFoundError for a
    // synthetic event (no active pointer). The trigger's touch re-dispatch
    // must toggle Radix on the trigger element but never reach ancestors.
    const ancestorPointerDowns: string[] = [];
    await act(async () => {
      root?.render(
        <div
          onPointerDown={(event) => {
            ancestorPointerDowns.push(event.pointerType);
          }}
        >
          <DropdownMenu>
            <DropdownMenuTrigger>Touch menu</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>Touch item</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      );
    });

    const trigger = getButton('Touch menu');
    await act(async () => {
      trigger.dispatchEvent(
        new TestPointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerType: 'touch',
        })
      );
    });
    // The real touch pointerdown is blocked for Radix (no menu yet) but
    // still bubbles to ancestors as a genuine pointer event.
    expect(document.body.textContent).not.toContain('Touch item');
    expect(ancestorPointerDowns).toEqual(['touch']);

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    // The synthetic re-dispatch toggles the menu on the trigger itself...
    expect(document.body.textContent).toContain('Touch item');
    // ...but never bubbles to ancestor pointer handlers (vaul's onPress).
    expect(ancestorPointerDowns).toEqual(['touch']);
  });

  function getButton(name: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll('button')).find((node) =>
      node.textContent?.includes(name)
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Could not find button: ${name}`);
    }
    return button;
  }

  function getMenuItem(name: string): HTMLElement {
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((node) =>
      node.textContent?.includes(name)
    );
    if (!(item instanceof HTMLElement)) {
      throw new Error(`Could not find menu item: ${name}`);
    }
    return item;
  }
});
