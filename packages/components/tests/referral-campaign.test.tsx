// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReferralPolicyRefresh } from '../src/hooks/use-referral-policy-refresh';
import { ReferralOfferNotice } from '../src/components/settings/referral-settings-pure';
import { initI18n } from '../src/i18n';

const clock = vi.hoisted(() => ({ now: 1000 }));
vi.mock('@lody/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lody/shared')>()),
  getServerNow: () => clock.now,
}));
let root: Root, container: HTMLDivElement;
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await initI18n('en');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  clock.now = 1000;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('campaign checkout display', () => {
  it('shows the first annual payment at $76.80 and keeps the regular renewal at $96', async () => {
    await act(async () =>
      root.render(
        <ReferralOfferNotice
          interval="year"
          regularCents={9600}
          policy={{
            campaignId: 'autumn',
            discountPercent: 20,
            rewardPercent: 25,
            startsAt: Date.UTC(2026, 9, 23, 16),
            endsAt: Date.UTC(2026, 9, 28, 16),
          }}
        />
      )
    );
    expect(container.textContent).toContain('20% off');
    expect(container.textContent).toContain('$76.80');
    expect(container.textContent).toContain('then $96/year');
    expect(container.textContent).toContain('UTC+8');
  });
  it('distinguishes retained checkout pricing from a new order after the campaign', async () => {
    await act(async () =>
      root.render(
        <ReferralOfferNotice
          interval="year"
          regularCents={9600}
          retained={{
            policy: { campaignId: 'autumn', discountPercent: 20, rewardPercent: 25 },
            expiresAt: 10000,
          }}
        />
      )
    );
    expect(container.textContent).toContain('existing checkout keeps 20% off');
    expect(container.textContent).toContain('$86.40');
  });
});

describe('policy boundary refresh', () => {
  function Probe({ next }: { next?: number }) {
    const [generation, refresh] = useState(0);
    useReferralPolicyRefresh(next, refresh);
    return <span>{generation}</span>;
  }
  it('retries when the client clock reached a boundary before the server, and stops after the server changes it', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<Probe next={2000} />));
    clock.now = 2000;
    await act(async () => vi.advanceTimersByTime(1000));
    expect(container.textContent).toBe('1');
    // Server response still has the same deadline; its next clock tick must retry.
    await act(async () => root.render(<Probe next={2000} />));
    await act(async () => vi.advanceTimersByTime(1000));
    expect(container.textContent).toBe('2');
    await act(async () => root.render(<Probe />));
    await act(async () => vi.advanceTimersByTime(5000));
    expect(container.textContent).toBe('2');
  });
  it('revalidates a retained session deadline on focus after suspension and cleans listeners on unmount', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<Probe next={3000} />));
    clock.now = 4000;
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.textContent).toBe('1');
    await act(async () => root.render(<Probe next={Infinity} />));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.textContent).toBe('1');
  });
});
