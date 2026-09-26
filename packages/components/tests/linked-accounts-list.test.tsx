// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinkedAccountsSection } from '../src/components/settings/linked-accounts-list';
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

describe('LinkedAccountsSection', () => {
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

  it('lists every provider with its state and connects one after confirming', async () => {
    const onConnect = vi.fn();
    await act(async () => {
      root?.render(
        <LinkedAccountsSection
          accounts={[{ id: 'a', providerId: 'github', createdAt: '2025-01-15T12:00:00Z' }]}
          onConnect={onConnect}
        />
      );
    });

    const rows = Array.from(container?.querySelectorAll('section p') ?? []).map(
      (element) => element.textContent
    );
    expect(rows).toEqual([
      'Connected accounts',
      'GitHub',
      'Connected Jan 15, 2025',
      'Google',
      'Not connected',
      'Apple',
      'Not connected',
      'Discord',
      'Not connected',
    ]);
    // Only the providers that are not connected offer to connect.
    expect(Array.from(container?.querySelectorAll('button') ?? []).length).toBe(3);

    const googleRow = Array.from(container?.querySelectorAll('section div') ?? []).find(
      (element) => element.textContent === 'GoogleNot connectedConnect'
    );
    await press(googleRow!.querySelector('button')!);
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

  it('offers no Connect button without a connect action', async () => {
    await act(async () => {
      root?.render(<LinkedAccountsSection accounts={[]} />);
    });

    expect(container?.textContent).toContain('Not connected');
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
});
