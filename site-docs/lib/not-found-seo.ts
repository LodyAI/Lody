import type { SiteHead } from './metadata.ts';

export type NotFoundSeoLocale = 'en' | 'zh';

export const notFoundCopy = {
  en: {
    title: 'Page not found | Lody',
    heading: 'Page not found',
    description: 'This page does not exist. It may have been moved or the URL is incorrect.',
    home: 'Back to home',
    homeHref: '/',
    docs: 'Browse docs',
    docsHref: '/docs',
  },
  zh: {
    title: '页面不存在 | Lody',
    heading: '页面不存在',
    description: '该页面不存在，可能已被移动或网址不正确。',
    home: '返回首页',
    homeHref: '/zh/',
    docs: '浏览文档',
    docsHref: '/zh/docs',
  },
} as const;

export function localeFromPathname(pathname: string): NotFoundSeoLocale {
  return pathname === '/zh' || pathname.startsWith('/zh/') ? 'zh' : 'en';
}

/**
 * 404 document head. Static hosts serve one `404.html` for every unknown URL,
 * so this must not canonicalize to the homepage (the current soft-404). A
 * requested-URL canonical cannot be baked into that file; `noindex` is the
 * cleaner signal if a host ever serves the document as HTTP 200.
 */
export function notFoundHead(locale: NotFoundSeoLocale): SiteHead {
  const copy = notFoundCopy[locale];
  const ogLocale = locale === 'zh' ? 'zh_CN' : 'en_US';

  return {
    meta: [
      { title: copy.title },
      { name: 'description', content: copy.description },
      { name: 'robots', content: 'noindex, follow' },
      { property: 'og:title', content: copy.title },
      { property: 'og:description', content: copy.description },
      { property: 'og:site_name', content: 'Lody' },
      { property: 'og:locale', content: ogLocale },
      { property: 'og:type', content: 'website' },
      { property: 'og:image', content: 'https://lody.ai/og-image.png' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: copy.title },
      { name: 'twitter:description', content: copy.description },
      { name: 'twitter:image', content: 'https://lody.ai/og-image.png' },
    ],
    links: [],
  };
}
