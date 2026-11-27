import { localizeSitePath, type SiteLocale } from '@site/src/site-pages/shared';

export type PageLocale = SiteLocale;

export type LegalPageSlug = 'privacy' | 'terms' | 'support' | 'account-deletion';

export const LEGAL_PAGE_SLUGS = [
  'privacy',
  'terms',
  'support',
  'account-deletion',
] as const satisfies readonly LegalPageSlug[];

type PageFrontmatter = {
  title: string;
  description?: string;
  draft?: boolean;
};

export type PageSourceEntry = PageFrontmatter & {
  info: {
    path: string;
  };
};

export type LegalPageEntry = {
  locale: PageLocale;
  slug: LegalPageSlug;
  title: string;
  description?: string;
  url: string;
  docPath: string;
};

function getSlug(entry: PageSourceEntry): string {
  return entry.info.path.replace(/\.(md|mdx)$/u, '').replace(/\/index$/u, '');
}

function isLegalSlug(value: string): value is LegalPageSlug {
  return (LEGAL_PAGE_SLUGS as readonly string[]).includes(value);
}

export function normalizeLegalPages(
  locale: PageLocale,
  entries: PageSourceEntry[]
): LegalPageEntry[] {
  const normalized: LegalPageEntry[] = [];

  for (const entry of entries) {
    if (entry.draft === true) continue;
    const slug = getSlug(entry);
    if (!isLegalSlug(slug)) continue;

    normalized.push({
      locale,
      slug,
      title: entry.title,
      description: entry.description,
      url: localizeSitePath(`/${slug}`, locale),
      docPath: entry.info.path,
    });
  }

  return normalized;
}
