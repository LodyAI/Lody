import { ChangelogDetailPage, ChangelogIndexPage } from '@site/components/changelog';
import type { ChangelogEntry, ChangelogLocale } from '@site/lib/changelog';
import { brandTitle, pageHead } from '@site/lib/metadata';
import type { SiteHead } from '@site/lib/metadata';
import { type ChangelogPostRouteData, localeCode } from './shared';

export function changelogIndexHead(locale: ChangelogLocale): SiteHead {
  return pageHead({
    title: brandTitle(locale === 'zh' ? '更新日志' : 'Changelog'),
    description:
      locale === 'zh'
        ? '追踪 Lody 的产品更新、改进和修复。'
        : 'Track product updates, improvements, and fixes released across Lody.',
    path: locale === 'zh' ? '/zh/changelog' : '/changelog',
    locale: localeCode(locale),
    alternates: [
      { lang: 'en-US', path: '/changelog' },
      { lang: 'zh-CN', path: '/zh/changelog' },
    ],
  });
}

export function ChangelogIndexRoutePage({
  entries,
  locale,
}: {
  entries: ChangelogEntry[];
  locale: ChangelogLocale;
}) {
  return <ChangelogIndexPage entries={entries} locale={locale} />;
}

export function changelogPostHead(locale: ChangelogLocale, data: ChangelogPostRouteData): SiteHead {
  const { entry } = data;
  const enPath = `/changelog/${entry.slug}`;

  return pageHead({
    title: brandTitle(entry.title),
    description: entry.description ?? `Lody ${entry.version} release notes.`,
    path: entry.url,
    locale: localeCode(locale),
    type: 'article',
    publishedTime: entry.date,
    alternates: [
      { lang: 'en-US', path: enPath },
      { lang: 'zh-CN', path: `/zh${enPath}` },
    ],
  });
}

export function ChangelogPostRoutePage({
  data,
  locale,
}: {
  data: ChangelogPostRouteData;
  locale: ChangelogLocale;
}) {
  return (
    <ChangelogDetailPage entry={data.entry} newer={data.newer} older={data.older} locale={locale} />
  );
}
