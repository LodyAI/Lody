export const SITE_URL = 'https://lody.ai';

export const APP_OWNED_PATHS = ['/login'];

// These are site-owned page routes. App routes and static file namespaces are
// intentionally excluded: public-site URL rules must never rewrite those URLs.
const LOCALE_PREFIX = '(?:zh-hant|zh|ja|ko|es|fr|ru)';
const LOCALE_ROOT = new RegExp(`^/${LOCALE_PREFIX}/?$`, 'u');
const PAGE_PATH = new RegExp(
  `^/(?:${LOCALE_PREFIX}(?:/|$))?(?:(?:docs|blog|changelog)(?:/|$)|(?:home|price|download(?:/nightly)?|privacy|terms|support|account-deletion)/?$)`,
  'u'
);
const FILE_EXTENSION =
  /\.(?:avif|css|csv|gif|html?|ico|jpe?g|js|json|map|mdx?|mp[34]|pdf|png|svg|tar|tgz|txt|wasm|webm|webp|woff2?|xml|zip)$/iu;

/** Directory URL for a known page; a dot in a page slug is not a file extension. */
export function pageHref(href) {
  const pathname = href.split(/[?#]/u, 1)[0];
  // Keep the entire query/fragment verbatim, including both when present.
  return `${pathname.endsWith('/') ? pathname : `${pathname}/`}${href.slice(pathname.length)}`;
}

export function isAppOwnedHref(href) {
  if (typeof href !== 'string') return false;
  const relative = href.startsWith(`${SITE_URL}/`) ? href.slice(SITE_URL.length) : href;
  if (!relative.startsWith('/') || relative.startsWith('//')) return false;
  const pathname = relative.split(/[?#]/u, 1)[0];
  return APP_OWNED_PATHS.some((owned) => pathname === owned || pathname.startsWith(`${owned}/`));
}

export function appOwnedRel(href, rel) {
  if (!isAppOwnedHref(href)) return rel;
  if (!rel) return 'nofollow';
  const tokens = rel.trim().split(/\s+/u).filter(Boolean);
  return tokens.includes('nofollow') ? rel : [...tokens, 'nofollow'].join(' ');
}

export function isSitePageHref(href) {
  const relative = href.startsWith(`${SITE_URL}/`) ? href.slice(SITE_URL.length) : href;
  if (!relative.startsWith('/') || relative.startsWith('//')) return false;
  const pathname = relative.split(/[?#]/u, 1)[0];
  if (FILE_EXTENSION.test(pathname)) return false;
  return pathname === '/' || LOCALE_ROOT.test(pathname) || PAGE_PATH.test(pathname);
}

/** Normalize ordinary site navigation without touching files, app or external URLs. */
export function siteHref(href) {
  return isSitePageHref(href) ? pageHref(href) : href;
}

export function absoluteSiteUrl(href) {
  return new URL(siteHref(href), SITE_URL).toString();
}

export function absolutePageUrl(href) {
  const url = new URL(href, SITE_URL);
  if (url.origin === SITE_URL) url.pathname = pageHref(url.pathname);
  return url.toString();
}
