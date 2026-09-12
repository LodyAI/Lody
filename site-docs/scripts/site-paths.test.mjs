import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectSitePaths, isSitemapPath } from './site-paths.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function collectSidebarEntries(dir) {
  const metaPath = path.join(dir, 'meta.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (!Array.isArray(meta.pages)) {
    throw new Error(`${metaPath} must contain a pages array`);
  }
  if (meta.pages.includes('...') || meta.pages.includes('z...a')) {
    throw new Error(`${metaPath} uses a rest placeholder; unlisted folders would enter the sidebar`);
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

await test('prerender paths include the 404 documents', () => {
  const paths = collectSitePaths(packageRoot);
  assert.ok(paths.includes('/404'));
  assert.ok(paths.includes('/zh/404'));
  assert.ok(paths.includes('/'));
  assert.ok(paths.includes('/docs'));
});

await test('compare docs are prerendered even when omitted from sidebar meta', () => {
  const paths = collectSitePaths(packageRoot);
  assert.ok(paths.includes('/docs/compare/share-link-vs-live-handoff'));
  assert.ok(paths.includes('/zh/docs/compare/share-link-vs-live-handoff'));
  assert.equal(paths.includes('/docs/share-link-vs-live-handoff'), false);

  const docsEn = path.join(packageRoot, 'content/docs/en');
  const rootMeta = JSON.parse(readFileSync(path.join(docsEn, 'meta.json'), 'utf8'));
  const featuresMeta = JSON.parse(readFileSync(path.join(docsEn, '(features)/meta.json'), 'utf8'));
  const sidebar = collectSidebarEntries(docsEn);
  assert.equal(rootMeta.pages.includes('compare'), false);
  assert.equal(featuresMeta.pages.includes('share-link-vs-live-handoff'), false);
  assert.equal(sidebar.includes('compare'), false);
  assert.equal(sidebar.includes('share-link-vs-live-handoff'), false);
});

await test('sitemap omits compatibility homes and 404 documents', () => {
  assert.equal(isSitemapPath('/'), true);
  assert.equal(isSitemapPath('/docs'), true);
  assert.equal(isSitemapPath('/home'), false);
  assert.equal(isSitemapPath('/zh/home'), false);
  assert.equal(isSitemapPath('/404'), false);
  assert.equal(isSitemapPath('/zh/404'), false);
});
