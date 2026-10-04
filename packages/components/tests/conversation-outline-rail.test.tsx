// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationOutlineRail } from '../src/components/ai-gui/conversation-outline-rail';
import type { ConversationOutlineEntry } from '../src/lib/conversation-outline';

vi.mock('@posthog/react', () => ({ usePostHog: () => null }));
vi.mock('../src/lib/posthog-analytics', () => ({ capturePostHogSampled: () => {} }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

const entries = Array.from({ length: 1500 }, (_, index): ConversationOutlineEntry => ({
  key: `round-${index}`,
  messageId: `turn-${index}`,
  messageIndex: index * 2,
  title: `Round ${index}`,
  preview: `Answer ${index}`,
  startsWithAgent: false,
  weight: 1,
}));
let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function mount(activeIndex = -1) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const jumps: number[] = [];
  const render = (rows = entries, active = activeIndex) =>
    root.render(
      <ConversationOutlineRail
        entries={rows}
        activeIndex={active}
        onJumpToRound={(index) => jumps.push(index)}
      />
    );
  await act(async () => render());
  const list = host.querySelector('ol')!;
  const strip = list.parentElement!.parentElement!;
  Object.defineProperties(strip, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, get: () => Number.parseFloat(list.style.height) + 16 },
  });
  return { list, strip, render, jumps };
}
const tick = (index: number) =>
  host.querySelector<HTMLButtonElement>(`[data-outline-index="${index}"]`);

describe('windowed conversation outline', () => {
  it('bounds mounted ticks, preserves geometry, and jumps through an offscreen keyboard destination', async () => {
    const { list, strip, jumps } = await mount();
    expect(list.style.height).toBe('12000px');
    expect(host.querySelectorAll('[data-outline-index]').length).toBeLessThan(150);
    expect(tick(1499)).toBeNull();
    await act(async () => {
      tick(0)!.focus();
      tick(0)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(document.activeElement).toBe(tick(1499));
    expect(tick(1499)!.parentElement!.style.top).toBe('11992px');
    expect(tick(1499)!.parentElement!.getAttribute('aria-setsize')).toBe('1500');
    await act(async () =>
      tick(1499)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    );
    expect(jumps).toEqual([1499]);
    await act(async () => {
      strip.scrollTop = 6000;
      strip.dispatchEvent(new Event('scroll'));
    });
    expect(tick(750)).not.toBeNull();
    expect(tick(10)).toBeNull();
    expect(document.activeElement).toBe(tick(1499));
    expect(host.querySelectorAll('[data-outline-index]').length).toBeLessThan(85);
    await act(async () =>
      tick(1499)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    );
    expect(document.activeElement).toBe(tick(0));
  });

  it('retains a hovered preview anchor when its tick leaves the visible slice', async () => {
    const { strip } = await mount();
    vi.useFakeTimers();
    const anchor = tick(5)!;
    await act(async () => {
      const event = new MouseEvent('pointerover', { bubbles: true });
      Object.defineProperty(event, 'pointerType', { value: 'mouse' });
      anchor.dispatchEvent(event);
    });
    await act(async () => vi.advanceTimersByTime(200));
    expect(document.body.textContent).toContain('Answer 5');
    await act(async () => {
      strip.scrollTop = 6000;
      strip.dispatchEvent(new Event('scroll'));
    });
    expect(tick(5)).toBe(anchor);
    expect(tick(750)).not.toBeNull();
    expect(tick(10)).toBeNull();
    expect(document.body.textContent).toContain('Answer 5');
  });

  it('centres the active round, restores aria-current after remount, and keeps a tab stop after shrinking', async () => {
    const { strip, render } = await mount();
    await act(async () => render(entries, 1450));
    expect(strip.scrollTop).toBeGreaterThan(11000);
    expect(tick(1450)!.getAttribute('aria-current')).toBe('true');
    await act(async () => {
      strip.scrollTop = 0;
      strip.dispatchEvent(new Event('scroll'));
    });
    expect(tick(1450)).toBeNull();
    await act(async () => {
      strip.scrollTop = 11400;
      strip.dispatchEvent(new Event('scroll'));
    });
    expect(tick(1450)!.getAttribute('aria-current')).toBe('true');
    await act(async () => tick(1450)!.focus());
    await act(async () => render(entries.slice(0, 5), 4));
    expect(host.querySelector('[data-outline-index][tabindex="0"]')).not.toBeNull();
  });
});
