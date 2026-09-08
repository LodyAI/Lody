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
});

await test('sitemap omits compatibility homes and 404 documents', () => {
  assert.equal(isSitemapPath('/'), true);
  assert.equal(isSitemapPath('/docs'), true);
  assert.equal(isSitemapPath('/home'), false);
  assert.equal(isSitemapPath('/zh/home'), false);
  assert.equal(isSitemapPath('/404'), false);
  assert.equal(isSitemapPath('/zh/404'), false);
});
