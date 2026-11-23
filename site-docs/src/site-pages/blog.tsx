import { BlogIndexPage, BlogPostPage } from '@site/components/blog';
import type { BlogEntry, BlogLocale } from '@site/lib/blog';
import { brandTitle, pageHead } from '@site/lib/metadata';
import type { SiteHead } from '@site/lib/metadata';
import { localeCode } from './shared';

const SITE_URL = 'https://lody.ai';

const indexCopy = {
  en: {
    title: 'Blog',
    description: 'Product announcements, engineering notes, and stories from the Lody team.',
    feedTitle: 'Lody Blog',
    feedPath: '/rss.xml',
    path: '/blog',
  },
  zh: {
    title: '博客',
    description: '来自 Lody 团队的产品发布、工程实践与故事。',
    feedTitle: 'Lody 博客',
    feedPath: '/rss-zh.xml',
    path: '/zh/blog',
  },
} as const;

/** Matches the canonical directory form emitted by `pageHead`. */
function absolute(path: string): string {
  const url = new URL(path, SITE_URL);
  if (url.pathname !== '/' && !url.pathname.endsWith('/') && !/\.[^/]+$/u.test(url.pathname)) {
    url.pathname += '/';
  }
  return url.toString();
}

function feedLink(locale: BlogLocale) {
  return {
    rel: 'alternate',
    type: 'application/rss+xml',
    title: indexCopy[locale].feedTitle,
    href: absolute(indexCopy[locale].feedPath),
  };
}

export function blogIndexHead(locale: BlogLocale, entries: BlogEntry[] = []): SiteHead {
  const text = indexCopy[locale];

  return pageHead({
    title: brandTitle(text.title),
    description: text.description,
    path: text.path,
    locale: localeCode(locale),
    alternates: [
      { lang: 'en-US', path: '/blog' },
      { lang: 'zh-CN', path: '/zh/blog' },
    ],
    links: [feedLink(locale)],
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Blog',
      name: text.feedTitle,
      description: text.description,
      url: absolute(text.path),
      inLanguage: localeCode(locale),
      blogPost: entries.map((entry) => ({
        '@type': 'BlogPosting',
        headline: entry.title,
        url: absolute(entry.url),
        ...(entry.date ? { datePublished: entry.date } : {}),
        ...(entry.description ? { description: entry.description } : {}),
      })),
    },
  });
}

export function BlogIndexRoutePage({
  entries,
  locale,
}: {
  entries: BlogEntry[];
  locale: BlogLocale;
}) {
  return <BlogIndexPage entries={entries} locale={locale} />;
}

export function blogPostHead(locale: BlogLocale, data: BlogEntry): SiteHead {
  return pageHead({
    title: brandTitle(data.title),
    description: data.description,
    path: data.url,
    locale: localeCode(locale),
    type: 'article',
    publishedTime: data.date,
    image: data.image,
    alternates: [
      { lang: 'en-US', path: `/blog/${data.slug}` },
      { lang: 'zh-CN', path: `/zh/blog/${data.slug}` },
    ],
    links: [feedLink(locale)],
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: data.title,
      url: absolute(data.url),
      mainEntityOfPage: absolute(data.url),
      inLanguage: localeCode(locale),
      ...(data.description ? { description: data.description } : {}),
      ...(data.date ? { datePublished: data.date } : {}),
      ...(data.image ? { image: absolute(data.image) } : {}),
      ...(data.tag ? { articleSection: data.tag } : {}),
      author: {
        '@type': data.author === undefined ? 'Organization' : 'Person',
        name: data.author ?? 'Lody',
        ...(data.authorLink ? { url: data.authorLink } : {}),
      },
      publisher: {
        '@type': 'Organization',
        name: 'Lody',
        url: SITE_URL,
      },
    },
  });
}

export function BlogPostRoutePage({
  locale,
  entry,
  previous,
  next,
}: {
  locale: BlogLocale;
  entry: BlogEntry;
  previous?: BlogEntry;
  next?: BlogEntry;
}) {
  return <BlogPostPage entry={entry} locale={locale} next={next} previous={previous} />;
}
