// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Menu } from '../src/ui/menu';

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

describe('Menu', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  // Base UI defers menu opens to the next animation frame; jsdom's rAF is a
  // real timer, so give it a beat.
  const flushFrame = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  };

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

  it('opens and keeps only the latest hovered submenu open', async () => {
    await act(async () => {
      root?.render(
        <Menu.Root>
          <Menu.Trigger>Open menu</Menu.Trigger>
          <Menu.Content data-testid="root-menu">
            <Menu.Item>Root item</Menu.Item>
            <Menu.CheckboxItem checked>Checked item</Menu.CheckboxItem>
            <Menu.RadioGroup value="radio">
              <Menu.RadioItem value="radio">Radio item</Menu.RadioItem>
            </Menu.RadioGroup>
            <Menu.Submenu>
              <Menu.SubmenuTrigger>First submenu</Menu.SubmenuTrigger>
              <Menu.Content data-testid="first-submenu">
                <Menu.Item>First nested item</Menu.Item>
              </Menu.Content>
            </Menu.Submenu>
            <Menu.Submenu>
              <Menu.SubmenuTrigger>Second submenu</Menu.SubmenuTrigger>
              <Menu.Content data-testid="second-submenu">
                <Menu.Item>Second nested item</Menu.Item>
              </Menu.Content>
            </Menu.Submenu>
          </Menu.Content>
        </Menu.Root>
      );
    });

    const trigger = getButton('Open menu');
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    await flushFrame();

    expect(document.body.textContent).toContain('Root item');
    expect(document.body.textContent).not.toContain('First nested item');
    expect(document.body.textContent).not.toContain('Second nested item');
    const rootMenu = document.querySelector('[data-testid="root-menu"]');
    const rootMenuItems = rootMenu?.querySelectorAll(
      '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'
    );
    expect(rootMenuItems).toHaveLength(5);

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
      firstSubTrigger.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true })
      );
    });
    await flushFrame();

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
      secondSubTrigger.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true })
      );
    });
    await flushFrame();

    expect(document.body.textContent).not.toContain('First nested item');
    expect(document.body.textContent).toContain('Second nested item');
  });

  it('preserves keyboard submenu navigation and focus', async () => {
    await act(async () => {
      root?.render(
        <Menu.Root>
          <Menu.Trigger>Open keyboard menu</Menu.Trigger>
          <Menu.Content>
            <Menu.Submenu>
              <Menu.SubmenuTrigger>Keyboard submenu</Menu.SubmenuTrigger>
              <Menu.Content>
                <Menu.Item>Keyboard nested item</Menu.Item>
              </Menu.Content>
            </Menu.Submenu>
          </Menu.Content>
        </Menu.Root>
      );
    });

    const trigger = getButton('Open keyboard menu');
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    await flushFrame();

    const subTrigger = getMenuItem('Keyboard submenu');
    await act(async () => {
      subTrigger.focus();
      subTrigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await flushFrame();

    const nestedItem = getMenuItem('Keyboard nested item');
    expect(document.activeElement).toBe(nestedItem);

    await act(async () => {
      nestedItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    await flushFrame();

    expect(document.body.textContent).not.toContain('Keyboard nested item');
    expect(document.activeElement).toBe(subTrigger);
  });

  it('does not return focus to the trigger after selecting an item', async () => {
    await act(async () => {
      root?.render(
        <Menu.Root>
          <Menu.Trigger>Open menu</Menu.Trigger>
          <Menu.Content>
            <Menu.Item>Choose model</Menu.Item>
          </Menu.Content>
        </Menu.Root>
      );
    });

    const trigger = getButton('Open menu');
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    await flushFrame();

    const item = getMenuItem('Choose model');
    await act(async () => {
      item.focus();
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushFrame();

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
          <Menu.Root>
            <Menu.Trigger>Run config</Menu.Trigger>
            <Menu.Content>
              {/* Keep-open multi-pick (model/agent rows). */}
              <Menu.Item closeOnClick={false}>Pick model</Menu.Item>
            </Menu.Content>
          </Menu.Root>
          <Menu.Root>
            <Menu.Trigger>Permission</Menu.Trigger>
            <Menu.Content>
              <Menu.Item>Agent mode</Menu.Item>
            </Menu.Content>
          </Menu.Root>
        </div>
      );
    });

    const textarea = document.querySelector('textarea')!;
    const runConfig = getButton('Run config');
    const permission = getButton('Permission');

    // Keep-open select on run config, then Esc-dismiss → composer, not trigger.
    await act(async () => {
      runConfig.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    await flushFrame();
    const modelItem = getMenuItem('Pick model');
    await act(async () => {
      modelItem.focus();
      modelItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushFrame();
    expect(document.body.textContent).toContain('Pick model');

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    await flushFrame();
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
      permission.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    await flushFrame();
    const modeItem = getMenuItem('Agent mode');
    await act(async () => {
      modeItem.focus();
      modeItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushFrame();
    expect(document.body.textContent).not.toContain('Agent mode');
    expect(document.activeElement).toBe(textarea);
    expect(document.activeElement).not.toBe(runConfig);
    expect(document.activeElement).not.toBe(permission);
  });

  it('opens on a touch tap without synthesizing extra pointer events to ancestors', async () => {
    const ancestorPointerDowns: string[] = [];
    await act(async () => {
      root?.render(
        <div
          onPointerDown={(event) => {
            ancestorPointerDowns.push(event.pointerType);
          }}
        >
          <Menu.Root>
            <Menu.Trigger>Touch menu</Menu.Trigger>
            <Menu.Content>
              <Menu.Item>Touch item</Menu.Item>
            </Menu.Content>
          </Menu.Root>
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
    expect(ancestorPointerDowns).toEqual(['touch']);

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flushFrame();

    expect(document.body.textContent).toContain('Touch item');
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
