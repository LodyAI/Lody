import { LegalPage } from '@site/components/legal-page';
import type { LegalPageEntry, PageLocale } from '@site/lib/pages';
import { pageHead } from '@site/lib/metadata';
import type { SiteHead } from '@site/lib/metadata';
import { buildLocaleAlternates, localeCode } from './shared';

export function legalPageHead(locale: PageLocale, entry: LegalPageEntry): SiteHead {
  return pageHead({
    title: entry.title,
    description: entry.description,
    path: entry.url,
    locale: localeCode(locale),
    alternates: buildLocaleAlternates(`/${entry.slug}`),
  });
}

export function LegalRoutePage({ entry, locale }: { entry: LegalPageEntry; locale: PageLocale }) {
  return <LegalPage entry={entry} locale={locale} />;
}
