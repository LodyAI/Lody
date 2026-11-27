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
import { localizeSitePath, type SiteLocale } from '@site/src/site-pages/shared';
import type { MDXComponents } from 'mdx/types';

type ChangelogCopy = {
  eyebrow: string;
  title: string;
  lead: string;
  latestLabel: string;
  latestTag: string;
  releaseCount: (n: number) => string;
  permalink: string;
  back: string;
  newer: string;
  older: string;
};

const copy: Record<SiteLocale, ChangelogCopy> = {
  en: {
    eyebrow: 'Product updates',
    title: 'Changelog',
    lead: 'Every release, improvement, and fix shipped to Lody.',
    latestLabel: 'latest',
    latestTag: 'Latest',
    releaseCount: (n: number) => `${n} release${n === 1 ? '' : 's'}`,
    permalink: 'Read the full release notes',
    back: 'All releases',
    newer: 'Newer release',
    older: 'Older release',
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
    newer: '更新的版本',
    older: '更早的版本',
  },
  'zh-hant': {
    eyebrow: '產品動態',
    title: '更新日誌',
    lead: 'Lody 的每一次發佈、改進與修正。',
    latestLabel: '最新',
    latestTag: '最新',
    releaseCount: (n: number) => `${n} 個版本`,
    permalink: '查看完整更新說明',
    back: '所有版本',
    newer: '較新版本',
    older: '較早版本',
  },
  ja: {
    eyebrow: '製品アップデート',
    title: '更新履歴',
    lead: 'Lody に届けられたすべてのリリース、改善、修正。',
    latestLabel: '最新',
    latestTag: '最新',
    releaseCount: (n: number) => `${n} 件のリリース`,
    permalink: 'リリースノート全文を読む',
    back: 'すべてのリリース',
    newer: '新しいリリース',
    older: '以前のリリース',
  },
  ko: {
    eyebrow: '제품 업데이트',
    title: '변경 로그',
    lead: 'Lody에 반영된 모든 릴리스, 개선 사항 및 버그 수정.',
    latestLabel: '최신',
    latestTag: '최신',
    releaseCount: (n: number) => `릴리스 ${n}개`,
    permalink: '전체 릴리스 노트 보기',
    back: '모든 릴리스',
    newer: '최신 릴리스',
    older: '이전 릴리스',
  },
  es: {
    eyebrow: 'Actualizaciones de producto',
    title: 'Novedades',
    lead: 'Cada lanzamiento, mejora y corrección enviada a Lody.',
    latestLabel: 'última',
    latestTag: 'Última',
    releaseCount: (n: number) => `${n} lanzamiento${n === 1 ? '' : 's'}`,
    permalink: 'Leer las notas completas de la versión',
    back: 'Todas las versiones',
    newer: 'Versión más reciente',
    older: 'Versión anterior',
  },
  fr: {
    eyebrow: 'Mises à jour produit',
    title: 'Nouveautés',
    lead: 'Chaque version, amélioration et correctif déployé dans Lody.',
    latestLabel: 'dernière',
    latestTag: 'Dernière',
    releaseCount: (n: number) => `${n} version${n === 1 ? '' : 's'}`,
    permalink: 'Lire les notes de version complètes',
    back: 'Toutes les versions',
    newer: 'Version plus récente',
    older: 'Version précédente',
  },
  ru: {
    eyebrow: 'Обновления продукта',
    title: 'История изменений',
    lead: 'Каждый релиз, улучшение и исправление в Lody.',
    latestLabel: 'актуальная',
    latestTag: 'Актуальная',
    releaseCount: (n: number) => {
      const mod10 = n % 10;
      const mod100 = n % 100;
      if (mod10 === 1 && mod100 !== 11) return `${n} релиз`;
      if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} релиза`;
      return `${n} релизов`;
    },
    permalink: 'Читать полные примечания к релизу',
    back: 'Все релизы',
    newer: 'Следующий релиз',
    older: 'Предыдущий релиз',
  },
};

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

const changelogContentLoaders: Record<
  SiteLocale,
  ReturnType<typeof browserCollections.changelogEn.createClientLoader>
> = {
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
  'zh-hant': browserCollections.changelogZhHant.createClientLoader({
    id: 'changelogZhHant',
    component({ default: MDX }) {
      return <MDX components={changelogMdxComponents} />;
    },
  }),
  ja: browserCollections.changelogJa.createClientLoader({
    id: 'changelogJa',
    component({ default: MDX }) {
      return <MDX components={changelogMdxComponents} />;
    },
  }),
  ko: browserCollections.changelogKo.createClientLoader({
    id: 'changelogKo',
    component({ default: MDX }) {
      return <MDX components={changelogMdxComponents} />;
    },
  }),
  es: browserCollections.changelogEs.createClientLoader({
    id: 'changelogEs',
    component({ default: MDX }) {
      return <MDX components={changelogMdxComponents} />;
    },
  }),
  fr: browserCollections.changelogFr.createClientLoader({
    id: 'changelogFr',
    component({ default: MDX }) {
      return <MDX components={changelogMdxComponents} />;
    },
  }),
  ru: browserCollections.changelogRu.createClientLoader({
    id: 'changelogRu',
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
      <SiteNav locale={locale} />
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
  const changelogHref = localizeSitePath('/changelog', locale);

  return (
    <main className="lody-changelog-shell cl-shell marketing-shell">
      <SiteNav locale={locale} />
      <article className="cl-detail">
        <SiteAnchor className="cl-back" href={changelogHref}>
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
