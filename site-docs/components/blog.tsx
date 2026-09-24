import { getMDXComponents } from '@site/components/mdx';
import { SiteFooter } from '@site/components/site-footer';
import { SiteNav } from '@site/components/site-nav';
import browserCollections from '@site/.source/browser';
import { formatBlogDate, type BlogEntry, type BlogLocale } from '@site/lib/blog';
import type { ReactNode } from 'react';

const copy = {
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
    languageHref: '/zh/blog',
    indexHref: '/blog',
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
    languageHref: '/blog',
    indexHref: '/zh/blog',
  },
} as const;

function isExternalLink(href: string) {
  return /^(?:[a-z]+:)?\/\//iu.test(href);
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

const blogContentLoaders = {
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
    <a
      href={entry.authorLink}
      key="author"
      rel={external ? 'noreferrer' : undefined}
      target={external ? '_blank' : undefined}
    >
      {entry.author}
    </a>
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
    <a
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
    </a>
  );
}

export function BlogIndexPage({ entries, locale }: { entries: BlogEntry[]; locale: BlogLocale }) {
  const text = copy[locale];
  const [featured, ...rest] = entries;

  return (
    <main className="lody-blog-shell blog-shell">
      <SiteNav locale={locale} languageHref={text.languageHref} />
      <div className="blog-container">
        <header className="blog-masthead">
          <h1 className="blog-masthead__title">{text.title}</h1>
          <p className="blog-masthead__dek">{text.dek}</p>
        </header>

        {featured ? (
          <a className="blog-lead" href={featured.url}>
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
          </a>
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
                  <a className="blog-row" href={entry.url}>
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
                  </a>
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

  return (
    <main className="lody-blog-shell blog-shell">
      <SiteNav
        locale={locale}
        languageHref={locale === 'zh' ? `/blog/${entry.slug}` : `/zh/blog/${entry.slug}`}
      />
      <article className="blog-article">
        <a className="blog-back" href={text.indexHref}>
          <ArrowLeftIcon />
          {text.back}
        </a>

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
