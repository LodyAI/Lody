import type { SiteLocale } from '@site/src/site-pages/shared';

export type PromoCampaignName = string | Record<string, string>;

export type PublicPromoActive = {
  id: string;
  name?: PromoCampaignName | null;
  startsAt: number;
  endsAt: number;
  monthlyDiscountPercent: number | null;
  yearlyDiscountPercent: number | null;
  upgradeToYearly: boolean;
  seatExpansion: boolean;
};

export type PublicPromoSnapshot = {
  active: PublicPromoActive | null;
  serverNow: number;
  nextChangeAt: number | null;
};

const REGULAR_MONTHLY_CENTS = 1000;
const REGULAR_YEARLY_CENTS = 9600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDiscountPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 99;
}

/**
 * Resolve the public read-only promotional endpoint URL from build-time Vite env.
 * Rejects embedded credentials and non-HTTPS remote origins.
 */
export function resolvePublicPromoEndpoint(
  promoUrl?: unknown,
  convexSiteUrl?: unknown
): string | null {
  if (typeof promoUrl === 'string' && promoUrl.trim() !== '') {
    const trimmed = promoUrl.trim();
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
      return trimmed;
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.username || parsed.password || parsed.hash) return null;
      const isLocal =
        parsed.protocol === 'http:' &&
        (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
      if (parsed.protocol !== 'https:' && !isLocal) return null;
      return parsed.href;
    } catch {
      return null;
    }
  }
  if (typeof convexSiteUrl === 'string' && convexSiteUrl.trim() !== '') {
    try {
      const parsed = new URL(convexSiteUrl.trim());
      if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
      const isLocal =
        parsed.protocol === 'http:' &&
        (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
      if (parsed.protocol !== 'https:' && !isLocal) return null;
      const base = parsed.href.replace(/\/+$/u, '');
      return `${base}/api/billing/public-promo`;
    } catch {
      return null;
    }
  }
  return null;
}

const PROMO_CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/u;

function parsePromoCampaignName(raw: unknown): PromoCampaignName | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    if (PROMO_CONTROL_CHARS_RE.test(raw)) {
      throw new Error('Invalid public promo campaign name');
    }
    const trimmed = raw.trim();
    if (trimmed.length < 1 || trimmed.length > 80) {
      throw new Error('Invalid public promo campaign name');
    }
    return trimmed;
  }
  if (!isRecord(raw)) {
    throw new Error('Invalid public promo campaign name');
  }
  const entries = Object.entries(raw);
  if (entries.length < 1 || entries.length > 16) {
    throw new Error('Invalid public promo campaign name');
  }
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    if (PROMO_CONTROL_CHARS_RE.test(rawKey) || typeof rawValue !== 'string' || PROMO_CONTROL_CHARS_RE.test(rawValue)) {
      throw new Error('Invalid public promo campaign name');
    }
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();
    if (key.length < 1 || key.length > 32 || value.length < 1 || value.length > 80) {
      throw new Error('Invalid public promo campaign name');
    }
    normalized[key] = value;
  }
  return normalized;
}

function normalizePromoLocaleKey(raw: string): string {
  const lower = raw.trim().toLowerCase().replace(/_/gu, '-');
  if (
    lower === 'zh-hant' ||
    lower.startsWith('zh-hant-') ||
    lower === 'zh-tw' ||
    lower.startsWith('zh-tw-') ||
    lower === 'zh-hk' ||
    lower.startsWith('zh-hk-') ||
    lower === 'zh-mo' ||
    lower.startsWith('zh-mo-')
  ) {
    return 'zh-hant';
  }
  if (lower === 'zh' || lower.startsWith('zh-')) return 'zh';
  return lower.split('-')[0] || 'en';
}

export function resolvePublicPromoName(
  promo: PublicPromoActive | null | undefined,
  locale: SiteLocale
): string | null {
  const raw = promo?.name;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 80).trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!isRecord(raw)) return null;
  const entries = new Map<string, string>();
  let firstNonEmpty: string | null = null;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue;
    const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 80).trim();
    if (!cleaned) continue;
    if (firstNonEmpty === null) firstNonEmpty = cleaned;
    const exactKey = key.trim().toLowerCase().replace(/_/gu, '-');
    if (exactKey && !entries.has(exactKey)) entries.set(exactKey, cleaned);
    const normalizedKey = normalizePromoLocaleKey(key);
    if (normalizedKey && !entries.has(normalizedKey)) entries.set(normalizedKey, cleaned);
  }
  if (firstNonEmpty === null) return null;
  const target = normalizePromoLocaleKey(locale);
  if (entries.has(target)) return entries.get(target)!;
  if (target === 'zh-hant' && entries.has('zh')) return entries.get('zh')!;
  if (target === 'zh' && entries.has('zh-hant')) return entries.get('zh-hant')!;
  if (entries.has('en')) return entries.get('en')!;
  if (entries.has('default')) return entries.get('default')!;
  return firstNonEmpty;
}

export function parsePublicPromoSnapshot(value: unknown): PublicPromoSnapshot {
  if (!isRecord(value) || typeof value.serverNow !== 'number' || !Number.isFinite(value.serverNow)) {
    throw new Error('Invalid public promo payload');
  }
  const nextChangeAt =
    value.nextChangeAt === null || value.nextChangeAt === undefined
      ? null
      : typeof value.nextChangeAt === 'number' && Number.isFinite(value.nextChangeAt)
        ? value.nextChangeAt
        : undefined;
  if (nextChangeAt === undefined) {
    throw new Error('Invalid public promo nextChangeAt');
  }
  if (value.active === null || value.active === undefined) {
    return { active: null, serverNow: value.serverNow, nextChangeAt };
  }
  const raw = value.active;
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    raw.id.trim() === '' ||
    typeof raw.startsAt !== 'number' ||
    !Number.isFinite(raw.startsAt) ||
    typeof raw.endsAt !== 'number' ||
    !Number.isFinite(raw.endsAt) ||
    raw.endsAt <= raw.startsAt
  ) {
    throw new Error('Invalid public promo active campaign');
  }
  const monthly =
    raw.monthlyDiscountPercent === null || raw.monthlyDiscountPercent === undefined
      ? null
      : isDiscountPercent(raw.monthlyDiscountPercent)
        ? raw.monthlyDiscountPercent
        : undefined;
  const yearly =
    raw.yearlyDiscountPercent === null || raw.yearlyDiscountPercent === undefined
      ? null
      : isDiscountPercent(raw.yearlyDiscountPercent)
        ? raw.yearlyDiscountPercent
        : undefined;
  if (monthly === undefined || yearly === undefined || (monthly === null && yearly === null)) {
    throw new Error('Invalid public promo discount percentages');
  }
  const name = parsePromoCampaignName(raw.name);
  return {
    active: {
      id: raw.id.trim(),
      name,
      startsAt: raw.startsAt,
      endsAt: raw.endsAt,
      monthlyDiscountPercent: monthly,
      yearlyDiscountPercent: yearly,
      upgradeToYearly: Boolean(raw.upgradeToYearly),
      seatExpansion: Boolean(raw.seatExpansion),
    },
    serverNow: value.serverNow,
    nextChangeAt,
  };
}

/**
 * Evaluate whether the snapshot's campaign is still within its server-authoritative
 * `[startsAt, endsAt)` window using the measured server-to-client clock offset, so
 * an expired campaign disappears immediately at `endsAt` even before the next fetch.
 */
export function selectLivePublicPromo(
  snapshot: PublicPromoSnapshot | null,
  clockOffsetMs: number,
  clientNowMs: number
): PublicPromoActive | null {
  if (!snapshot?.active) return null;
  const estimatedServerNow = clientNowMs + clockOffsetMs;
  if (estimatedServerNow < snapshot.active.startsAt || estimatedServerNow >= snapshot.active.endsAt) {
    return null;
  }
  return snapshot.active;
}

export function computeDiscountedPlusPricing(promo: PublicPromoActive | null) {
  const yearlyPercent = promo?.yearlyDiscountPercent ?? 0;
  const monthlyPercent = promo?.monthlyDiscountPercent ?? 0;
  const yearlyTotalCents =
    yearlyPercent > 0
      ? Math.round((REGULAR_YEARLY_CENTS * (100 - yearlyPercent)) / 100)
      : REGULAR_YEARLY_CENTS;
  const monthlyTotalCents =
    monthlyPercent > 0
      ? Math.round((REGULAR_MONTHLY_CENTS * (100 - monthlyPercent)) / 100)
      : REGULAR_MONTHLY_CENTS;
  const yearlyPerMonth = Number((yearlyTotalCents / 1200).toFixed(2));
  const monthlyPerMonth = Number((monthlyTotalCents / 100).toFixed(2));
  return {
    yearlyPercent,
    monthlyPercent,
    yearlyTotalCents,
    monthlyTotalCents,
    yearlyPerMonth,
    monthlyPerMonth,
    regularYearlyPerMonth: REGULAR_YEARLY_CENTS / 1200,
    regularMonthlyPerMonth: REGULAR_MONTHLY_CENTS / 100,
  };
}

function formatCentsUsd(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

function formatShortCampaignEndDate(endsAtExclusiveMs: number, locale: SiteLocale): string {
  const intlLocale =
    locale === 'zh' ? 'zh-CN' : locale === 'zh-hant' ? 'zh-Hant' : locale;
  return new Intl.DateTimeFormat(intlLocale, {
    timeZone: 'Asia/Shanghai',
    month: 'short',
    day: 'numeric',
  }).format(new Date(Math.max(0, endsAtExclusiveMs - 1)));
}

function formatChineseRate(discountPercent: number): string {
  const rate = Number(((100 - discountPercent) / 10).toFixed(2));
  return Number.isInteger(rate) ? String(rate) : String(rate);
}

function formatCombinedYearlyChineseRate(yearlyDiscountPercent: number): string {
  const combinedRate = Number(((80 * (100 - yearlyDiscountPercent)) / 1000).toFixed(2));
  return String(combinedRate);
}

function formatCombinedYearlyOffPercent(yearlyDiscountPercent: number): string {
  const combinedOff = Number((100 - (80 * (100 - yearlyDiscountPercent)) / 100).toFixed(1));
  return String(combinedOff);
}

export function formatPublicPromoBadge(
  discountPercent: number,
  locale: SiteLocale,
  options?: { isYearly?: boolean }
): string {
  const isYearly = options?.isYearly ?? false;
  if (isYearly) {
    switch (locale) {
      case 'zh':
      case 'zh-hant':
        return `折上 ${formatChineseRate(discountPercent)} 折`;
      case 'ja':
        return `さらに ${discountPercent}% OFF`;
      case 'ko':
        return `추가 ${discountPercent}% 할인`;
      case 'es':
        return `−${discountPercent}% extra`;
      case 'fr':
        return `−${discountPercent} % suppl.`;
      case 'ru':
        return `Ещё −${discountPercent}%`;
      case 'en':
      default:
        return `Extra ${discountPercent}% off`;
    }
  }
  switch (locale) {
    case 'zh':
    case 'zh-hant':
      return `限时 ${formatChineseRate(discountPercent)} 折`
        .replace('限时', locale === 'zh-hant' ? '限時' : '限时');
    case 'ja':
      return `${discountPercent}% OFF`;
    case 'ko':
      return `${discountPercent}% 할인`;
    case 'es':
      return `−${discountPercent}%`;
    case 'fr':
      return `−${discountPercent} %`;
    case 'ru':
      return `−${discountPercent}%`;
    case 'en':
    default:
      return `${discountPercent}% off`;
  }
}

export function formatPublicPromoNote(args: {
  isYearly: boolean;
  promo: PublicPromoActive;
  locale: SiteLocale;
}): string | null {
  const { isYearly, promo, locale } = args;
  const pricing = computeDiscountedPlusPricing(promo);
  const percent = isYearly ? pricing.yearlyPercent : pricing.monthlyPercent;
  if (percent <= 0) return null;
  const firstTotal = formatCentsUsd(
    isYearly ? pricing.yearlyTotalCents : pricing.monthlyTotalCents
  );
  const regularTotal = formatCentsUsd(isYearly ? REGULAR_YEARLY_CENTS : REGULAR_MONTHLY_CENTS);
  const endDate = formatShortCampaignEndDate(promo.endsAt, locale);
  const rateZh = formatChineseRate(percent);
  const combinedRateZh = formatCombinedYearlyChineseRate(percent);
  const combinedOff = formatCombinedYearlyOffPercent(percent);

  switch (locale) {
    case 'zh':
      return isYearly
        ? `年付 8 折基础上再享 ${rateZh} 折（相当于月付 ${combinedRateZh} 折）· 首年 ${firstTotal}/席，次年恢复 ${regularTotal}/年 · 截止 ${endDate}`
        : `首月 ${firstTotal}/席（次月恢复 ${regularTotal}/月）· 截止 ${endDate}`;
    case 'zh-hant':
      return isYearly
        ? `年付 8 折基礎上再享 ${rateZh} 折（相當於月付 ${combinedRateZh} 折）· 首年 ${firstTotal}/席，次年恢復 ${regularTotal}/年 · 截止 ${endDate}`
        : `首月 ${firstTotal}/席（次月恢復 ${regularTotal}/月）· 截止 ${endDate}`;
    case 'ja':
      return isYearly
        ? `年額からさらに ${percent}% OFF（月額比 ${combinedOff}% OFF）· 初年度 ${firstTotal}/席（翌年以降 ${regularTotal}/年）· ${endDate} まで`
        : `初月 ${firstTotal}/席（翌月以降 ${regularTotal}/月）· ${endDate} まで`;
    case 'ko':
      return isYearly
        ? `연간 추가 ${percent}% 할인(월간 대비 ${combinedOff}% 할인) · 첫해 ${firstTotal}/좌석 (이후 ${regularTotal}/년) · ${endDate} 마감`
        : `첫달 ${firstTotal}/좌석 (이후 ${regularTotal}/월) · ${endDate} 마감`;
    case 'es':
      return isYearly
        ? `−${percent}% extra anual (−${combinedOff}% vs. mensual) · Primer año ${firstTotal}/asiento, luego ${regularTotal}/año · Hasta el ${endDate}`
        : `Primer mes ${firstTotal}/asiento, luego ${regularTotal}/mes · Hasta el ${endDate}`;
    case 'fr':
      return isYearly
        ? `−${percent} % suppl. annuel (−${combinedOff} % vs mensuel) · 1re année ${firstTotal}/siège, puis ${regularTotal}/an · Jusqu’au ${endDate}`
        : `1er mois ${firstTotal}/siège, puis ${regularTotal}/mois · Jusqu’au ${endDate}`;
    case 'ru':
      return isYearly
        ? `Ещё −${percent}% к годовому (−${combinedOff}% к помесячному) · Первый год ${firstTotal}/место, далее ${regularTotal}/год · До ${endDate}`
        : `Первый месяц ${firstTotal}/место, далее ${regularTotal}/мес · До ${endDate}`;
    case 'en':
    default:
      return isYearly
        ? `Extra ${percent}% off annual (${combinedOff}% off monthly) · First year ${firstTotal}/seat, then ${regularTotal}/yr · Ends ${endDate}`
        : `First month ${firstTotal}/seat, then ${regularTotal}/mo · Ends ${endDate}`;
  }
}

function formatYearlyStackBannerBadge(yearlyDiscountPercent: number, locale: SiteLocale): string {
  const rateZh = formatChineseRate(yearlyDiscountPercent);
  switch (locale) {
    case 'zh':
    case 'zh-hant':
      return `年付折上 ${rateZh} 折`;
    case 'ja':
      return `年額さらに ${yearlyDiscountPercent}% OFF`;
    case 'ko':
      return `연간 추가 ${yearlyDiscountPercent}% 할인`;
    case 'es':
      return `−${yearlyDiscountPercent}% extra anual`;
    case 'fr':
      return `−${yearlyDiscountPercent} % suppl. annuel`;
    case 'ru':
      return `Ещё −${yearlyDiscountPercent}% на год`;
    case 'en':
    default:
      return `Extra ${yearlyDiscountPercent}% off yearly`;
  }
}

export const PUBLIC_PROMO_RETRY_BASE_MS = 5_000;
export const PUBLIC_PROMO_RETRY_MAX_MS = 60_000;

export function computeNextPublicPromoRefreshDelayMs(args: {
  snapshot: PublicPromoSnapshot | null;
  clockOffsetMs: number;
  nowMs: number;
  consecutiveRetryCount: number;
}): number | null {
  const { snapshot, clockOffsetMs, nowMs, consecutiveRetryCount } = args;
  if (!snapshot) return null;
  const nextBoundary = snapshot.nextChangeAt ?? snapshot.active?.endsAt ?? null;
  if (nextBoundary === null) return null;
  const estimatedServerNow = nowMs + clockOffsetMs;
  const rawDelayMs = nextBoundary - estimatedServerNow + 50;
  if (rawDelayMs > 0 && consecutiveRetryCount === 0) {
    return Math.min(rawDelayMs, 2_147_483_647);
  }
  const retryStep = Math.max(1, consecutiveRetryCount);
  const backoffMs = Math.min(
    PUBLIC_PROMO_RETRY_MAX_MS,
    PUBLIC_PROMO_RETRY_BASE_MS * 2 ** Math.min(retryStep - 1, 4)
  );
  return Math.min(Math.max(rawDelayMs, backoffMs), 2_147_483_647);
}

type BannerPlanScope = 'both' | 'yearly_only' | 'monthly_only';

function joinLocalizedScopes(items: string[], andWord: string, comma = ', '): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]}${andWord}${items[1]}`;
  return `${items.slice(0, -1).join(comma)}${andWord}${items[items.length - 1]}`;
}

export function formatLandingPromoBannerCopy(
  promo: PublicPromoActive,
  locale: SiteLocale
): { badge: string; message: string; cta: string; dismissLabel: string } {
  const monthlyPercent = promo.monthlyDiscountPercent ?? 0;
  const yearlyPercent = promo.yearlyDiscountPercent ?? 0;
  const hasMonthly = monthlyPercent > 0;
  const hasYearly = yearlyPercent > 0;
  const planScope: BannerPlanScope =
    hasMonthly && hasYearly ? 'both' : hasYearly ? 'yearly_only' : 'monthly_only';
  const canUpgradeToYearly = promo.upgradeToYearly && hasYearly;
  const canExpandSeats = promo.seatExpansion && (hasMonthly || hasYearly);
  const endDate = formatShortCampaignEndDate(promo.endsAt, locale);
  const badge = hasYearly
    ? formatYearlyStackBannerBadge(yearlyPercent, locale)
    : formatPublicPromoBadge(monthlyPercent, locale, { isYearly: false });
  const customName = resolvePublicPromoName(promo, locale);
  const yearlyRateZh = formatChineseRate(yearlyPercent);
  const monthlyRateZh = formatChineseRate(monthlyPercent);
  const combinedYearlyRateZh = formatCombinedYearlyChineseRate(yearlyPercent);
  const combinedYearlyOff = formatCombinedYearlyOffPercent(yearlyPercent);

  switch (locale) {
    case 'zh': {
      const scopes = [
        planScope === 'yearly_only'
          ? '首年订阅'
          : planScope === 'monthly_only'
            ? '首月订阅'
            : '首笔订阅',
        ...(canUpgradeToYearly ? ['月转年升级'] : []),
        ...(canExpandSeats
          ? [
              planScope === 'yearly_only'
                ? '年付新增席位'
                : planScope === 'monthly_only'
                  ? '月付新增席位'
                  : '新增成员席位',
            ]
          : []),
      ];
      const discountClause =
        planScope === 'both'
          ? `享年付折上 ${yearlyRateZh} 折（相当于月付 ${combinedYearlyRateZh} 折）、月付 ${monthlyRateZh} 折`
          : planScope === 'yearly_only'
            ? `享年付折上 ${yearlyRateZh} 折（相当于月付 ${combinedYearlyRateZh} 折）`
            : `立享 ${monthlyRateZh} 折`;
      const prefix = customName ? `${customName} · Lody Plus` : 'Lody Plus 限时特惠';
      return {
        badge,
        message: `${prefix}：${joinLocalizedScopes(scopes, '与', '、')}${discountClause} · ${endDate} 截止`,
        cta: '查看定价',
        dismissLabel: '关闭活动提示',
      };
    }
    case 'zh-hant': {
      const scopes = [
        planScope === 'yearly_only'
          ? '首年訂閱'
          : planScope === 'monthly_only'
            ? '首月訂閱'
            : '首筆訂閱',
        ...(canUpgradeToYearly ? ['月轉年升級'] : []),
        ...(canExpandSeats
          ? [
              planScope === 'yearly_only'
                ? '年付新增席位'
                : planScope === 'monthly_only'
                  ? '月付新增席位'
                  : '新增成員席位',
            ]
          : []),
      ];
      const discountClause =
        planScope === 'both'
          ? `享年付折上 ${yearlyRateZh} 折（相當於月付 ${combinedYearlyRateZh} 折）、月付 ${monthlyRateZh} 折`
          : planScope === 'yearly_only'
            ? `享年付折上 ${yearlyRateZh} 折（相當於月付 ${combinedYearlyRateZh} 折）`
            : `立享 ${monthlyRateZh} 折`;
      const prefix = customName ? `${customName} · Lody Plus` : 'Lody Plus 限時特惠';
      return {
        badge,
        message: `${prefix}：${joinLocalizedScopes(scopes, '與', '、')}${discountClause} · ${endDate} 截止`,
        cta: '查看定價',
        dismissLabel: '關閉活動提示',
      };
    }
    case 'ja': {
      const scopes = [
        planScope === 'yearly_only'
          ? '初年度プラン'
          : planScope === 'monthly_only'
            ? '初月プラン'
            : '初回お支払い',
        ...(canUpgradeToYearly ? ['年額へのアップグレード'] : []),
        ...(canExpandSeats
          ? [
              planScope === 'yearly_only'
                ? '年額メンバー追加'
                : planScope === 'monthly_only'
                  ? '月額メンバー追加'
                  : 'メンバー席の追加',
            ]
          : []),
      ];
      const rateLabel =
        planScope === 'both'
          ? `年額さらに ${yearlyPercent}% OFF（月額比 ${combinedYearlyOff}% OFF）・月額 ${monthlyPercent}% OFF`
          : planScope === 'yearly_only'
            ? `年額さらに ${yearlyPercent}% OFF（月額比 ${combinedYearlyOff}% OFF）`
            : `${monthlyPercent}% OFF`;
      const prefix = customName ? `${customName} · Lody Plus` : 'Lody Plus 期間限定セール';
      return {
        badge,
        message: `${prefix}：${scopes.join('・')}が ${rateLabel}（${endDate} まで）`,
        cta: '料金を見る',
        dismissLabel: 'バナーを閉じる',
      };
    }
    case 'ko': {
      const scopes = [
        planScope === 'yearly_only'
          ? '첫 연간 구독'
          : planScope === 'monthly_only'
            ? '첫 월간 구독'
            : '첫 결제',
        ...(canUpgradeToYearly ? ['연간 업그레이드'] : []),
        ...(canExpandSeats
          ? [
              planScope === 'yearly_only'
                ? '연간 좌석 추가'
                : planScope === 'monthly_only'
                  ? '월간 좌석 추가'
                  : '멤버 좌석 추가',
            ]
          : []),
      ];
      const rateLabel =
        planScope === 'both'
          ? `연간 추가 ${yearlyPercent}% 할인(월간 대비 ${combinedYearlyOff}% 할인) · 월간 ${monthlyPercent}% 할인`
          : planScope === 'yearly_only'
            ? `연간 추가 ${yearlyPercent}% 할인(월간 대비 ${combinedYearlyOff}% 할인)`
            : `${monthlyPercent}% 할인`;
      const prefix = customName ? `${customName} · Lody Plus` : 'Lody Plus 기간 한정 혜택';
      return {
        badge,
        message: `${prefix}: ${joinLocalizedScopes(scopes, ' 및 ', ', ')} ${rateLabel} (${endDate} 마감)`,
        cta: '요금 보기',
        dismissLabel: '배너 닫기',
      };
    }
    case 'es': {
      const scopes = [
        planScope === 'yearly_only'
          ? 'tu primer año de Plus'
          : planScope === 'monthly_only'
            ? 'tu primer mes de Plus'
            : 'tu primer pago de Plus',
        ...(canUpgradeToYearly ? ['cambio a plan anual'] : []),
        ...(canExpandSeats
          ? [
              planScope === 'yearly_only'
                ? 'nuevos asientos anuales'
                : planScope === 'monthly_only'
                  ? 'nuevos asientos mensuales'
                  : 'nuevos asientos',
            ]
          : []),
      ];
      const rateLabel =
        planScope === 'both'
          ? `${yearlyPercent}% extra en plan anual (${combinedYearlyOff}% vs. mensual) y ${monthlyPercent}% en mensual`
          : planScope === 'yearly_only'
            ? `${yearlyPercent}% extra en plan anual (${combinedYearlyOff}% vs. mensual)`
            : `${monthlyPercent}% de dto.`;
      return {
        badge,
        message: `${customName ?? 'Oferta limitada'}: ${rateLabel} en ${joinLocalizedScopes(scopes, ' y ')} · Hasta el ${endDate}`,
        cta: 'Ver precios',
        dismissLabel: 'Cerrar aviso',
      };
    }
    case 'fr': {
      const scopes = [
        planScope === 'yearly_only'
          ? 'la 1re année Plus'
          : planScope === 'monthly_only'
            ? 'le 1er mois Plus'
            : 'le 1er paiement Plus',
        ...(canUpgradeToYearly ? ['le passage à l’annuel'] : []),
        ...(canExpandSeats
          ? [
              planScope === 'yearly_only'
                ? 'les nouveaux sièges annuels'
                : planScope === 'monthly_only'
                  ? 'les nouveaux sièges mensuels'
                  : 'les nouveaux sièges',
            ]
          : []),
      ];
      const rateLabel =
        planScope === 'both'
          ? `−${yearlyPercent} % suppl. sur l’annuel (−${combinedYearlyOff} % vs mensuel) et −${monthlyPercent} % sur le mensuel`
          : planScope === 'yearly_only'
            ? `−${yearlyPercent} % suppl. sur l’annuel (−${combinedYearlyOff} % vs mensuel)`
            : `−${monthlyPercent} %`;
      return {
        badge,
        message: `${customName ?? 'Offre limitée'} : ${rateLabel} sur ${joinLocalizedScopes(scopes, ' et ')} · Jusqu’au ${endDate}`,
        cta: 'Voir les tarifs',
        dismissLabel: 'Fermer la bannière',
      };
    }
    case 'ru': {
      const scopes = [
        planScope === 'yearly_only'
          ? 'первый год Plus'
          : planScope === 'monthly_only'
            ? 'первый месяц Plus'
            : 'первый платёж Plus',
        ...(canUpgradeToYearly ? ['переход на годовой план'] : []),
        ...(canExpandSeats
          ? [
              planScope === 'yearly_only'
                ? 'новые годовые места'
                : planScope === 'monthly_only'
                  ? 'новые месячные места'
                  : 'новые места участников',
            ]
          : []),
      ];
      const rateLabel =
        planScope === 'both'
          ? `ещё −${yearlyPercent}% к годовому (−${combinedYearlyOff}% к помесячному) и −${monthlyPercent}% на месячный`
          : planScope === 'yearly_only'
            ? `ещё −${yearlyPercent}% к годовому (−${combinedYearlyOff}% к помесячному)`
            : `скидка ${monthlyPercent}%`;
      return {
        badge,
        message: `${customName ?? 'Акция'}: ${rateLabel} на ${joinLocalizedScopes(scopes, ' и ')} · До ${endDate}`,
        cta: 'Смотреть тарифы',
        dismissLabel: 'Закрыть баннер',
      };
    }
    case 'en':
    default: {
      const scopes = [
        planScope === 'yearly_only'
          ? 'your first Plus annual payment'
          : planScope === 'monthly_only'
            ? 'your first Plus monthly payment'
            : 'your first Plus payment',
        ...(canUpgradeToYearly ? ['monthly-to-yearly upgrades'] : []),
        ...(canExpandSeats
          ? [
              planScope === 'yearly_only'
                ? 'annual seat additions'
                : planScope === 'monthly_only'
                  ? 'monthly seat additions'
                  : 'new member seats',
            ]
          : []),
      ];
      const rateLabel =
        planScope === 'both'
          ? `extra ${yearlyPercent}% off annual (${combinedYearlyOff}% off monthly) & ${monthlyPercent}% off monthly on`
          : planScope === 'yearly_only'
            ? `extra ${yearlyPercent}% off annual (${combinedYearlyOff}% off monthly) on`
            : `${monthlyPercent}% off`;
      return {
        badge,
        message: `${customName ?? 'Limited-time offer'}: ${rateLabel} ${joinLocalizedScopes(scopes, ' & ')} · Ends ${endDate}`,
        cta: 'View pricing',
        dismissLabel: 'Dismiss promotional banner',
      };
    }
  }
}
