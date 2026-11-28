import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PUBLIC_PROMO_RETRY_BASE_MS,
  PUBLIC_PROMO_RETRY_MAX_MS,
  computeDiscountedPlusPricing,
  computeNextPublicPromoRefreshDelayMs,
  formatLandingPromoBannerCopy,
  formatPublicPromoBadge,
  formatPublicPromoNote,
  parsePublicPromoSnapshot,
  resolvePublicPromoEndpoint,
  resolvePublicPromoName,
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
  assert.equal(formatPublicPromoBadge(20, 'zh', { isYearly: true }), '折上 8 折');
  assert.equal(formatPublicPromoBadge(20, 'zh', { isYearly: false }), '限时 8 折');
  assert.equal(formatPublicPromoBadge(20, 'en', { isYearly: true }), 'Extra 20% off');
  assert.match(
    formatPublicPromoNote({ isYearly: true, promo: snapshot.active!, locale: 'zh' })!,
    /年付 8 折基础上再享 8 折（相当于月付 6\.4 折）.*\$76\.80/
  );
  assert.match(
    formatLandingPromoBannerCopy(snapshot.active!, 'zh').message,
    /享年付折上 8 折（相当于月付 6\.4 折）、月付 8 折/
  );
});

test('banner copy reflects configured intervals and feature flags without overpromising', () => {
  const base = {
    id: 'split-2026',
    startsAt: Date.parse('2026-11-26T00:00:00+08:00'),
    endsAt: Date.parse('2026-12-01T00:00:00+08:00'),
  };

  // Unequal monthly (40%) and yearly (10%) with seatExpansion=false: must state exact yearly stack & monthly rate
  // and must NOT mention seat expansion.
  const unequal = {
    ...base,
    monthlyDiscountPercent: 40,
    yearlyDiscountPercent: 10,
    upgradeToYearly: true,
    seatExpansion: false,
  };
  const unequalEn = formatLandingPromoBannerCopy(unequal, 'en');
  assert.equal(unequalEn.badge, 'Extra 10% off yearly');
  assert.match(
    unequalEn.message,
    /extra 10% off annual \(28% off monthly\) & 40% off monthly on your first Plus payment & monthly-to-yearly upgrades/
  );
  assert.doesNotMatch(unequalEn.message, /seat/);

  const unequalZh = formatLandingPromoBannerCopy(unequal, 'zh');
  assert.equal(unequalZh.badge, '年付折上 9 折');
  assert.match(
    unequalZh.message,
    /首笔订阅与月转年升级享年付折上 9 折（相当于月付 7\.2 折）、月付 6 折/
  );
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
  assert.equal(monthlyEn.badge, '20% off');
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
  assert.match(seatOnlyZh.message, /首笔订阅与新增成员席位享年付折上 8 折（相当于月付 6\.4 折）、月付 8 折/);
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

test('supports optional custom string and localized campaign names with locale fallback', () => {
  const localized = parsePublicPromoSnapshot({
    active: {
      id: 'bf-2026',
      name: { zh: '黑五特惠', en: 'Black Friday' },
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
  assert.equal(resolvePublicPromoName(localized.active, 'zh'), '黑五特惠');
  assert.equal(resolvePublicPromoName(localized.active, 'zh-hant'), '黑五特惠');
  assert.equal(resolvePublicPromoName(localized.active, 'en'), 'Black Friday');
  assert.equal(resolvePublicPromoName(localized.active, 'ja'), 'Black Friday');
  assert.match(formatLandingPromoBannerCopy(localized.active!, 'zh').message, /^黑五特惠 · Lody Plus：/);
  assert.match(
    formatLandingPromoBannerCopy(localized.active!, 'en').message,
    /^Black Friday: extra 20% off annual \(36% off monthly\)/
  );

  const plain = parsePublicPromoSnapshot({
    active: {
      id: 'spring-2027',
      name: 'Spring Launch',
      startsAt: 1_000,
      endsAt: 5_000,
      monthlyDiscountPercent: 15,
      yearlyDiscountPercent: 15,
      upgradeToYearly: false,
      seatExpansion: false,
    },
    serverNow: 2_000,
    nextChangeAt: 5_000,
  });
  assert.equal(resolvePublicPromoName(plain.active, 'zh'), 'Spring Launch');

  assert.throws(() =>
    parsePublicPromoSnapshot({
      active: {
        id: 'bad',
        name: 'bad\u0007name',
        startsAt: 1_000,
        endsAt: 5_000,
        monthlyDiscountPercent: 20,
        yearlyDiscountPercent: null,
        upgradeToYearly: false,
        seatExpansion: false,
      },
      serverNow: 2_000,
      nextChangeAt: 5_000,
    })
  );
});
