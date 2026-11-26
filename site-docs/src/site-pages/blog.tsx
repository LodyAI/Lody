import { BlogIndexPage, BlogPostPage } from '@site/components/blog';
import type { BlogEntry, BlogLocale } from '@site/lib/blog';
import { brandTitle, pageHead } from '@site/lib/metadata';
import type { SiteHead } from '@site/lib/metadata';
import { buildLocaleAlternates, localeCode, SITE_LOCALES } from './shared';

const SITE_URL = 'https://lody.ai';

const indexCopy: Record<
  BlogLocale,
  {
    title: string;
    description: string;
    feedTitle: string;
    feedPath: string;
    path: string;
  }
> = {
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
  'zh-hant': {
    title: '部落格',
    description: '來自 Lody 團隊的產品發布、工程實踐與故事。',
    feedTitle: 'Lody 部落格',
    feedPath: '/rss-zh-hant.xml',
    path: '/zh-hant/blog',
  },
  ja: {
    title: 'ブログ',
    description: 'Lody チームからの製品発表、エンジニアリングノート、ストーリー。',
    feedTitle: 'Lody ブログ',
    feedPath: '/rss-ja.xml',
    path: '/ja/blog',
  },
  ko: {
    title: '블로그',
    description: 'Lody 팀의 제품 소식, 엔지니어링 노트 및 이야기.',
    feedTitle: 'Lody 블로그',
    feedPath: '/rss-ko.xml',
    path: '/ko/blog',
  },
  es: {
    title: 'Blog',
    description: 'Anuncios de producto, notas de ingeniería e historias del equipo de Lody.',
    feedTitle: 'Blog de Lody',
    feedPath: '/rss-es.xml',
    path: '/es/blog',
  },
  fr: {
    title: 'Blog',
    description: 'Annonces produit, notes d’ingénierie et récits de l’équipe Lody.',
    feedTitle: 'Blog Lody',
    feedPath: '/rss-fr.xml',
    path: '/fr/blog',
  },
  ru: {
    title: 'Блог',
    description: 'Анонсы продуктов, инженерные заметки и истории команды Lody.',
    feedTitle: 'Блог Lody',
    feedPath: '/rss-ru.xml',
    path: '/ru/blog',
  },
};

const blogIndexAlternates = buildLocaleAlternates('/blog');

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

function allFeedLinks(activeLocale: BlogLocale) {
  return [
    feedLink(activeLocale),
    ...SITE_LOCALES.filter((candidate) => candidate !== activeLocale).map(feedLink),
  ];
}

export function blogIndexHead(locale: BlogLocale, entries: BlogEntry[] = []): SiteHead {
  const text = indexCopy[locale];

  return pageHead({
    title: brandTitle(text.title),
    description: text.description,
    path: text.path,
    locale: localeCode(locale),
    alternates: blogIndexAlternates,
    links: allFeedLinks(locale),
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
    alternates: buildLocaleAlternates(`/blog/${data.slug}`),
    links: allFeedLinks(locale),
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
