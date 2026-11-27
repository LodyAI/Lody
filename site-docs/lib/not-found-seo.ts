import type { SiteHead } from './metadata.ts';

export type NotFoundSeoLocale = 'en' | 'zh' | 'zh-hant' | 'ja' | 'ko' | 'es' | 'fr' | 'ru';

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
  'zh-hant': {
    title: '找不到頁面 | Lody',
    heading: '找不到頁面',
    description: '此頁面不存在，可能已被移動或網址不正確。',
    home: '返回首頁',
    homeHref: '/zh-hant/',
    docs: '瀏覽文件',
    docsHref: '/zh-hant/docs',
  },
  ja: {
    title: 'ページが見つかりません | Lody',
    heading: 'ページが見つかりません',
    description: 'お探しのページは存在しないか、移動されたか、URL が正しくない可能性があります。',
    home: 'ホームに戻る',
    homeHref: '/ja/',
    docs: 'ドキュメントを見る',
    docsHref: '/ja/docs',
  },
  ko: {
    title: '페이지를 찾을 수 없습니다 | Lody',
    heading: '페이지를 찾을 수 없습니다',
    description: '요청하신 페이지가 존재하지 않습니다. 이동되었거나 URL이 잘못되었을 수 있습니다.',
    home: '홈으로 돌아가기',
    homeHref: '/ko/',
    docs: '문서 둘러보기',
    docsHref: '/ko/docs',
  },
  es: {
    title: 'Página no encontrada | Lody',
    heading: 'Página no encontrada',
    description: 'Esta página no existe. Puede que se haya movido o que la URL sea incorrecta.',
    home: 'Volver al inicio',
    homeHref: '/es/',
    docs: 'Ver documentación',
    docsHref: '/es/docs',
  },
  fr: {
    title: 'Page introuvable | Lody',
    heading: 'Page introuvable',
    description: 'Cette page n’existe pas. Elle a peut-être été déplacée ou l’URL est incorrecte.',
    home: 'Retour à l’accueil',
    homeHref: '/fr/',
    docs: 'Parcourir la documentation',
    docsHref: '/fr/docs',
  },
  ru: {
    title: 'Страница не найдена | Lody',
    heading: 'Страница не найдена',
    description:
      'Эта страница не существует. Возможно, она была перемещена или URL указан неверно.',
    home: 'На главную',
    homeHref: '/ru/',
    docs: 'Открыть документацию',
    docsHref: '/ru/docs',
  },
} as const;

const OG_LOCALE_BY_LOCALE: Record<NotFoundSeoLocale, string> = {
  en: 'en_US',
  zh: 'zh_CN',
  'zh-hant': 'zh_TW',
  ja: 'ja_JP',
  ko: 'ko_KR',
  es: 'es_ES',
  fr: 'fr_FR',
  ru: 'ru_RU',
};

// Longest prefixes first so `/zh-hant` matches before `/zh`.
const PREFIXED_LOCALES: readonly Exclude<NotFoundSeoLocale, 'en'>[] = [
  'zh-hant',
  'zh',
  'ja',
  'ko',
  'es',
  'fr',
  'ru',
];

export function localeFromPathname(pathname: string): NotFoundSeoLocale {
  for (const locale of PREFIXED_LOCALES) {
    const prefix = `/${locale}`;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return locale;
    }
  }
  return 'en';
}

/**
 * 404 document head. Static hosts serve one `404.html` for every unknown URL,
 * so this must not canonicalize to the homepage (the current soft-404). A
 * requested-URL canonical cannot be baked into that file; `noindex` is the
 * cleaner signal if a host ever serves the document as HTTP 200.
 */
export function notFoundHead(locale: NotFoundSeoLocale): SiteHead {
  const copy = notFoundCopy[locale];
  const ogLocale = OG_LOCALE_BY_LOCALE[locale];

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
