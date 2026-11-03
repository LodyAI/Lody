// @vitest-environment jsdom

// @vitest-environment jsdom
import { act } from 'react';
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
