import { SiteAnchor } from '@site/components/site-anchor';
import { getMDXComponents } from '@site/components/mdx';
import { SiteFooter } from '@site/components/site-footer';
import { SiteNav } from '@site/components/site-nav';
import browserCollections from '@site/.source/browser';
import {
  formatChangelogDate,
  type ChangelogEntry,
  type ChangelogLocale,
} from '@site/lib/changelog';
import type { MDXComponents } from 'mdx/types';

const copy = {
  en: {
    eyebrow: 'Product updates',
    title: 'Changelog',
    lead: 'Every release, improvement, and fix shipped to Lody.',
    latestLabel: 'latest',
    latestTag: 'Latest',
    releaseCount: (n: number) => `${n} release${n === 1 ? '' : 's'}`,
    permalink: 'Read the full release notes',
    back: 'All releases',
    changelogHref: '/changelog',
    newer: 'Newer release',
    older: 'Older release',
    languageHref: '/zh/changelog',
  },
  zh: {
    eyebrow: '产品动态',
    title: '更新日志',
    lead: 'Lody 的每一次发布、改进与修复。',
    latestLabel: '最新',
    latestTag: '最新',
    releaseCount: (n: number) => `${n} 个版本`,
    permalink: '查看完整更新说明',
    back: '全部版本',
    changelogHref: '/zh/changelog',
    newer: '更新的版本',
    older: '更早的版本',
    languageHref: '/changelog',
  },
} as const;

// Changelog content owns its date + version via frontmatter (rendered in the rail), and
// anchor links add docs-only `#` affordances that read as clutter here. Render headings as
// plain elements so `.cl-prose` is the single source of typography.
const changelogMdxComponents: MDXComponents = {
  ...getMDXComponents(),
  h1: (props) => <h2 {...props} />,
  h2: (props) => <h2 {...props} />,
  h3: (props) => <h3 {...props} />,
  h4: (props) => <h4 {...props} />,
};

const changelogContentLoaders = {
  en: browserCollections.changelogEn.createClientLoader({
    id: 'changelogEn',
    component({ default: MDX }) {
      return <MDX components={changelogMdxComponents} />;
    },
  }),
  zh: browserCollections.changelogZh.createClientLoader({
    id: 'changelogZh',
    component({ default: MDX }) {
      return <MDX components={changelogMdxComponents} />;
    },
  }),
};

export async function preloadChangelogContent(locale: ChangelogLocale, docPath: string) {
  await changelogContentLoaders[locale].preload(docPath);
}

export async function preloadChangelogContents(locale: ChangelogLocale, docPaths: string[]) {
  await Promise.all(docPaths.map((docPath) => preloadChangelogContent(locale, docPath)));
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

export function ChangelogIndexPage({
  entries,
  locale,
}: {
  entries: ChangelogEntry[];
  locale: ChangelogLocale;
}) {
  const t = copy[locale];
  const latest = entries[0];
  const lastIndex = entries.length - 1;

  return (
    <main className="lody-changelog-shell cl-shell marketing-shell">
      <SiteNav locale={locale} languageHref={t.languageHref} />
      <div className="cl-container">
        <header className="cl-header">
          <p className="cl-eyebrow mkt-eyebrow">
            <span className="cl-eyebrow-dot mkt-eyebrow-dot" />
            {t.eyebrow}
          </p>
          <h1 className="cl-title mkt-title">{t.title}</h1>
          <p className="cl-lead mkt-lead">{t.lead}</p>
          {latest ? (
            <div className="cl-meta-strip">
              <span className="cl-meta-version">
                <b>v{latest.version}</b>
                <span className="cl-meta-version-label">{t.latestLabel}</span>
              </span>
              <span className="cl-meta-dot" aria-hidden="true" />
              <span className="cl-meta-count">{t.releaseCount(entries.length)}</span>
            </div>
          ) : null}
        </header>

        <ol className="cl-timeline">
          {entries.map((entry, index) => {
            const dateLabel = formatChangelogDate(entry.date, locale) ?? entry.title;

            return (
              <li className="cl-release" key={entry.url}>
                <div className="cl-aside">
                  <time className="cl-date" dateTime={entry.date}>
                    {dateLabel}
                  </time>
                  <SiteAnchor className="cl-version" href={entry.url}>
                    v{entry.version}
                  </SiteAnchor>
                  {index === 0 ? <span className="cl-latest">{t.latestTag}</span> : null}
                </div>
                <div className="cl-rail" aria-hidden="true">
                  <span className={index === 0 ? 'cl-node cl-node--active' : 'cl-node'} />
                  {index < lastIndex ? <span className="cl-rail-line" /> : null}
                </div>
                <div className="cl-body">
                  <div className="cl-prose">
                    {changelogContentLoaders[locale].useContent(entry.docPath)}
                  </div>
                  <SiteAnchor className="cl-permalink" href={entry.url}>
                    {t.permalink}
                    <ArrowRightIcon />
                  </SiteAnchor>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      <SiteFooter locale={locale} />
    </main>
  );
}

export function ChangelogDetailPage({
  entry,
  newer,
  older,
  locale,
}: {
  entry: ChangelogEntry;
  newer?: ChangelogEntry;
  older?: ChangelogEntry;
  locale: ChangelogLocale;
}) {
  const t = copy[locale];
  const dateLabel = formatChangelogDate(entry.date, locale) ?? entry.title;

  return (
    <main className="lody-changelog-shell cl-shell marketing-shell">
      <SiteNav locale={locale} languageHref={`${t.languageHref}/${entry.slug}`} />
      <article className="cl-detail">
        <SiteAnchor className="cl-back" href={t.changelogHref}>
          <ArrowLeftIcon />
          {t.back}
        </SiteAnchor>

        <header className="cl-detail-header">
          <div className="cl-detail-tags">
            <span className="cl-detail-version">v{entry.version}</span>
          </div>
          <h1 className="cl-detail-title">{dateLabel}</h1>
          {entry.description ? <p className="cl-detail-lead">{entry.description}</p> : null}
        </header>

        <div className="cl-prose">{changelogContentLoaders[locale].useContent(entry.docPath)}</div>

        {newer || older ? (
          <nav className="cl-pager">
            {older ? (
              <SiteAnchor className="cl-pager-link" href={older.url}>
                <span className="cl-pager-dir">{t.older}</span>
                <span className="cl-pager-label">
                  {formatChangelogDate(older.date, locale) ?? older.title}
                </span>
                <span className="cl-pager-version">v{older.version}</span>
              </SiteAnchor>
            ) : (
              <span />
            )}
            {newer ? (
              <SiteAnchor className="cl-pager-link cl-pager-link--next" href={newer.url}>
                <span className="cl-pager-dir">{t.newer}</span>
                <span className="cl-pager-label">
                  {formatChangelogDate(newer.date, locale) ?? newer.title}
                </span>
                <span className="cl-pager-version">v{newer.version}</span>
              </SiteAnchor>
            ) : (
              <span />
            )}
          </nav>
        ) : null}
      </article>
      <SiteFooter locale={locale} />
    </main>
  );
}
