// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodexResetForecastDialog } from '../src/components/codex-reset/codex-reset-forecast-dialog';
import {
  formatCodexResetExpiry,
  type CodexResetStatus,
  type CodexResetWatch,
} from '../src/lib/codex-reset-forecast';
import type { CodexResetForecastState } from '../src/lib/codex-reset-forecast-store';
import { initI18n } from '../src/i18n';

const NOW_MS = Date.parse('2026-08-20T06:00:00.000Z');

const watch = (overrides: Partial<CodexResetWatch> = {}): CodexResetWatch => ({
  level: 'strong',
  chancePercent: 65,
  // Free text straight off the wire, lead-in and all.
  windowText: 'the next 6 hours',
  observedAtIso: '2026-08-20T05:00:00.000Z',
  observedAtMs: Date.parse('2026-08-20T05:00:00.000Z'),
  expiresAtIso: '2026-08-20T11:00:00.000Z',
  expiresAtMs: Date.parse('2026-08-20T11:00:00.000Z'),
  text: 'Crossed 15M, reset landing soon.',
  source: { author: 'thsottiaux', url: 'https://x.com/thsottiaux/status/1' },
  ...overrides,
});

const readyState = (data: CodexResetStatus): CodexResetForecastState => ({
  status: 'ready',
  data,
  error: null,
});

describe('CodexResetForecastDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const render = async (
    props: Partial<React.ComponentProps<typeof CodexResetForecastDialog>> = {}
  ) => {
    await act(async () => {
      root.render(
        <CodexResetForecastDialog
          open
          onOpenChange={vi.fn()}
          state={{ status: 'idle', data: null, error: null }}
          watch={null}
          isExpired={false}
          nowMs={NOW_MS}
          onRetry={vi.fn()}
          {...props}
        />
      );
    });
  };

  // The dialog is rendered into a portal, so assertions read the document.
  const text = () => document.body.textContent ?? '';
  const panel = () => document.querySelector('[data-lody-dialog-content]');

  it('labels itself and keeps one concise third-party attribution at the bottom', async () => {
    await render({ state: readyState({ watch: watch(), latestReset: null }), watch: watch() });

    const dialog = panel();
    expect(dialog).not.toBeNull();
    // Radix wires aria-labelledby/aria-describedby from DialogTitle/Description.
    const labelledBy = dialog?.getAttribute('aria-labelledby');
    const describedBy = dialog?.getAttribute('aria-describedby');
    expect(document.getElementById(labelledBy ?? '')?.textContent).toBe('Codex reset forecast');
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe(
      'Third-party forecast from codex-resets.com. For reference only.'
    );
    expect(text().match(/codex-resets\.com/g)).toHaveLength(1);
    const attributionLink = Array.from(dialog?.querySelectorAll('a') ?? []).find(
      (node) => node.textContent?.includes('codex-resets.com')
    );
    expect(attributionLink?.getAttribute('href')).toBe(
      'https://codex-resets.com/?utm_source=lody'
    );
    expect(attributionLink?.getAttribute('target')).toBe('_blank');
    expect(attributionLink?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders the probability, window, level, and both timestamps', async () => {
    const active = watch();
    await render({ state: readyState({ watch: active, latestReset: null }), watch: active });

    expect(text()).toContain('65% chance of a reset');
    expect(text()).toContain('Strong signal');
    // The API expiry is shown semantically in the user's local time zone.
    expect(text()).toContain('Forecast valid until');
    expect(text()).toContain(formatCodexResetExpiry(active.expiresAtMs, NOW_MS, 'en'));
    expect(text()).not.toContain('the next 6 hours');
    expect(text()).not.toContain('chance of a reset within');

    const times = Array.from(document.querySelectorAll('time')).map((node) => ({
      dateTime: node.getAttribute('datetime'),
      text: node.textContent,
    }));
    expect(times).toEqual([
      {
        dateTime: '2026-08-20T11:00:00.000Z',
        text: formatCodexResetExpiry(active.expiresAtMs, NOW_MS, 'en'),
      },
      { dateTime: '2026-08-20T05:00:00.000Z', text: 'about 1 hour ago' },
      { dateTime: '2026-08-20T11:00:00.000Z', text: 'in about 5 hours' },
    ]);
  });

  it('renders the semantic expiry in Chinese instead of the API free text', async () => {
    await initI18n('zh_CN');
    const active = watch();
    await render({ state: readyState({ watch: active, latestReset: null }), watch: active });

    expect(text()).toContain('预测有效至');
    expect(text()).toContain(formatCodexResetExpiry(active.expiresAtMs, NOW_MS, 'zh_CN'));
    expect(text()).not.toContain('the next 6 hours');
  });

  it('drops the probability sentence when the forecast has no percentage', async () => {
    const active = watch({ chancePercent: null, level: 'elevated' });
    await render({ state: readyState({ watch: active, latestReset: null }), watch: active });

    expect(text()).toContain('Reset watch in effect');
    expect(text()).not.toContain('% chance');
    expect(text()).toContain('Forecast valid until');
    expect(text()).toContain('Elevated signal');
  });

  it('omits the level badge when the API reports one this build does not know', async () => {
    const active = watch({ level: null });
    await render({ state: readyState({ watch: active, latestReset: null }), watch: active });

    expect(text()).not.toContain('signal');
  });

  it('opens the source post in a new tab with safe rel attributes', async () => {
    const active = watch();
    await render({ state: readyState({ watch: active, latestReset: null }), watch: active });

    const link = Array.from(document.querySelectorAll('a')).find((node) =>
      node.textContent?.includes('@thsottiaux')
    );
    expect(link?.getAttribute('href')).toBe('https://x.com/thsottiaux/status/1');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('shows a loading line only for the first load', async () => {
    await render({ state: { status: 'loading', data: null, error: null } });

    expect(text()).toContain('Loading the latest forecast…');
  });

  it('reports the empty case and the last announced reset when active_watch is null', async () => {
    await render({
      state: readyState({
        watch: null,
        latestReset: {
          announcedAtIso: '2026-08-13T01:01:37.000Z',
          announcedAtMs: Date.parse('2026-08-13T01:01:37.000Z'),
          text: 'Enjoy a nice reset everyone.',
          source: { author: 'thsottiaux', url: 'https://x.com/thsottiaux/status/2' },
        },
      }),
    });

    expect(text()).toContain('No reset forecast right now.');
    expect(text()).toContain('Last reset announced');
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-08-13T01:01:37.000Z'
    );
  });

  it('says the forecast lapsed rather than pretending none existed', async () => {
    await render({
      state: readyState({ watch: watch(), latestReset: null }),
      watch: null,
      isExpired: true,
    });

    expect(text()).toContain('The last forecast has expired.');
  });

  it('offers a retry when the fetch failed', async () => {
    const onRetry = vi.fn();
    await render({
      state: { status: 'error', data: null, error: 'offline' },
      onRetry,
    });

    expect(text()).toContain('The reset forecast could not be loaded.');
    const retry = Array.from(document.querySelectorAll('button')).find(
      (node) => node.textContent === 'Try again'
    );
    expect(retry).toBeTruthy();

    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // A failed refresh must not blank a forecast the user is looking at.
  it('keeps showing the previous forecast when a refresh fails', async () => {
    const active = watch();
    await render({
      state: { status: 'error', data: { watch: active, latestReset: null }, error: 'offline' },
      watch: active,
    });

    expect(text()).toContain('65% chance of a reset');
    expect(text()).toContain('Could not refresh the forecast.');
    expect(text().match(/codex-resets\.com/g)).toHaveLength(1);
  });
});
