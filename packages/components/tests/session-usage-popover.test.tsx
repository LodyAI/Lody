// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getRateLimitEntryKey, type AgentConfigId } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionUsagePopover } from '../src/components/sessions/session-usage-popover';
import type { MachineRateLimits } from '../src/lib/session-usage';
import { createTestI18n, withTestI18n } from './test-i18n';

const testI18n = createTestI18n();

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
        withTestI18n(
          createElement(SessionUsagePopover, {
            agentType: 'codex',
            modelId: 'gpt-5.4',
            ...props,
          }),
          testI18n
        )
      );
    });
  };

  it('keeps rate-limit-only usage hidden unless explicitly enabled', async () => {
    await renderUsage({ rateLimits });

    expect(container.querySelector('button')).toBeNull();
  });

  it.each(['antigravity', 'antigravity-acp'])(
    'shows both model groups and both quota windows alongside context for %s',
    async (agentType) => {
      const agentConfigId = 'antigravity-provider' as AgentConfigId;
      const limits: MachineRateLimits = {
        [getRateLimitEntryKey(agentType, agentType, agentConfigId)]: {
          limitId: agentType,
          scope: { providerId: 'antigravity' },
          windows: [
            {
              label: 'Gemini Models',
              usedPercent: 25,
              windowDurationSeconds: 604_800,
              resetsAtEpochSeconds: null,
            },
            {
              label: 'Gemini Models',
              usedPercent: 10,
              windowDurationSeconds: 18_000,
              resetsAtEpochSeconds: null,
            },
            {
              label: 'Claude and GPT models',
              usedPercent: 0,
              windowDurationSeconds: 604_800,
              resetsAtEpochSeconds: null,
            },
            {
              label: 'Claude and GPT models',
              usedPercent: 0,
              windowDurationSeconds: 18_000,
              resetsAtEpochSeconds: null,
            },
          ],
        },
      };
      await renderUsage({
        agentType,
        agentConfigId,
        modelId: 'gemini-pro-orchestrator',
        contextWindowUsage: { used: 100, size: 1000 },
        rateLimits: limits,
      });
      await act(async () => {
        container
          .querySelector('button')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      const meters = document.body
        .querySelector('[aria-label="Usage"]')
        ?.querySelectorAll('[role="progressbar"]');
      expect(Array.from(meters ?? []).map((meter) => meter.getAttribute('aria-label'))).toEqual([
        'Context: 10% used',
        'Weekly · Gemini Models: 25% used',
        'Weekly · Claude and GPT models: 0% used',
        '5 hours · Gemini Models: 10% used',
        '5 hours · Claude and GPT models: 0% used',
      ]);
    }
  );

  it.each([
    { fiveHourFirst: false, usedPercent: 11 },
    { fiveHourFirst: true, usedPercent: 0 },
  ])(
    'prefers five-hour usage ($usedPercent%) with fiveHourFirst=$fiveHourFirst',
    async ({ fiveHourFirst, usedPercent }) => {
      const key = getRateLimitEntryKey('codex', 'codex');
      const weekly = rateLimits[key]!.windows[0]!;
      const fiveHour = {
        usedPercent,
        windowDurationSeconds: 5 * 60 * 60,
        resetsAtEpochSeconds: null,
      };
      const limits: MachineRateLimits = {
        [key]: {
          ...rateLimits[key]!,
          windows: fiveHourFirst ? [fiveHour, weekly] : [weekly, fiveHour],
        },
      };
      await renderUsage({ rateLimits: limits, showRateLimitWithoutContext: true });

      const trigger = container.querySelector('button');
      expect(trigger?.textContent).toBe(`${usedPercent}%`);
      expect(trigger?.getAttribute('aria-label')).toBe(`Open usage details, ${usedPercent}% used`);
      expect(trigger?.getAttribute('title')).toBe(`Open usage details, ${usedPercent}% used`);

      await act(async () => {
        trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      const meters = document.body
        .querySelector('[aria-label="Usage"]')
        ?.querySelectorAll('[role="progressbar"]');
      expect(Array.from(meters ?? []).map((meter) => meter.getAttribute('aria-label'))).toEqual([
        'Weekly: 29% used',
        `5 hours: ${usedPercent}% used`,
      ]);

      await renderUsage({
        contextWindowUsage: { size: 128_000, used: 32_000 },
        rateLimits: limits,
        showRateLimitWithoutContext: true,
      });
      expect(container.querySelector('button')?.textContent).toBe('25%');
    }
  );

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

  it('keeps the compacting state visible without context data', async () => {
    await renderUsage({ isContextCompacting: true, rateLimits });

    const trigger = container.querySelector('button');
    expect(trigger?.textContent).toBe('Compacting');
    expect(trigger?.getAttribute('aria-label')).toBe('Compacting context');
  });
});
