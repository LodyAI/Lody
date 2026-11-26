/**
 * Route/page adapter primitives shared by every `src/site-pages/*` module.
 *
 * This module must stay FREE of page-component imports. The sibling modules are
 * split per domain precisely so that a route only pulls in the pages it renders;
 * anything imported here lands in the common chunk that every route pays for.
 *
 * The route-data types live here rather than beside their page modules so the
 * server-fn loaders (`src/docs-loader.ts`, `src/changelog-loader.ts`) can name
 * them without importing a module that drags in Fumadocs' docs layout. Today
 * those loaders use `import type`, which erases — keeping the types here means
 * the boundary survives someone dropping the `type` keyword later.
 */

import type { ChangelogEntry } from '@site/lib/changelog';
import type { SerializedPageTree } from 'fumadocs-core/source/client';
import type { TOCItemType } from 'fumadocs-core/toc';

export const SITE_LOCALES = ['en', 'zh', 'zh-hant', 'ja', 'ko', 'es', 'fr', 'ru'] as const;
export type SiteLocale = (typeof SITE_LOCALES)[number];
export type SiteBcp47Locale = 'en-US' | 'zh-CN' | 'zh-Hant' | 'ja' | 'ko' | 'es' | 'fr' | 'ru';

export const SITE_LOCALE_META: Record<
  SiteLocale,
  {
    locale: SiteLocale;
    prefix: string;
    bcp47: SiteBcp47Locale;
    htmlLang: string;
    ogLocale: string;
    label: string;
  }
> = {
  en: {
    locale: 'en',
    prefix: '',
    bcp47: 'en-US',
    htmlLang: 'en',
    ogLocale: 'en_US',
    label: 'English',
  },
  zh: {
    locale: 'zh',
    prefix: '/zh',
    bcp47: 'zh-CN',
    htmlLang: 'zh-CN',
    ogLocale: 'zh_CN',
    label: '简体中文',
  },
  'zh-hant': {
    locale: 'zh-hant',
    prefix: '/zh-hant',
    bcp47: 'zh-Hant',
    htmlLang: 'zh-Hant',
    ogLocale: 'zh_TW',
    label: '繁體中文',
  },
  ja: {
    locale: 'ja',
    prefix: '/ja',
    bcp47: 'ja',
    htmlLang: 'ja',
    ogLocale: 'ja_JP',
    label: '日本語',
  },
  ko: {
    locale: 'ko',
    prefix: '/ko',
    bcp47: 'ko',
    htmlLang: 'ko',
    ogLocale: 'ko_KR',
    label: '한국어',
  },
  es: {
    locale: 'es',
    prefix: '/es',
    bcp47: 'es',
    htmlLang: 'es',
    ogLocale: 'es_ES',
    label: 'Español',
  },
  fr: {
    locale: 'fr',
    prefix: '/fr',
    bcp47: 'fr',
    htmlLang: 'fr',
    ogLocale: 'fr_FR',
    label: 'Français',
  },
  ru: {
    locale: 'ru',
    prefix: '/ru',
    bcp47: 'ru',
    htmlLang: 'ru',
    ogLocale: 'ru_RU',
    label: 'Русский',
  },
};

// Sort prefixed locales longest-first so `/zh-hant` is matched before `/zh`.
const PREFIXED_LOCALES: readonly SiteLocale[] = SITE_LOCALES.filter(
  (locale) => SITE_LOCALE_META[locale].prefix.length > 0
).sort((a, b) => SITE_LOCALE_META[b].prefix.length - SITE_LOCALE_META[a].prefix.length);

export type SerializedTocItem = Omit<TOCItemType, 'title'> & {
  title: string;
};

export type DocsRouteData = {
  title: string;
  description?: string;
  path: string;
  docPath: string;
  pageTree: SerializedPageTree;
  toc: SerializedTocItem[];
  slug?: string[];
};

export type ChangelogPostRouteData = {
  entry: ChangelogEntry;
  newer?: ChangelogEntry;
  older?: ChangelogEntry;
};

export function localeCode(locale: SiteLocale): SiteBcp47Locale {
  return SITE_LOCALE_META[locale].bcp47;
}

export function localePrefix(locale: SiteLocale): string {
  return SITE_LOCALE_META[locale].prefix;
}

export function htmlLangForLocale(locale: SiteLocale): string {
  return SITE_LOCALE_META[locale].htmlLang;
}

export function ogLocaleForLocale(locale: SiteLocale): string {
  return SITE_LOCALE_META[locale].ogLocale;
}

export function localizeSitePath(enPath: string, locale: SiteLocale): string {
  const trimmed = enPath.replace(/^\/+|\/+$/gu, '');
  const normalized = trimmed.length === 0 ? '/' : `/${trimmed}`;
  const prefix = SITE_LOCALE_META[locale].prefix;
  if (!prefix) return normalized;
  return normalized === '/' ? prefix : `${prefix}${normalized}`;
}

export function detectSiteLocaleFromPath(pathname: string): SiteLocale {
  for (const locale of PREFIXED_LOCALES) {
    const { prefix } = SITE_LOCALE_META[locale];
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return locale;
    }
  }
  return 'en';
}

export function switchSiteLocalePath(pathname: string, targetLocale: SiteLocale): string {
  const currentLocale = detectSiteLocaleFromPath(pathname);
  const currentPrefix = SITE_LOCALE_META[currentLocale].prefix;
  const rest = currentPrefix ? pathname.slice(currentPrefix.length) : pathname;
  const canonicalRest = rest === '/home' || rest === '/home/' || rest.length === 0 ? '/' : rest;
  return localizeSitePath(canonicalRest, targetLocale);
}

export function buildLocaleAlternates(
  enPath: string
): Array<{ lang: SiteBcp47Locale; path: string }> {
  return SITE_LOCALES.map((locale) => ({
    lang: localeCode(locale),
    path: localizeSitePath(enPath, locale),
  }));
}
