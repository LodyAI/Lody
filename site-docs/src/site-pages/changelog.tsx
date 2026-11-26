import { ChangelogDetailPage, ChangelogIndexPage } from '@site/components/changelog';
import type { ChangelogEntry, ChangelogLocale } from '@site/lib/changelog';
import { brandTitle, pageHead } from '@site/lib/metadata';
import type { SiteHead } from '@site/lib/metadata';
import {
  buildLocaleAlternates,
  localeCode,
  localizeSitePath,
  type ChangelogPostRouteData,
} from './shared';

const changelogCopy: Record<
  ChangelogLocale,
  {
    title: string;
    description: string;
    releaseNotesFallback: (version: string) => string;
  }
> = {
  en: {
    title: 'Changelog',
    description: 'Track product updates, improvements, and fixes released across Lody.',
    releaseNotesFallback: (version) => `Lody ${version} release notes.`,
  },
  zh: {
    title: '更新日志',
    description: '追踪 Lody 的产品更新、改进和修复。',
    releaseNotesFallback: (version) => `Lody ${version} 版本更新说明。`,
  },
  'zh-hant': {
    title: '更新日誌',
    description: '追蹤 Lody 的產品更新、改進與修復。',
    releaseNotesFallback: (version) => `Lody ${version} 版本更新說明。`,
  },
  ja: {
    title: '変更履歴',
    description: 'Lody の製品アップデート、改善点、不具合修正の履歴をご覧いただけます。',
    releaseNotesFallback: (version) => `Lody ${version} リリースノート。`,
  },
  ko: {
    title: '변경 로그',
    description: 'Lody의 제품 업데이트, 개선 사항 및 버그 수정을 확인하세요.',
    releaseNotesFallback: (version) => `Lody ${version} 릴리스 노트.`,
  },
  es: {
    title: 'Registro de cambios',
    description: 'Sigue las actualizaciones, mejoras y correcciones publicadas en Lody.',
    releaseNotesFallback: (version) => `Notas de la versión Lody ${version}.`,
  },
  fr: {
    title: 'Journal des modifications',
    description: 'Suivez les mises à jour produit, améliorations et correctifs publiés dans Lody.',
    releaseNotesFallback: (version) => `Notes de version de Lody ${version}.`,
  },
  ru: {
    title: 'История изменений',
    description: 'Следите за обновлениями продукта, улучшениями и исправлениями в Lody.',
    releaseNotesFallback: (version) => `Примечания к выпуску Lody ${version}.`,
  },
};

const changelogIndexAlternates = buildLocaleAlternates('/changelog');

export function changelogIndexHead(locale: ChangelogLocale): SiteHead {
  const copy = changelogCopy[locale];
  return pageHead({
    title: brandTitle(copy.title),
    description: copy.description,
    path: localizeSitePath('/changelog', locale),
    locale: localeCode(locale),
    alternates: changelogIndexAlternates,
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
    description: entry.description ?? changelogCopy[locale].releaseNotesFallback(entry.version),
    path: entry.url,
    locale: localeCode(locale),
    type: 'article',
    publishedTime: entry.date,
    alternates: buildLocaleAlternates(enPath),
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
