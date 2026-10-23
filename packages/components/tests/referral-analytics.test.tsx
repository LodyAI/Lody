// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapabilitySet, type CloudApi, type PlatformProvider } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type { ReferralOverview } from '@lody/cloud-api';
import { TEST_CLOUD_PLATFORM } from './test-platform';
import { captureReferral, readReferral } from '../src/lib/referral-attribution';
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

  it('leaves the hint retryable if capture fails and ignores missing clients and invalid hints', () => {
    captureReferral('?ref=' + 'b'.repeat(32));
    captureReferralLanding(null);
    sink.fail = true;
    expect(() => captureReferralLanding(client)).not.toThrow();
    expect(readReferral()).toBe('b'.repeat(32));
    sink.fail = false;
    captureReferralLanding(client);
    expect(sink.events).toHaveLength(1);
    localStorage.setItem('lody:referral', '{broken');
    captureReferralLanding(client);
    expect(sink.events).toHaveLength(1);
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
  it('attaches the displayed campaign to card and copy events without exposing coupon IDs', async () => {
    overview!.policy = { campaignId: 'autumn', discountPercent: 20, rewardPercent: 25 };
    await render();
    await clickCopy();
    for (const event of sink.events) {
      expect(event.properties).toMatchObject({
        campaign_id: 'autumn',
        discount_percent: 20,
        reward_percent: 25,
      });
    }
    expect(sink.events.map((event) => event.event)).toEqual([
      'referral/viewed',
      'referral/link_copied',
    ]);
  });
  const clickCopy = async () => {
    const button = [...container.querySelectorAll('button')].find((b) =>
      /copy|create|generate/i.test(b.textContent ?? '')
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };

  it('counts only visible loaded cards once per workspace despite StrictMode and balance updates', async () => {
    const loaded = overview!;
    overview = undefined;
    await render();
    expect(sink.events).toEqual([]);
    overview = { ...loaded, eligible: false, code: null, url: null, issued: 0, available: 0 };
    await render();
    expect(sink.events).toEqual([]);
    overview = loaded;
    await render();
    overview = { ...loaded, available: 500 };
    await render();
    await render('second');
    expect(sink.events.map((e) => [e.event, e.properties.workspace_id])).toEqual([
      ['referral/viewed', 'workspace'],
      ['referral/viewed', 'second'],
    ]);
  });

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
