// @vitest-environment jsdom
// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapabilitySet, type CloudApi, type PlatformProvider } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type { ReferralOverview } from '@lody/cloud-api';
import { TEST_CLOUD_PLATFORM } from './test-platform';
import { readReferral } from '../src/lib/referral-attribution';
import { captureReferralLanding } from '../src/lib/referral-analytics';
import { ReferralSettings } from '../src/components/settings/referral-settings';
import { initI18n } from '../src/i18n';

const sink = vi.hoisted(() => ({
  events: [] as Array<{ event: string; properties: Record<string, unknown> }>,
  fail: false,
  clipboard: true,
}));
vi.mock('@posthog/react', () => ({ usePostHog: () => client }));
vi.mock('../src/lib/clipboard', () => ({ writeTextToClipboard: async () => sink.clipboard }));
const client = {
  capture(event: string, properties: Record<string, unknown> = {}) {
    if (sink.fail) throw new Error('Analytics unavailable');
    sink.events.push({ event, properties });
  },
};

beforeEach(() => {
  sink.events = [];
  sink.fail = false;
  sink.clipboard = true;
  localStorage.clear();
});

describe('referral landing observation', () => {
  it('survives a static redirect, reports only once and keeps attribution and expiry unchanged', () => {
    const code = 'a'.repeat(32);
    localStorage.setItem(
      'lody:referral',
      JSON.stringify({ code, expiresAt: 1000 + 30 * 86400000 })
    );
    captureReferralLanding(client, localStorage, 2000);
    captureReferralLanding(client, localStorage, 3000);
    expect(sink.events.map((e) => e.event)).toEqual(['referral/landed']);
    expect(sink.events[0]!.properties.source).toBe('stored_attribution');
    expect(JSON.stringify(sink.events)).not.toContain(code);
    expect(readReferral(localStorage, 3000)).toBe(code);
    expect(readReferral(localStorage, 1000 + 30 * 86400000)).toBeUndefined();
  });
});

describe('referral UI analytics', () => {
  let root: Root;
  let container: HTMLDivElement;
  let overview: ReferralOverview | undefined;
  let platform: PlatformProvider;
  const code = 'c'.repeat(32);
  const url = 'https://example.test/login?ref=' + code;
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    overview = {
      eligible: true,
      code,
      url,
      issued: 1000,
      spent: 0,
      available: 1000,
      frozen: 0,
      adjustment: 0,
      newcomerDiscount: false,
    };
    platform = {
      ...TEST_CLOUD_PLATFORM,
      cloudApi: {
        ...TEST_CLOUD_PLATFORM.cloudApi!,
        useQuery: (() => overview) as CloudApi['useQuery'],
        useMutation: (() => async () => ({ code, url })) as CloudApi['useMutation'],
      },
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = async (workspaceId = 'workspace') => {
    await act(async () => {
      root.render(
        <PlatformContext.Provider value={platform}>
          <StrictMode>
            <ReferralSettings workspaceId={workspaceId} canManage />
          </StrictMode>
        </PlatformContext.Provider>
      );
    });
  };
  const clickCopy = async () => {
    const button = [...container.querySelectorAll('button')].find((b) =>
      /copy|create|generate/i.test(b.textContent ?? '')
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };

  it('reports successful copies only and never sends the link or raw code', async () => {
    await render();
    sink.clipboard = false;
    await clickCopy();
    expect(sink.events.filter((e) => e.event === 'referral/link_copied')).toEqual([]);
    sink.clipboard = true;
    await clickCopy();
    expect(sink.events.filter((e) => e.event === 'referral/link_copied')).toHaveLength(1);
    expect(JSON.stringify(sink.events)).not.toContain(code);
    expect(JSON.stringify(sink.events)).not.toContain('https://');
  });

  it.each(['disabled', 'throws'])('preserves copy behavior when telemetry %s', async (mode) => {
    if (mode === 'disabled') {
      platform = {
        ...platform,
        capabilities: createCapabilitySet(
          TEST_CLOUD_PLATFORM.capabilities.list().filter((capability) => capability !== 'telemetry')
        ),
      };
    } else {
      sink.fail = true;
    }
    await render();
    await clickCopy();
    expect(sink.events).toEqual([]);
    expect(container.textContent).toContain('Copied');
  });
});
