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

  it('honors a caller-provided command override', () => {
    renderOnboarding({ labels: { command: 'npx lody daemon start --auth token' } });
    expect(container?.textContent).toContain('npx lody daemon start --auth token');
  });

  it('shares command + link for the command path and the bare link for the desktop path', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });

    renderOnboarding({
      labels: { shareCommandLabel: 'Send command', shareDownloadLabel: 'Send link' },
      downloadUrl: 'https://lody.ai/zh/download',
    });

    const commandShare = container?.querySelector('button[aria-label="Send command"]');
    const linkShare = container?.querySelector('button[aria-label="Send link"]');
    expect(commandShare).not.toBeNull();
    expect(linkShare).not.toBeNull();

    click(commandShare!);
    await settleMicrotasks();
    const commandPayload = share.mock.calls.at(-1)?.[0] as { text?: string };
    expect(commandPayload.text).toContain('npx lody daemon start');
    expect(commandPayload.text).toContain('https://lody.ai/zh/download');

    click(linkShare!);
    await settleMicrotasks();
    const linkPayload = share.mock.calls.at(-1)?.[0] as { url?: string };
    expect(linkPayload.url).toBe('https://lody.ai/zh/download');
  });

  it('shows the download URL as a typeable pill that copies on tap — no share API needed', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    renderOnboarding({
      labels: {},
      downloadUrl: 'https://lody.ai/zh/download',
    });

    // The pill displays the scheme-stripped URL (short enough to type on the
    // computer) but copies the full clickable URL.
    const pill = findButton('lody.ai/zh/download');
    expect(pill).not.toBeNull();
    click(pill!);
    await settleMicrotasks();

    expect(writeText).toHaveBeenCalledWith('https://lody.ai/zh/download');
    expect(pill!.dataset.copied).toBe('true');
    expect(pill!.querySelector('svg.lucide-check')).not.toBeNull();
  });
});
