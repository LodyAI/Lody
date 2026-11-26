import { Link as RouterLink, useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { RootProvider } from 'fumadocs-ui/provider/tanstack';
import type { ComponentProps, ReactNode } from 'react';
import {
  detectSiteLocaleFromPath,
  SITE_LOCALE_META,
  SITE_LOCALES,
  switchSiteLocalePath,
  type SiteLocale,
} from '@site/src/site-pages/shared';

import { isSitePageHref, SITE_URL, siteHref } from '../lib/site-url.mjs';
import { OptionalEnhancement } from './optional-enhancement';
import { CookieConsentBanner } from './cookie-consent-banner';
import { DocsSearchDialog } from './docs-search-dialog';
import { MarketingAtmosphereHost } from './marketing-atmosphere';

const locales = SITE_LOCALES.map((locale) => ({
  locale,
  name: SITE_LOCALE_META[locale].label,
}));

const translationsByLocale: Record<
  SiteLocale,
  {
    chooseLanguage: string;
    search: string;
    searchNoResult: string;
    toc: string;
    tocNoHeadings: string;
    lastUpdate: string;
    nextPage: string;
    previousPage: string;
    chooseTheme: string;
  }
> = {
  en: {
    chooseLanguage: 'Choose language',
    search: 'Search',
    searchNoResult: 'No results found',
    toc: 'On this page',
    tocNoHeadings: 'No headings',
    lastUpdate: 'Last updated on',
    nextPage: 'Next',
    previousPage: 'Previous',
    chooseTheme: 'Theme',
  },
  zh: {
    chooseLanguage: '选择语言',
    search: '搜索文档',
    searchNoResult: '没有找到相关内容',
    toc: '本页目录',
    tocNoHeadings: '无标题',
    lastUpdate: '最后更新于',
    nextPage: '下一页',
    previousPage: '上一页',
    chooseTheme: '主题',
  },
  'zh-hant': {
    chooseLanguage: '選擇語言',
    search: '搜尋文件',
    searchNoResult: '找不到相關內容',
    toc: '本頁目錄',
    tocNoHeadings: '沒有標題',
    lastUpdate: '最後更新於',
    nextPage: '下一頁',
    previousPage: '上一頁',
    chooseTheme: '佈景主題',
  },
  ja: {
    chooseLanguage: '言語を選択',
    search: 'ドキュメントを検索',
    searchNoResult: '一致する結果が見つかりません',
    toc: '目次',
    tocNoHeadings: '見出しはありません',
    lastUpdate: '最終更新日',
    nextPage: '次のページ',
    previousPage: '前のページ',
    chooseTheme: 'テーマ',
  },
  ko: {
    chooseLanguage: '언어 선택',
    search: '문서 검색',
    searchNoResult: '검색 결과가 없습니다',
    toc: '이 페이지의 목차',
    tocNoHeadings: '제목 없음',
    lastUpdate: '마지막 업데이트',
    nextPage: '다음 페이지',
    previousPage: '이전 페이지',
    chooseTheme: '테마',
  },
  es: {
    chooseLanguage: 'Elegir idioma',
    search: 'Buscar en la documentación',
    searchNoResult: 'No se encontraron resultados',
    toc: 'En esta página',
    tocNoHeadings: 'Sin encabezados',
    lastUpdate: 'Última actualización el',
    nextPage: 'Siguiente',
    previousPage: 'Anterior',
    chooseTheme: 'Tema',
  },
  fr: {
    chooseLanguage: 'Choisir la langue',
    search: 'Rechercher dans la documentation',
    searchNoResult: 'Aucun résultat trouvé',
    toc: 'Sur cette page',
    tocNoHeadings: 'Aucun titre',
    lastUpdate: 'Dernière mise à jour le',
    nextPage: 'Suivant',
    previousPage: 'Précédent',
    chooseTheme: 'Thème',
  },
  ru: {
    chooseLanguage: 'Выбрать язык',
    search: 'Поиск по документации',
    searchNoResult: 'Ничего не найдено',
    toc: 'На этой странице',
    tocNoHeadings: 'Нет заголовков',
    lastUpdate: 'Последнее обновление',
    nextPage: 'Далее',
    previousPage: 'Назад',
    chooseTheme: 'Тема',
  },
};

/**
 * Paths `lody.ai` serves from the Lody web app instead of from this site. The
 * client router matches none of them, so the Tanstack adapter Fumadocs installs
 * by default would turn a link like `/login` into a client navigation that ends
 * on the site's 404 page. The landing, pricing and download pages already reach
 * the web app through hand-written anchors; this keeps Fumadocs-rendered links
 * (docs Cards, MDX links) on the same real navigation.
 */
const APP_OWNED_PATHS = ['/login'];

function isAppOwnedHref(href: string) {
  const path = href.split(/[?#]/u)[0] ?? href;
  return APP_OWNED_PATHS.some((owned) => path === owned || path.startsWith(`${owned}/`));
}

function SiteFrameworkLink({
  href = '#',
  prefetch = true,
  ...props
}: ComponentProps<'a'> & { prefetch?: boolean }) {
  const router = useRouter();
  if (isAppOwnedHref(href) || !isSitePageHref(href)) return <a href={href} {...props} />;

  const normalizedHref = siteHref(href);
  // Absolute hrefs keep the native navigation semantics of RouterLink's external branch.
  if (!href.startsWith('/')) return <a href={normalizedHref} {...props} />;

  const url = new URL(normalizedHref, SITE_URL);
  // `to` is a pathname: trailingSlash must never process a query or fragment.
  return (
    <RouterLink
      preload={prefetch ? 'intent' : false}
      to={url.pathname as never}
      search={router.options.parseSearch(url.search) as never}
      hash={url.hash.slice(1)}
      {...props}
    />
  );
}

const frameworkComponents = { Link: SiteFrameworkLink };

export function SiteRootProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const pathname = location.pathname;
  const locale = detectSiteLocaleFromPath(pathname);

  return (
    <RootProvider
      components={frameworkComponents}
      theme={{ defaultTheme: 'dark', disableTransitionOnChange: false }}
      search={{ SearchDialog: DocsSearchDialog }}
      i18n={{
        locale,
        locales,
        translations: translationsByLocale[locale],
        onLocaleChange: (targetLocale) => {
          void navigate({
            to: switchSiteLocalePath(pathname, targetLocale as SiteLocale) as never,
          });
        },
      }}
    >
      {/* Shared WebGL field for price / download / changelog — one compile per session. */}
      <OptionalEnhancement>
        <MarketingAtmosphereHost />
      </OptionalEnhancement>
      {children}
      <CookieConsentBanner locale={locale} />
    </RootProvider>
  );
}
