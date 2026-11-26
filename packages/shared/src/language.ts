export const SUPPORTED_LANGUAGES = [
  'en',
  'zh_CN',
  'zh_Hant',
  'ja',
  'ko',
  'es',
  'fr',
  'ru',
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const SITE_LOCALE_PREFIX_BY_LANGUAGE: Record<SupportedLanguage, string> = {
  en: '',
  zh_CN: '/zh',
  zh_Hant: '/zh-hant',
  ja: '/ja',
  ko: '/ko',
  es: '/es',
  fr: '/fr',
  ru: '/ru',
};

export const BCP47_BY_LANGUAGE: Record<SupportedLanguage, string> = {
  en: 'en',
  zh_CN: 'zh-CN',
  zh_Hant: 'zh-Hant',
  ja: 'ja',
  ko: 'ko',
  es: 'es',
  fr: 'fr',
  ru: 'ru',
};

export type PushLanguage = 'en' | 'zh' | 'zh-Hant' | 'ja' | 'ko' | 'es' | 'fr' | 'ru';

export const PUSH_LANGUAGE_BY_SUPPORTED: Record<SupportedLanguage, PushLanguage> = {
  en: 'en',
  zh_CN: 'zh',
  zh_Hant: 'zh-Hant',
  ja: 'ja',
  ko: 'ko',
  es: 'es',
  fr: 'fr',
  ru: 'ru',
};

const TRADITIONAL_CHINESE_SUBTAGS = new Set(['hant', 'tw', 'hk', 'mo']);

const BASE_SUBTAG_TO_SUPPORTED: Partial<Record<string, SupportedLanguage>> = {
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  es: 'es',
  fr: 'fr',
  ru: 'ru',
};

const SUPPORTED_LANGUAGE_SET = new Set<string>(SUPPORTED_LANGUAGES);

/**
 * Map a BCP-47 tag (or underscore-separated POSIX locale such as `zh_TW` or
 * `zh_CN`) to a supported Lody language. Distinguishes Traditional Chinese
 * (`zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO`) from Simplified Chinese (`zh`,
 * `zh-Hans`, `zh-CN`, `zh-SG`, and other `zh-*` tags).
 */
export function bcp47ToSupportedLanguage(tag: string | null | undefined): SupportedLanguage | null {
  if (typeof tag !== 'string') {
    return null;
  }
  const normalized = tag.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const parts = normalized.split(/[-_]/).filter(Boolean);
  const base = parts[0];
  if (!base) {
    return null;
  }
  if (base === 'zh') {
    for (let index = 1; index < parts.length; index++) {
      if (TRADITIONAL_CHINESE_SUBTAGS.has(parts[index]!)) {
        return 'zh_Hant';
      }
    }
    return 'zh_CN';
  }
  return BASE_SUBTAG_TO_SUPPORTED[base] ?? null;
}

/**
 * Accept exact supported codes (`en`, `zh_CN`, `zh_Hant`, `ja`, `ko`, `es`,
 * `fr`, `ru`) and normalize BCP-47 aliases (`zh-Hant`, `zh-CN`, `zh-TW`,
 * `en-US`, etc.) to their canonical `SupportedLanguage`.
 */
export function normalizeSupportedLanguage(value: unknown): SupportedLanguage | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (SUPPORTED_LANGUAGE_SET.has(trimmed)) {
    return trimmed as SupportedLanguage;
  }
  return bcp47ToSupportedLanguage(trimmed);
}

export function toSiteLocalePrefix(language: string | null | undefined): string {
  const supported = normalizeSupportedLanguage(language) ?? 'en';
  return SITE_LOCALE_PREFIX_BY_LANGUAGE[supported];
}

export function toBcp47Language(language: string | null | undefined): string {
  const supported = normalizeSupportedLanguage(language) ?? 'en';
  return BCP47_BY_LANGUAGE[supported];
}

export function toPushLanguage(language: string | null | undefined): PushLanguage {
  const supported = normalizeSupportedLanguage(language) ?? 'en';
  return PUSH_LANGUAGE_BY_SUPPORTED[supported];
}
