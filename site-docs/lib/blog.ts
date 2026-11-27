import { localeCode, localizeSitePath, type SiteLocale } from '@site/src/site-pages/shared';
import { blogReadingMinutes } from './blog-reading-time.generated';

export type BlogLocale = SiteLocale;

type BlogFrontmatter = {
  title: string;
  date?: string | Date;
  author?: string;
  authorLink?: string;
  description?: string;
  image?: string;
  tag?: string;
  draft?: boolean;
};

export type BlogSourceEntry = BlogFrontmatter & {
  info: {
    path: string;
  };
};

export type BlogEntry = Omit<BlogFrontmatter, 'date' | 'image'> & {
  /** Estimated read time in minutes, computed from the MDX body at build time. */
  readingMinutes?: number;
  locale: BlogLocale;
  slug: string;
  slugSegments: string[];
  date?: string;
  image?: string;
  url: string;
  docPath: string;
};

function asDateString(value: string | Date | undefined): string | undefined {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (value === undefined || value.length === 0) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/u.exec(value);
  return match?.[1] ?? value;
}

function dateToTimestamp(date?: string): number {
  if (date === undefined || date.length === 0) return Number.NEGATIVE_INFINITY;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (match !== null) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return Date.UTC(year, month - 1, day);
  }

  const parsed = new Date(date).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function getSlug(entry: BlogSourceEntry): string {
  return entry.info.path.replace(/\.(md|mdx)$/u, '').replace(/\/index$/u, '');
}

function normalizeImagePath(image: string | undefined): string | undefined {
  if (image === undefined || image.length === 0) return undefined;
  if (/^(?:[a-z]+:)?\/\//iu.test(image)) return image;
  if (image.startsWith('/_docs-assets/')) return image;
  if (image.startsWith('/')) return `/_docs-assets/${image.slice(1)}`;
  return image;
}

export function normalizeBlogEntries(locale: BlogLocale, entries: BlogSourceEntry[]): BlogEntry[] {
  return entries
    .filter((entry) => entry.draft !== true)
    .map((entry): BlogEntry => {
      const slug = getSlug(entry);
      const slugSegments = slug.split('/').filter((segment) => segment.length > 0);
      const date = asDateString(entry.date);

      return {
        title: entry.title,
        author: entry.author,
        authorLink: entry.authorLink,
        description: entry.description,
        tag: entry.tag,
        draft: entry.draft,
        locale,
        slug,
        slugSegments,
        date,
        image: normalizeImagePath(entry.image),
        readingMinutes: blogReadingMinutes[locale]?.[slug],
        url: localizeSitePath(`/blog/${slug}`, locale),
        docPath: entry.info.path,
      };
    })
    .sort((a, b) => {
      const byDate = dateToTimestamp(b.date) - dateToTimestamp(a.date);
      if (byDate !== 0) return byDate;
      return a.url.localeCompare(b.url);
    });
}

export function formatBlogDate(date: string | undefined, locale: BlogLocale) {
  if (date === undefined || date.length === 0) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (match === null) return date;

  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const useLongMonth =
    locale === 'zh' || locale === 'zh-hant' || locale === 'ja' || locale === 'ko';
  return new Intl.DateTimeFormat(localeCode(locale), {
    year: 'numeric',
    month: useLongMonth ? 'long' : 'short',
    day: 'numeric',
  }).format(parsed);
}
