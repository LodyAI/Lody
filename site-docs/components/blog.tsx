import { SiteAnchor } from '@site/components/site-anchor';
import { getMDXComponents } from '@site/components/mdx';
import { SiteFooter } from '@site/components/site-footer';
import { SiteNav } from '@site/components/site-nav';
import browserCollections from '@site/.source/browser';
import { formatBlogDate, type BlogEntry, type BlogLocale } from '@site/lib/blog';
import { localizeSitePath, type SiteLocale } from '@site/src/site-pages/shared';
import type { ReactNode } from 'react';

type BlogCopy = {
  title: string;
  dek: string;
  more: string;
  readTime: (minutes: number) => string;
  emptyTitle: string;
  emptyDescription: string;
  back: string;
  read: string;
  adjacent: string;
  older: string;
  newer: string;
};

const copy: Record<SiteLocale, BlogCopy> = {
  en: {
    title: 'Blog',
    dek: 'Product announcements, engineering notes, and stories from the Lody team.',
    more: 'More posts',
    readTime: (minutes: number) => `${minutes} min read`,
    emptyTitle: 'No posts yet',
    emptyDescription: "We're still writing. Check back soon.",
    back: 'Back to blog',
    read: 'Read',
    adjacent: 'More posts',
    older: 'Older post',
    newer: 'Newer post',
  },
  zh: {
    title: '博客',
    dek: '来自 Lody 团队的产品发布、工程实践与故事。',
    more: '更多文章',
    readTime: (minutes: number) => `${minutes} 分钟阅读`,
    emptyTitle: '暂无文章',
    emptyDescription: '我们还在准备内容，稍后再来看看。',
    back: '返回博客',
    read: '阅读',
    adjacent: '更多文章',
    older: '更早的文章',
    newer: '更新的文章',
  },
  'zh-hant': {
    title: '部落格',
    dek: '來自 Lody 團隊的產品公告、工程筆記與故事。',
    more: '更多文章',
    readTime: (minutes: number) => `閱讀約 ${minutes} 分鐘`,
    emptyTitle: '尚無文章',
    emptyDescription: '我們正在撰寫內容，歡迎稍後再來看看。',
    back: '返回部落格',
    read: '閱讀',
    adjacent: '更多文章',
    older: '較早的文章',
    newer: '較新的文章',
  },
  ja: {
    title: 'ブログ',
    dek: 'Lody チームからの製品アップデート、エンジニアリングノート、ストーリー。',
    more: 'その他の記事',
    readTime: (minutes: number) => `読了目安 ${minutes} 分`,
    emptyTitle: '記事はまだありません',
    emptyDescription: '現在執筆中です。また後日お越しください。',
    back: 'ブログ一覧へ戻る',
    read: '読む',
    adjacent: 'その他の記事',
    older: '前の記事',
    newer: '次の記事',
  },
  ko: {
    title: '블로그',
    dek: 'Lody 팀의 제품 소식, 엔지니어링 노트, 그리고 이야기.',
    more: '더 많은 글',
    readTime: (minutes: number) => `${minutes}분 소요`,
    emptyTitle: '아직 게시물이 없습니다',
    emptyDescription: '콘텐츠를 준비 중입니다. 곧 다시 방문해 주세요.',
    back: '블로그로 돌아가기',
    read: '읽기',
    adjacent: '더 많은 글',
    older: '이전 글',
    newer: '다음 글',
  },
  es: {
    title: 'Blog',
    dek: 'Anuncios de producto, notas de ingeniería e historias del equipo de Lody.',
    more: 'Más artículos',
    readTime: (minutes: number) => `${minutes} min de lectura`,
    emptyTitle: 'Aún no hay publicaciones',
    emptyDescription: 'Todavía estamos escribiendo. Vuelve pronto.',
    back: 'Volver al blog',
    read: 'Leer',
    adjacent: 'Más artículos',
    older: 'Artículo anterior',
    newer: 'Artículo más reciente',
  },
  fr: {
    title: 'Blog',
    dek: "Annonces produit, notes d'ingénierie et récits de l'équipe Lody.",
    more: "Plus d'articles",
    readTime: (minutes: number) => `${minutes} min de lecture`,
    emptyTitle: 'Aucun article pour le moment',
    emptyDescription: 'Nous sommes encore en train de rédiger. Revenez bientôt.',
    back: 'Retour au blog',
    read: 'Lire',
    adjacent: "Plus d'articles",
    older: 'Article précédent',
    newer: 'Article suivant',
  },
  ru: {
    title: 'Блог',
    dek: 'Анонсы продуктов, инженерные заметки и истории команды Lody.',
    more: 'Другие публикации',
    readTime: (minutes: number) => `${minutes} мин чтения`,
    emptyTitle: 'Публикаций пока нет',
    emptyDescription: 'Мы ещё готовим материалы. Загляните чуть позже.',
    back: 'Назад к блогу',
    read: 'Читать',
    adjacent: 'Другие публикации',
    older: 'Предыдущая запись',
    newer: 'Следующая запись',
  },
};

function isExternalLink(href: string) {
  return /^(?:[a-z]+:)?\/\//iu.test(href);
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

const blogContentLoaders: Record<
  SiteLocale,
  ReturnType<typeof browserCollections.blogEn.createClientLoader>
> = {
  en: browserCollections.blogEn.createClientLoader({
    id: 'blogEn',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
  zh: browserCollections.blogZh.createClientLoader({
    id: 'blogZh',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
  'zh-hant': browserCollections.blogZhHant.createClientLoader({
    id: 'blogZhHant',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
  ja: browserCollections.blogJa.createClientLoader({
    id: 'blogJa',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
  ko: browserCollections.blogKo.createClientLoader({
    id: 'blogKo',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
  es: browserCollections.blogEs.createClientLoader({
    id: 'blogEs',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
  fr: browserCollections.blogFr.createClientLoader({
    id: 'blogFr',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
  ru: browserCollections.blogRu.createClientLoader({
    id: 'blogRu',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
};

export async function preloadBlogContent(locale: BlogLocale, docPath: string) {
  await blogContentLoaders[locale].preload(docPath);
}

function ArrowRightIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M5 12h14" />
      <path d="m13 5 7 7-7 7" />
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </svg>
  );
}

function MetaDot() {
  return <span aria-hidden="true" className="blog-meta-dot" />;
}

/** Joins meta parts with dots; renders nothing when every part is absent. */
function MetaLine({ className, items }: { className?: string; items: ReactNode[] }) {
  const parts = items.filter((item) => item !== null && item !== undefined);
  if (parts.length === 0) return null;

  return (
    <p className={className === undefined ? 'blog-meta' : `blog-meta ${className}`}>
      {parts.flatMap((item, index) =>
        index === 0 ? [item] : [<MetaDot key={`dot-${index}`} />, item]
      )}
    </p>
  );
}

function dateItem(entry: BlogEntry, locale: BlogLocale): ReactNode {
  const label = formatBlogDate(entry.date, locale);
  if (!hasText(entry.date) || !hasText(label)) return null;
  return (
    <time dateTime={entry.date} key="date">
      {label}
    </time>
  );
}

function authorItem(entry: BlogEntry, linked = true): ReactNode {
  if (!hasText(entry.author)) return null;
  if (!linked || !hasText(entry.authorLink)) return <span key="author">{entry.author}</span>;

  const external = isExternalLink(entry.authorLink);
  return (
    <SiteAnchor
      href={entry.authorLink}
      key="author"
      rel={external ? 'noreferrer' : undefined}
      target={external ? '_blank' : undefined}
    >
      {entry.author}
    </SiteAnchor>
  );
}

function tagItem(entry: BlogEntry): ReactNode {
  return hasText(entry.tag) ? <span key="tag">{entry.tag}</span> : null;
}

function readTimeItem(entry: BlogEntry, locale: BlogLocale): ReactNode {
  const minutes = entry.readingMinutes;
  if (minutes === undefined || minutes <= 0) return null;
  return <span key="read">{copy[locale].readTime(minutes)}</span>;
}

/**
 * Cover art is always redundant with the adjacent headline, so it carries an
 * empty alt rather than repeating the title to screen readers.
 */
function BlogCover({
  src,
  className,
  eager = false,
}: {
  src: string;
  className: string;
  eager?: boolean;
}) {
  return (
    <img
      alt=""
      className={className}
      decoding="async"
      loading={eager ? 'eager' : 'lazy'}
      src={src}
    />
  );
}

function AdjacentLink({
  entry,
  label,
  direction,
}: {
  entry: BlogEntry;
  label: string;
  direction: 'previous' | 'next';
}) {
  return (
    <SiteAnchor
      className={`blog-adjacent__link blog-adjacent__link--${direction}`}
      href={entry.url}
      rel={direction === 'previous' ? 'prev' : 'next'}
    >
      <span className="blog-adjacent__label">
        {direction === 'previous' ? <ArrowLeftIcon /> : null}
        {label}
        {direction === 'next' ? <ArrowRightIcon /> : null}
      </span>
      <span className="blog-adjacent__title">{entry.title}</span>
    </SiteAnchor>
  );
}

export function BlogIndexPage({ entries, locale }: { entries: BlogEntry[]; locale: BlogLocale }) {
  const text = copy[locale];
  const [featured, ...rest] = entries;

  return (
    <main className="lody-blog-shell blog-shell">
      <SiteNav locale={locale} />
      <div className="blog-container">
        <header className="blog-masthead">
          <h1 className="blog-masthead__title">{text.title}</h1>
          <p className="blog-masthead__dek">{text.dek}</p>
        </header>

        {featured ? (
          <SiteAnchor className="blog-lead" href={featured.url}>
            <MetaLine className="blog-lead__date" items={[dateItem(featured, locale)]} />
            <div className="blog-lead__body">
              <h2 className="blog-lead__title">{featured.title}</h2>
              {hasText(featured.description) ? (
                <p className="blog-lead__dek">{featured.description}</p>
              ) : null}
              <MetaLine
                className="blog-lead__byline"
                items={[
                  tagItem(featured),
                  authorItem(featured, false),
                  readTimeItem(featured, locale),
                ]}
              />
              <span className="blog-lead__read">
                {text.read}
                <ArrowRightIcon />
              </span>
              {hasText(featured.image) ? (
                <BlogCover className="blog-lead__cover" eager src={featured.image} />
              ) : null}
            </div>
          </SiteAnchor>
        ) : (
          <section className="blog-empty">
            <h2>{text.emptyTitle}</h2>
            <p>{text.emptyDescription}</p>
          </section>
        )}

        {rest.length > 0 ? (
          <section className="blog-more">
            <h2 className="blog-section-label">{text.more}</h2>
            <ol className="blog-list">
              {rest.map((entry) => (
                <li key={entry.url}>
                  <SiteAnchor className="blog-row" href={entry.url}>
                    <MetaLine className="blog-row__date" items={[dateItem(entry, locale)]} />
                    <div className="blog-row__body">
                      <h3 className="blog-row__title">{entry.title}</h3>
                      {hasText(entry.description) ? (
                        <p className="blog-row__dek">{entry.description}</p>
                      ) : null}
                      <MetaLine
                        className="blog-row__meta"
                        items={[tagItem(entry), readTimeItem(entry, locale)]}
                      />
                    </div>
                  </SiteAnchor>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>
      <SiteFooter locale={locale} />
    </main>
  );
}

export function BlogPostPage({
  entry,
  locale,
  previous,
  next,
}: {
  entry: BlogEntry;
  locale: BlogLocale;
  previous?: BlogEntry;
  next?: BlogEntry;
}) {
  const text = copy[locale];
  const indexHref = localizeSitePath('/blog', locale);

  return (
    <main className="lody-blog-shell blog-shell">
      <SiteNav locale={locale} />
      <article className="blog-article">
        <SiteAnchor className="blog-back" href={indexHref}>
          <ArrowLeftIcon />
          {text.back}
        </SiteAnchor>

        <header className="blog-article-header">
          <MetaLine
            className="blog-article-meta"
            items={[
              dateItem(entry, locale),
              authorItem(entry),
              tagItem(entry),
              readTimeItem(entry, locale),
            ]}
          />
          <h1 className="blog-article-title">{entry.title}</h1>
          {hasText(entry.description) ? (
            <p className="blog-article-dek">{entry.description}</p>
          ) : null}
        </header>

        {hasText(entry.image) ? (
          <BlogCover className="blog-article-cover" eager src={entry.image} />
        ) : null}

        <div className="blog-prose">{blogContentLoaders[locale].useContent(entry.docPath)}</div>

        {previous || next ? (
          <nav aria-label={text.adjacent} className="blog-adjacent">
            {previous ? (
              <AdjacentLink direction="previous" entry={previous} label={text.older} />
            ) : null}
            {next ? <AdjacentLink direction="next" entry={next} label={text.newer} /> : null}
          </nav>
        ) : null}
      </article>
      <SiteFooter locale={locale} />
    </main>
  );
}
