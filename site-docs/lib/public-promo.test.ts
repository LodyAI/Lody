import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PUBLIC_PROMO_RETRY_BASE_MS,
  PUBLIC_PROMO_RETRY_MAX_MS,
  computeDiscountedPlusPricing,
  computeNextPublicPromoRefreshDelayMs,
  formatLandingPromoBannerCopy,
  formatPublicPromoNote,
  parsePublicPromoSnapshot,
  resolvePublicPromoEndpoint,
  selectLivePublicPromo,
} from './public-promo.ts';

test('resolves only credential-free HTTPS or local development promo endpoints', () => {
  assert.equal(
    resolvePublicPromoEndpoint(undefined, 'https://example.convex.site/'),
    'https://example.convex.site/api/billing/public-promo'
  );
  assert.equal(
    resolvePublicPromoEndpoint('/api/billing/public-promo', undefined),
    '/api/billing/public-promo'
  );
  assert.equal(
    resolvePublicPromoEndpoint(undefined, 'http://localhost:3211'),
    'http://localhost:3211/api/billing/public-promo'
  );
  assert.equal(resolvePublicPromoEndpoint('https://user:pass@example.convex.site/promo'), null);
  assert.equal(resolvePublicPromoEndpoint(undefined, 'http://example.convex.site'), null);
});

test('expires the displayed campaign immediately at endsAt using server clock offset', () => {
  const snapshot = parsePublicPromoSnapshot({
    active: {
      id: 'thanksgiving-2026',
      startsAt: 1_000,
      endsAt: 5_000,
      monthlyDiscountPercent: 20,
      yearlyDiscountPercent: 25,
      upgradeToYearly: true,
      seatExpansion: true,
    },
    serverNow: 4_000,
    nextChangeAt: 5_000,
  });
  // Client clock is behind server: received serverNow=4000 when clientNow=0 => offset=+4000.
  const clockOffsetMs = 4_000;
  assert.equal(selectLivePublicPromo(snapshot, clockOffsetMs, 999)?.id, 'thanksgiving-2026');
  assert.equal(selectLivePublicPromo(snapshot, clockOffsetMs, 1_000), null);
});

test('computes first-period Plus rates without altering standard renewal amounts', () => {
  const snapshot = parsePublicPromoSnapshot({
    active: {
      id: 'bf-2026',
      startsAt: Date.parse('2026-11-26T00:00:00+08:00'),
      endsAt: Date.parse('2026-12-01T00:00:00+08:00'),
      monthlyDiscountPercent: 20,
      yearlyDiscountPercent: 20,
      upgradeToYearly: true,
      seatExpansion: true,
    },
    serverNow: Date.parse('2026-11-26T12:00:00+08:00'),
    nextChangeAt: Date.parse('2026-12-01T00:00:00+08:00'),
  });
  const pricing = computeDiscountedPlusPricing(snapshot.active);
  assert.equal(pricing.yearlyTotalCents, 7680);
  assert.equal(pricing.yearlyPerMonth, 6.4);
  assert.equal(pricing.monthlyTotalCents, 800);
  assert.equal(pricing.monthlyPerMonth, 8);
  assert.match(formatPublicPromoNote({ isYearly: true, promo: snapshot.active!, locale: 'zh' })!, /\$76\.80/);
  assert.match(formatLandingPromoBannerCopy(snapshot.active!, 'zh').message, /立享 8 折/);
});

test('banner copy reflects configured intervals and feature flags without overpromising', () => {
  const base = {
    id: 'split-2026',
    startsAt: Date.parse('2026-11-26T00:00:00+08:00'),
    endsAt: Date.parse('2026-12-01T00:00:00+08:00'),
  };

  // Unequal monthly (40%) and yearly (10%) with seatExpansion=false: must say "up to" / "低至"
  // and must NOT mention seat expansion.
  const unequal = {
    ...base,
    monthlyDiscountPercent: 40,
    yearlyDiscountPercent: 10,
    upgradeToYearly: true,
    seatExpansion: false,
  };
  const unequalEn = formatLandingPromoBannerCopy(unequal, 'en');
  assert.equal(unequalEn.badge, 'Up to 40% off');
  assert.match(unequalEn.message, /up to 40% off your first Plus payment & monthly-to-yearly upgrades/);
  assert.doesNotMatch(unequalEn.message, /seat/);

  const unequalZh = formatLandingPromoBannerCopy(unequal, 'zh');
  assert.equal(unequalZh.badge, '低至 6 折');
  assert.match(unequalZh.message, /首笔订阅与月转年升级低至 6 折/);
  assert.doesNotMatch(unequalZh.message, /席位|扩席/);

  // Monthly-only tier with upgradeToYearly=true: cannot discount yearly upgrades when yearly is null.
  const monthlyOnly = {
    ...base,
    monthlyDiscountPercent: 20,
    yearlyDiscountPercent: null,
    upgradeToYearly: true,
    seatExpansion: false,
  };
  const monthlyEn = formatLandingPromoBannerCopy(monthlyOnly, 'en');
  assert.match(monthlyEn.message, /20% off your first Plus monthly payment/);
  assert.doesNotMatch(monthlyEn.message, /yearly|annual|upgrade|seat/);

  // Seat expansion enabled while upgradeToYearly is disabled.
  const seatOnlyZh = formatLandingPromoBannerCopy(
    {
      ...base,
      monthlyDiscountPercent: 20,
      yearlyDiscountPercent: 20,
      upgradeToYearly: false,
      seatExpansion: true,
    },
    'zh'
  );
  assert.match(seatOnlyZh.message, /首笔订阅与新增成员席位立享 8 折/);
  assert.doesNotMatch(seatOnlyZh.message, /月转年/);
});

test('boundary refresh delay uses exact future deadline and bounded backoff after failures', () => {
  const snapshot = parsePublicPromoSnapshot({
    active: {
      id: 'bf-2026',
      startsAt: 1_000,
      endsAt: 10_000,
      monthlyDiscountPercent: 20,
      yearlyDiscountPercent: 20,
      upgradeToYearly: true,
      seatExpansion: true,
    },
    serverNow: 2_000,
    nextChangeAt: 10_000,
  });

  // Healthy future boundary: exact wakeup (+50ms guard).
  assert.equal(
    computeNextPublicPromoRefreshDelayMs({
      snapshot,
      clockOffsetMs: 0,
      nowMs: 2_000,
      consecutiveRetryCount: 0,
    }),
    8_050
  );

  // Boundary passed and refresh failed (or returned stale boundary): never 0ms loop; exponential backoff.
  assert.equal(
    computeNextPublicPromoRefreshDelayMs({
      snapshot,
      clockOffsetMs: 0,
      nowMs: 12_000,
      consecutiveRetryCount: 1,
    }),
    PUBLIC_PROMO_RETRY_BASE_MS
  );
  assert.equal(
    computeNextPublicPromoRefreshDelayMs({
      snapshot,
      clockOffsetMs: 0,
      nowMs: 17_000,
      consecutiveRetryCount: 2,
    }),
    PUBLIC_PROMO_RETRY_BASE_MS * 2
  );
  assert.equal(
    computeNextPublicPromoRefreshDelayMs({
      snapshot,
      clockOffsetMs: 0,
      nowMs: 50_000,
      consecutiveRetryCount: 10,
    }),
    PUBLIC_PROMO_RETRY_MAX_MS
  );
});
