import { Link as RouterLink, useLocation, useNavigate } from '@tanstack/react-router';
import { RootProvider } from 'fumadocs-ui/provider/tanstack';
import type { ComponentProps, ReactNode } from 'react';

import { OptionalEnhancement } from './optional-enhancement';
import { DocsSearchDialog } from './docs-search-dialog';
import { MarketingAtmosphereHost } from './marketing-atmosphere';

type SiteLocale = 'en' | 'zh';

const locales = [
  { locale: 'en', name: 'English' },
  { locale: 'zh', name: '简体中文' },
];

const zhTranslations = {
  chooseLanguage: '选择语言',
  search: '搜索文档',
  searchNoResult: '没有找到相关内容',
  toc: '本页目录',
};

function getCurrentLocale(pathname: string): SiteLocale {
  return pathname === '/zh' || pathname.startsWith('/zh/') ? 'zh' : 'en';
}

function normalizePath(pathname: string) {
  return pathname.replace(/\/$/u, '') || '/';
}

function getLocalizedPath(pathname: string, targetLocale: string) {
  const cleanPath = normalizePath(pathname);

  if (targetLocale === 'zh') {
    if (cleanPath === '/') return '/zh';
    if (cleanPath === '/zh' || cleanPath.startsWith('/zh/')) return cleanPath;
    return `/zh${cleanPath}`;
  }

  if (cleanPath === '/zh') return '/';
  if (cleanPath.startsWith('/zh/')) return cleanPath.replace(/^\/zh/u, '') || '/';
  return cleanPath;
}

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
  if (isAppOwnedHref(href)) return <a href={href} {...props} />;

  // Mirrors fumadocs-core's Tanstack adapter for everything this site owns.
  return <RouterLink preload={prefetch ? 'intent' : false} to={href as never} {...props} />;
}

const frameworkComponents = { Link: SiteFrameworkLink };

export function SiteRootProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const pathname = location.pathname;
  const locale = getCurrentLocale(pathname);

  return (
    <RootProvider
      components={frameworkComponents}
      theme={{ defaultTheme: 'dark', disableTransitionOnChange: false }}
      search={{ SearchDialog: DocsSearchDialog }}
      i18n={{
        locale,
        locales,
        translations: locale === 'zh' ? zhTranslations : undefined,
        onLocaleChange: (targetLocale) => {
          void navigate({ to: getLocalizedPath(pathname, targetLocale) as never });
        },
      }}
    >
      {/* Shared WebGL field for price / download / changelog — one compile per session. */}
      <OptionalEnhancement>
        <MarketingAtmosphereHost />
      </OptionalEnhancement>
      {children}
    </RootProvider>
  );
}
