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
    title: 'Blog — AI Coding Agent Workflows & Engineering',
    description:
      'Engineering guides, product updates, and team workflows for running Claude Code, Codex, and ACP AI coding agents in parallel with Lody.',
    feedTitle: 'Lody Blog',
    feedPath: '/rss.xml',
    path: '/blog',
  },
  zh: {
    title: '博客 — AI 编程 Agent 工程实践与团队协作',
    description:
      '来自 Lody 团队的 AI 编程 Agent 工程实践、Claude Code / Codex 并行协作指南与产品发布故事。',
    feedTitle: 'Lody 博客',
    feedPath: '/rss-zh.xml',
    path: '/zh/blog',
  },
  'zh-hant': {
    title: '部落格 — AI 程式設計 Agent 工程實踐與團隊協作',
    description:
      '來自 Lody 團隊的 AI 程式設計 Agent 工程實踐、Claude Code / Codex 並行協作指南與產品發布故事。',
    feedTitle: 'Lody 部落格',
    feedPath: '/rss-zh-hant.xml',
    path: '/zh-hant/blog',
  },
  ja: {
    title: 'ブログ — AI コーディングエージェント活用と開発ノート',
    description:
      'Lody チームによる Claude Code・Codex 並列開発ワークフロー、エンジニアリングノート、製品アップデートの記事一覧。',
    feedTitle: 'Lody ブログ',
    feedPath: '/rss-ja.xml',
    path: '/ja/blog',
  },
  ko: {
    title: '블로그 — AI 코딩 에이전트 워크플로와 엔지니어링',
    description:
      'Lody 팀의 Claude Code·Codex 병렬 개발 워크플로, 엔지니어링 노트, 제품 출시 소식을 확인하세요.',
    feedTitle: 'Lody 블로그',
    feedPath: '/rss-ko.xml',
    path: '/ko/blog',
  },
  es: {
    title: 'Blog — Flujos de agentes de código IA e ingeniería',
    description:
      'Guías prácticas, notas de ingeniería y lanzamientos del equipo de Lody sobre Claude Code, Codex y agentes de código IA en paralelo.',
    feedTitle: 'Blog de Lody',
    feedPath: '/rss-es.xml',
    path: '/es/blog',
  },
  fr: {
    title: 'Blog — Agents de code IA et ingénierie produit',
    description:
      'Guides pratiques, notes d’ingénierie et annonces produit de l’équipe Lody autour de Claude Code, Codex et des agents de code IA en parallèle.',
    feedTitle: 'Blog Lody',
    feedPath: '/rss-fr.xml',
    path: '/fr/blog',
  },
  ru: {
    title: 'Блог — Рабочие процессы ИИ-агентов и инженерия',
    description:
      'Практические руководства, инженерные заметки и анонсы команды Lody о параллельной работе с Claude Code, Codex и ACP ИИ-агентами.',
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
