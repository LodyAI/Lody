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
    description:
      'Release notes and updates for Lody desktop, mobile, CLI, and ACP AI coding agent integrations.',
    releaseNotesFallback: (version) => `Lody ${version} release notes.`,
  },
  zh: {
    title: '更新日志',
    description: '追踪 Lody 桌面端、移动端、CLI 及 AI 编程 Agent 集成的版本更新与修复记录。',
    releaseNotesFallback: (version) => `Lody ${version} 版本更新说明。`,
  },
  'zh-hant': {
    title: '更新日誌',
    description: '追蹤 Lody 桌面端、行動端、CLI 與 AI 程式設計 Agent 整合的版本更新與修復紀錄。',
    releaseNotesFallback: (version) => `Lody ${version} 版本更新說明。`,
  },
  ja: {
    title: '変更履歴',
    description:
      'Lody デスクトップ・モバイル・CLI および AI コーディングエージェント連携のリリースノートと更新履歴。',
    releaseNotesFallback: (version) => `Lody ${version} リリースノート。`,
  },
  ko: {
    title: '변경 로그',
    description:
      'Lody 데스크톱, 모바일, CLI 및 AI 코딩 에이전트 연동의 버전별 업데이트와 수정 내역을 확인하세요.',
    releaseNotesFallback: (version) => `Lody ${version} 릴리스 노트.`,
  },
  es: {
    title: 'Registro de cambios',
    description:
      'Notas de versión y actualizaciones de Lody para escritorio, móvil, CLI e integraciones de agentes de código IA.',
    releaseNotesFallback: (version) => `Notas de la versión Lody ${version}.`,
  },
  fr: {
    title: 'Journal des modifications',
    description:
      'Notes de version et mises à jour de Lody pour ordinateur, mobile, CLI et intégrations d’agents de code IA.',
    releaseNotesFallback: (version) => `Notes de version de Lody ${version}.`,
  },
  ru: {
    title: 'История изменений',
    description:
      'Примечания к выпускам и обновления Lody для компьютера, мобильных приложений, CLI и интеграций ИИ-агентов.',
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
