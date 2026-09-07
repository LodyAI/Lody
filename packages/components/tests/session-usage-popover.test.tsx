// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getRateLimitEntryKey } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionUsagePopover } from '../src/components/sessions/session-usage-popover';
import type { MachineRateLimits } from '../src/lib/session-usage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, values?: Record<string, string | number>): string => {
      if (typeof fallback !== 'string') return key;
      return fallback.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
        values?.[name] === undefined ? match : String(values[name])
      );
    },
    i18n: { language: 'en' },
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const rateLimits: MachineRateLimits = {
  [getRateLimitEntryKey('codex', 'codex')]: {
    limitId: 'codex',
    scope: { providerId: 'codex' },
    planName: 'ChatGPT Plus',
    windows: [
      {
        usedPercent: 29,
        windowDurationSeconds: 7 * 24 * 60 * 60,
        resetsAtEpochSeconds: null,
      },
    ],
  },
};

describe('SessionUsagePopover', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const renderUsage = async (
    props: Partial<ComponentProps<typeof SessionUsagePopover>> = {}
  ): Promise<void> => {
    await act(async () => {
      root.render(
        createElement(SessionUsagePopover, {
          agentType: 'codex',
          modelId: 'gpt-5.4',
          ...props,
        })
      );
    });
  };

  it('shows the used context percentage in the composer trigger', async () => {
    await renderUsage({ contextWindowUsage: { size: 128_000, used: 32_000 } });

    const trigger = container.querySelector('button');
    expect(trigger?.textContent).toBe('25%');
    expect(trigger?.getAttribute('aria-label')).toBe('Open usage details, 25% used');
    expect(trigger?.getAttribute('title')).toBe('Open usage details, 25% used');
  });

  it('shows rate limit usage and details without context when explicitly enabled', async () => {
    await renderUsage({ rateLimits, showRateLimitWithoutContext: true });

    const trigger = container.querySelector('button');
    expect(trigger?.textContent).toBe('29%');
    expect(trigger?.getAttribute('aria-label')).toBe('Open usage details, 29% used');

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const popover = document.body.querySelector('[aria-label="Usage"]');
    expect(popover?.textContent).toContain('Weekly');
    expect(popover?.textContent).toContain('29% used');
  });

  it('keeps rate-limit-only usage hidden unless explicitly enabled', async () => {
    await renderUsage({ rateLimits });

    expect(container.querySelector('button')).toBeNull();
  });

  it('shows Fable weekly as a distinct meter beside shared quotas', async () => {
    await renderUsage({
      agentType: 'claude',
      modelId: 'claude-fable-5',
      showRateLimitWithoutContext: true,
      rateLimits: {
        [getRateLimitEntryKey('claude', 'claude')]: {
          limitId: 'claude',
          scope: { providerId: 'claude' },
          windows: [
            { usedPercent: 12, windowDurationSeconds: 18_000, resetsAtEpochSeconds: null },
            { usedPercent: 30, windowDurationSeconds: 604_800, resetsAtEpochSeconds: null },
            {
              label: 'Fable',
              usedPercent: 67,
              windowDurationSeconds: 604_800,
              resetsAtEpochSeconds: null,
            },
          ],
        },
      },
    });
    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const popover = document.body.querySelector('[aria-label="Usage"]');
    expect(
      Array.from(popover?.querySelectorAll('[role="progressbar"]') ?? []).map((meter) =>
        meter.getAttribute('aria-label')
      )
    ).toEqual(['Weekly: 30% used', 'Weekly · Fable: 67% used', '5 hours: 12% used']);
  });

  it('shows a truthful unavailable state when the provider omits utilization', async () => {
    const unavailableLimits: MachineRateLimits = {
      [getRateLimitEntryKey('grok', 'grok')]: {
        limitId: 'grok',
        scope: { providerId: 'grok' },
        planName: 'X Premium+',
        limitName: 'Grok Build',
        windows: [],
      },
    };
    await renderUsage({
      agentType: 'grok',
      modelId: 'grok-4.5',
      rateLimits: unavailableLimits,
      contextWindowUsage: { size: 128_000, used: 32_000 },
    });

    const trigger = container.querySelector('button');
    expect(trigger?.textContent).toBe('25%');
    expect(trigger?.getAttribute('aria-label')).toBe('Open usage details, 25% used');

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.querySelector('[aria-label="Usage"]')?.textContent).toContain(
      'The provider did not report usage for this plan'
    );
  });

  it('hides the trigger when context data is invalid even if subscription usage exists', async () => {
    await renderUsage({ contextWindowUsage: { size: 0, used: 0 }, rateLimits });

    expect(container.querySelector('button')).toBeNull();
  });

  it('keeps the compacting state visible without context data', async () => {
    await renderUsage({ isContextCompacting: true, rateLimits });

    const trigger = container.querySelector('button');
    expect(trigger?.textContent).toBe('Compacting');
    expect(trigger?.getAttribute('aria-label')).toBe('Compacting context');
  });
});
