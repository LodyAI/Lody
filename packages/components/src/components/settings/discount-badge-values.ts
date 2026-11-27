const PROMO_CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/gu;
const MAX_PROMO_NAME_LENGTH = 80;

function sanitizePromoNameText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(PROMO_CONTROL_CHARS_RE, '')
    .trim()
    .slice(0, MAX_PROMO_NAME_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function normalizePromoLocaleKey(raw: string | undefined): string {
  if (!raw) return 'en';
  const lower = raw.trim().toLowerCase().replace(/_/gu, '-');
  if (lower === '') return 'en';
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
  if (lower === 'zh' || lower.startsWith('zh-')) {
    return 'zh';
  }
  return lower.split('-')[0] || 'en';
}

export function discountBadgeValues(discountPercent: number) {
  const rate = Number(((100 - discountPercent) / 10).toFixed(2));
  const combinedDiscount = Number((100 - (80 * (100 - discountPercent)) / 100).toFixed(1));
  const combinedRate = Number(((80 * (100 - discountPercent)) / 1000).toFixed(2));
  return {
    discount: discountPercent,
    rate,
    combinedDiscount,
    combinedRate,
  };
}

export function resolvePromoCampaignName(
  name: string | Record<string, string> | null | undefined,
  language: string | undefined
): string | null {
  if (name === null || name === undefined) return null;
  if (typeof name === 'string') {
    return sanitizePromoNameText(name);
  }
  if (typeof name !== 'object' || Array.isArray(name)) return null;

  const entries = new Map<string, string>();
  let firstNonEmpty: string | null = null;
  for (const [rawKey, rawValue] of Object.entries(name)) {
    const cleaned = sanitizePromoNameText(rawValue);
    if (!cleaned) continue;
    if (firstNonEmpty === null) firstNonEmpty = cleaned;
    const exactKey = rawKey.trim().toLowerCase().replace(/_/gu, '-');
    if (exactKey && !entries.has(exactKey)) {
      entries.set(exactKey, cleaned);
    }
    const normalizedKey = normalizePromoLocaleKey(rawKey);
    if (normalizedKey && !entries.has(normalizedKey)) {
      entries.set(normalizedKey, cleaned);
    }
  }
  if (firstNonEmpty === null) return null;

  const exactTarget = language?.trim().toLowerCase().replace(/_/gu, '-') ?? '';
  if (exactTarget && entries.has(exactTarget)) {
    return entries.get(exactTarget)!;
  }
  const target = normalizePromoLocaleKey(language);
  if (entries.has(target)) return entries.get(target)!;
  if (target === 'zh-hant' && entries.has('zh')) return entries.get('zh')!;
  if (target === 'zh' && entries.has('zh-hant')) return entries.get('zh-hant')!;
  if (entries.has('en')) return entries.get('en')!;
  if (entries.has('default')) return entries.get('default')!;
  return firstNonEmpty;
}
