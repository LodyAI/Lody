// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinkedAccountsList } from '../src/components/settings/linked-accounts-list';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom has no PointerEvent; Base UI reads `pointerType` to tell a mouse press apart. */
class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;

  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

describe('LinkedAccountsList', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('names connected accounts and offers only the rest for connecting', async () => {
    const onConnect = vi.fn();
    await act(async () => {
      root?.render(
        <LinkedAccountsList accounts={[{ id: 'a', providerId: 'github' }]} onConnect={onConnect} />
      );
    });

    expect(container?.textContent).toContain('GitHub');
    await press(getButton('Connect'));
    const offered = await vi.waitFor(() => {
      const labels = Array.from(document.body.querySelectorAll('[role="menuitem"]')).map(
        (item) => item.textContent
      );
      expect(labels.length).toBeGreaterThan(0);
      return labels;
    });
    expect(offered).toEqual(['Connect Google', 'Connect Apple', 'Connect Discord']);

    const google = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent === 'Connect Google');
    await act(async () => google?.click());
    const confirm = await vi.waitFor(() => {
      const button = Array.from(document.body.querySelectorAll('button')).find(
        (element) => element.textContent === 'Continue'
      );
      expect(button).toBeDefined();
      return button!;
    });
    await act(async () => confirm.click());

    expect(onConnect).toHaveBeenCalledWith('google');
  });

  it('says nothing is connected and offers no menu without a connect action', async () => {
    await act(async () => {
      root?.render(<LinkedAccountsList accounts={[]} />);
    });

    expect(container?.textContent).toBe('None yet');
    expect(container?.querySelector('button')).toBeNull();
  });

  /** The pointer pressing a control, in the order a browser delivers it. */
  async function press(element: HTMLElement) {
    await act(async () => {
      const init = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' };
      element.dispatchEvent(new TestPointerEvent('pointerdown', init));
      element.dispatchEvent(new MouseEvent('mousedown', init));
      element.focus();
      element.dispatchEvent(new TestPointerEvent('pointerup', init));
      element.dispatchEvent(new MouseEvent('mouseup', init));
      element.click();
    });
  }

  function getButton(name: string): HTMLButtonElement {
    const button = Array.from(container?.querySelectorAll('button') ?? []).find((element) =>
      element.textContent?.includes(name)
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Could not find button: ${name}`);
    return button;
  }
});
