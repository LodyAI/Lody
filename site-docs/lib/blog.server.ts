import {
  blogEn,
  blogEs,
  blogFr,
  blogJa,
  blogKo,
  blogRu,
  blogZh,
  blogZhHant,
} from '@site/.source/server';
import {
  normalizeBlogEntries,
  type BlogEntry,
  type BlogLocale,
  type BlogSourceEntry,
} from './blog';

const rawBlogEntriesByLocale: Record<BlogLocale, BlogSourceEntry[]> = {
  en: blogEn as BlogSourceEntry[],
  zh: blogZh as BlogSourceEntry[],
  'zh-hant': blogZhHant as BlogSourceEntry[],
  ja: blogJa as BlogSourceEntry[],
  ko: blogKo as BlogSourceEntry[],
  es: blogEs as BlogSourceEntry[],
  fr: blogFr as BlogSourceEntry[],
  ru: blogRu as BlogSourceEntry[],
};

function getRawBlogEntries(locale: BlogLocale): BlogSourceEntry[] {
  return rawBlogEntriesByLocale[locale];
}

export function getBlogEntries(locale: BlogLocale): BlogEntry[] {
  return normalizeBlogEntries(locale, getRawBlogEntries(locale));
}

export function getBlogEntry(
  locale: BlogLocale,
  slugSegments: string[] | string
): BlogEntry | undefined {
  const slug = Array.isArray(slugSegments) ? slugSegments.join('/') : slugSegments;
  return getBlogEntries(locale).find((entry) => entry.slug === slug);
}
