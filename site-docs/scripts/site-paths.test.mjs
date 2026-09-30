import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectSitePaths, isSitemapPath } from './site-paths.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await test('prerender paths include the 404 documents', () => {
  const paths = collectSitePaths(packageRoot);
  assert.ok(paths.includes('/404'));
  assert.ok(paths.includes('/zh/404'));
  assert.ok(paths.includes('/'));
  assert.ok(paths.includes('/docs'));
  assert.ok(paths.includes('/download/nightly'));
  assert.ok(paths.includes('/zh/download/nightly'));
});

await test('sitemap omits compatibility homes and 404 documents', () => {
  assert.equal(isSitemapPath('/'), true);
  assert.equal(isSitemapPath('/docs'), true);
  assert.equal(isSitemapPath('/home'), false);
  assert.equal(isSitemapPath('/zh/home'), false);
  assert.equal(isSitemapPath('/404'), false);
  assert.equal(isSitemapPath('/zh/404'), false);
});

await test('site links preserve query, fragment, files and off-site/app destinations', async () => {
  const { siteHref, absoluteSiteUrl, absolutePageUrl } = await import('../lib/site-url.mjs');
  for (const [input, expected] of [
    ['/docs', '/docs/'],
    ['/zh', '/zh/'],
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
    '/llms-full.txt',
    '/_docs-assets/extensionless-image',
    '/assets/runtime.js',
    '/login?next=/docs',
    '/app',
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
