import {
  pagesEn,
  pagesEs,
  pagesFr,
  pagesJa,
  pagesKo,
  pagesRu,
  pagesZh,
  pagesZhHant,
} from '@site/.source/server';
import {
  normalizeLegalPages,
  type LegalPageEntry,
  type LegalPageSlug,
  type PageLocale,
  type PageSourceEntry,
} from './pages';

const rawPagesByLocale: Record<PageLocale, PageSourceEntry[]> = {
  en: pagesEn as PageSourceEntry[],
  zh: pagesZh as PageSourceEntry[],
  'zh-hant': pagesZhHant as PageSourceEntry[],
  ja: pagesJa as PageSourceEntry[],
  ko: pagesKo as PageSourceEntry[],
  es: pagesEs as PageSourceEntry[],
  fr: pagesFr as PageSourceEntry[],
  ru: pagesRu as PageSourceEntry[],
};

function getRawPages(locale: PageLocale): PageSourceEntry[] {
  return rawPagesByLocale[locale];
}

export function getLegalPages(locale: PageLocale): LegalPageEntry[] {
  return normalizeLegalPages(locale, getRawPages(locale));
}

export function getLegalPage(locale: PageLocale, slug: LegalPageSlug): LegalPageEntry | undefined {
  return getLegalPages(locale).find((entry) => entry.slug === slug);
}
