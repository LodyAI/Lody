import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectSitePaths, isSitemapPath, localePrefix, SITE_LOCALES } from './site-paths.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function collectSidebarEntries(dir) {
  const metaPath = path.join(dir, 'meta.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (!Array.isArray(meta.pages)) {
    throw new Error(`${metaPath} must contain a pages array`);
  }
  if (meta.pages.includes('...') || meta.pages.includes('z...a')) {
    throw new Error(
      `${metaPath} uses a rest placeholder; unlisted folders would enter the sidebar`
    );
  }

  return meta.pages.flatMap((item) => {
    if (typeof item !== 'string' || item.startsWith('---')) return [];
    const itemPath = path.join(dir, item);
    if (existsSync(itemPath) && statSync(itemPath).isDirectory()) {
      return collectSidebarEntries(itemPath);
    }
    return [item];
  });
}

await test('prerender paths include static and 404 documents for all 8 locales', () => {
  const paths = collectSitePaths(packageRoot);
  for (const locale of SITE_LOCALES) {
    const prefix = localePrefix(locale);
    assert.ok(paths.includes(prefix || '/'), `Missing root for ${locale}`);
    assert.ok(paths.includes(`${prefix}/docs`), `Missing docs root for ${locale}`);
    assert.ok(paths.includes(`${prefix}/download/nightly`), `Missing nightly for ${locale}`);
    assert.ok(paths.includes(`${prefix}/404`), `Missing 404 for ${locale}`);
    assert.ok(paths.includes(`${prefix}/home`), `Missing home for ${locale}`);
  }
});

await test('compare docs are prerendered even when omitted from sidebar meta', () => {
  const paths = collectSitePaths(packageRoot);
  assert.ok(paths.includes('/docs/compare/share-link-vs-live-handoff'));
  assert.ok(paths.includes('/zh/docs/compare/share-link-vs-live-handoff'));
  assert.equal(paths.includes('/docs/share-link-vs-live-handoff'), false);

  const docsEn = path.join(packageRoot, 'content/docs/en');
  const rootMeta = JSON.parse(readFileSync(path.join(docsEn, 'meta.json'), 'utf8'));
  const guidesMeta = JSON.parse(readFileSync(path.join(docsEn, '(guides)/meta.json'), 'utf8'));
  const sidebar = collectSidebarEntries(docsEn);
  assert.equal(rootMeta.pages.includes('compare'), false);
  assert.equal(guidesMeta.pages.includes('share-link-vs-live-handoff'), false);
  assert.equal(sidebar.includes('compare'), false);
  assert.equal(sidebar.includes('share-link-vs-live-handoff'), false);
});

await test('sitemap omits compatibility homes and 404 documents for all 8 locales', () => {
  for (const locale of SITE_LOCALES) {
    const prefix = localePrefix(locale);
    assert.equal(isSitemapPath(prefix || '/'), true);
    assert.equal(isSitemapPath(`${prefix}/docs`), true);
    assert.equal(isSitemapPath(`${prefix}/home`), false);
    assert.equal(isSitemapPath(`${prefix}/404`), false);
  }
});

await test('site links preserve query, fragment, files and off-site/app destinations', async () => {
  const { siteHref, absoluteSiteUrl, absolutePageUrl } = await import('../lib/site-url.mjs');
  for (const [input, expected] of [
    ['/docs', '/docs/'],
    ['/docs/cli#daemon-mode', '/docs/cli/#daemon-mode'],
    ['/zh/docs/cli?from=docs#daemon-模式', '/zh/docs/cli/?from=docs#daemon-模式'],
    ['/zh', '/zh/'],
    ['/zh-hant', '/zh-hant/'],
    ['/zh-hant/docs/quickstart', '/zh-hant/docs/quickstart/'],
    ['/ja', '/ja/'],
    ['/ja/docs/quickstart', '/ja/docs/quickstart/'],
    ['/ko/price', '/ko/price/'],
    ['/es/download/nightly', '/es/download/nightly/'],
    ['/fr/blog/introducing-lody', '/fr/blog/introducing-lody/'],
    ['/ru/privacy', '/ru/privacy/'],
    ['/zh/docs/quickstart/', '/zh/docs/quickstart/'],
    ['/changelog/20260929-0.102.0', '/changelog/20260929-0.102.0/'],
    [
      '/zh/changelog/20260905-0.91.1?from=docs#fixes',
      '/zh/changelog/20260905-0.91.1/?from=docs#fixes',
    ],
    ['/docs/guide?next=a%2Fb&x=1#one?two', '/docs/guide/?next=a%2Fb&x=1#one?two'],
    ['https://lody.ai/blog/introducing-lody#intro', 'https://lody.ai/blog/introducing-lody/#intro'],
  ]) {
    assert.equal(siteHref(input), expected);
    assert.equal(siteHref(expected), expected);
    assert.equal(absoluteSiteUrl(input), new URL(expected, 'https://lody.ai').toString());
  }
  for (const href of [
    '/og-image.png',
    '/docs/guide.pdf?download=1#page=2',
    '/rss.xml',
    '/rss-ja.xml',
    '/llms-full.txt',
    '/_docs-assets/extensionless-image',
    '/assets/runtime.js',
    '/login?next=/docs',
    '/app',
    '/zha',
    '/japan',
    '#section',
    '?query=1',
    '../guide',
    '//example.com/docs',
    'mailto:hello@example.com',
    'https://example.com/docs',
    'https://updates.lody.ai/Lody-latest.dmg',
  ])
    assert.equal(siteHref(href), href);
  // Callers that know a URL is a page do not guess from extensions at all.
  assert.equal(absolutePageUrl('/docs/package.json'), 'https://lody.ai/docs/package.json/');
});

await test('generated sitemap uses canonical directory URLs for every published page', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  execFileSync(process.execPath, [path.join(packageRoot, 'scripts/generate-sitemap.mjs')]);
  const xml = readFileSync(path.join(packageRoot, 'public/sitemap.xml'), 'utf8');
  const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/gu)].map((match) => match[1]);
  const paths = collectSitePaths(packageRoot).filter(isSitemapPath);
  assert.deepEqual(
    urls,
    paths.map((p) => `https://lody.ai${p === '/' ? p : `${p}/`}`)
  );
  const dottedReleases = paths.filter((p) => /^\/(?:zh\/)?changelog\/.*\./u.test(p));
  assert.ok(dottedReleases.length > 0);
  for (const release of dottedReleases) assert.ok(urls.includes(`https://lody.ai${release}/`));
});
