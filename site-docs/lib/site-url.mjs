export const SITE_URL = 'https://lody.ai';

// These are site-owned page routes. App routes and static file namespaces are
// intentionally excluded: public-site URL rules must never rewrite those URLs.
const PAGE_PATH =
  /^\/(?:zh(?:\/|$))?(?:(?:docs|blog|changelog)(?:\/|$)|(?:home|price|download(?:\/nightly)?|privacy|terms|support|account-deletion)\/?$)/u;
const FILE_EXTENSION =
  /\.(?:avif|css|csv|gif|html?|ico|jpe?g|js|json|map|mdx?|mp[34]|pdf|png|svg|tar|tgz|txt|wasm|webm|webp|woff2?|xml|zip)$/iu;

/** Directory URL for a known page; a dot in a page slug is not a file extension. */
export function pageHref(href) {
  const pathname = href.split(/[?#]/u, 1)[0];
  // Keep the entire query/fragment verbatim, including both when present.
  return `${pathname.endsWith('/') ? pathname : `${pathname}/`}${href.slice(pathname.length)}`;
}

export function isSitePageHref(href) {
  const relative = href.startsWith(`${SITE_URL}/`) ? href.slice(SITE_URL.length) : href;
  if (!relative.startsWith('/') || relative.startsWith('//')) return false;
  const pathname = relative.split(/[?#]/u, 1)[0];
  if (FILE_EXTENSION.test(pathname)) return false;
  return pathname === '/' || pathname === '/zh' || pathname === '/zh/' || PAGE_PATH.test(pathname);
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
