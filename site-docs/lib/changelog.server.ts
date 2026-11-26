import {
  changelogEn,
  changelogEs,
  changelogFr,
  changelogJa,
  changelogKo,
  changelogRu,
  changelogZh,
  changelogZhHant,
} from '@site/.source/server';
import {
  normalizeChangelogEntries,
  type ChangelogEntry,
  type ChangelogLocale,
  type ChangelogSourceEntry,
} from './changelog';

const rawChangelogEntriesByLocale: Record<ChangelogLocale, ChangelogSourceEntry[]> = {
  en: changelogEn as ChangelogSourceEntry[],
  zh: changelogZh as ChangelogSourceEntry[],
  'zh-hant': changelogZhHant as ChangelogSourceEntry[],
  ja: changelogJa as ChangelogSourceEntry[],
  ko: changelogKo as ChangelogSourceEntry[],
  es: changelogEs as ChangelogSourceEntry[],
  fr: changelogFr as ChangelogSourceEntry[],
  ru: changelogRu as ChangelogSourceEntry[],
};

function getRawChangelogEntries(locale: ChangelogLocale): ChangelogSourceEntry[] {
  return rawChangelogEntriesByLocale[locale];
}

export function getChangelogEntries(locale: ChangelogLocale): ChangelogEntry[] {
  return normalizeChangelogEntries(locale, getRawChangelogEntries(locale));
}

export function getChangelogEntry(
  locale: ChangelogLocale,
  slug: string
): ChangelogEntry | undefined {
  return getChangelogEntries(locale).find((entry) => entry.slug === slug);
}

// Entries are sorted newest-first, so the preceding index is the newer release.
export function getAdjacentChangelogEntries(
  locale: ChangelogLocale,
  slug: string
): { newer?: ChangelogEntry; older?: ChangelogEntry } {
  const entries = getChangelogEntries(locale);
  const index = entries.findIndex((entry) => entry.slug === slug);
  if (index === -1) return {};
  return { newer: entries[index - 1], older: entries[index + 1] };
}
