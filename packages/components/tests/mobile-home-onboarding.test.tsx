// @vitest-environment jsdom

// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { MobileHomeOnboarding } from '../src/components/mobile/mobile-home-screen';

describe('MobileHomeOnboarding first-run guide', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'clipboard');
    Reflect.deleteProperty(navigator, 'share');
  });

  function renderOnboarding(props: Parameters<typeof MobileHomeOnboarding>[0]) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(createElement(MobileHomeOnboarding, props));
    });
  }

  function click(element: Element) {
    flushSync(() => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  async function settleMicrotasks() {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }

  function findButton(text: string) {
    return Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes(text)
    );
  }

  it('guides through the command path, the desktop path, and the follow-up steps', () => {
    renderOnboarding({ labels: {} });

    const text = container?.textContent ?? '';
    // The one-command path is the headline: a copyable `lody daemon start`.
    expect(text).toContain('npx lody daemon start');
    // The "what happens next" preview keeps the three follow-up steps.
    expect(container?.querySelectorAll('ol li')).toHaveLength(3);
    // The phone never links out to the download page — the desktop path
    // only ever copies or shares the link for the computer.
    expect(container?.querySelector('a[href]')).toBeNull();
  });

  it('copies the install command to the clipboard from the command pill', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    renderOnboarding({ labels: {} });
    const button = container?.querySelector<HTMLButtonElement>('button[data-copied]');
    expect(button).not.toBeNull();

    click(button!);
    await settleMicrotasks();

    expect(writeText).toHaveBeenCalledWith('npx lody daemon start');
    // The icon swaps Copy → Check; there is no "Copied" text label.
    const copied = container?.querySelector('button[data-copied="true"]');
    expect(copied).not.toBeNull();
    expect(copied?.querySelector('svg.lucide-check')).not.toBeNull();
  });
});
