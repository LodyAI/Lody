import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveStaticFile } from './static-host.mjs';

function fixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'site-docs-static-'));
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  mkdirSync(path.join(root, 'blog', 'introducing-lody'), { recursive: true });
  writeFileSync(path.join(root, 'index.html'), 'home');
  writeFileSync(path.join(root, '404.html'), 'not-found');
  writeFileSync(path.join(root, 'docs', 'index.html'), 'docs');
  writeFileSync(path.join(root, 'blog', 'introducing-lody', 'index.html'), 'post');
  writeFileSync(path.join(root, 'price.html'), 'price');
  return root;
}

await test('resolveStaticFile maps pretty URLs and file URLs', () => {
  const root = fixtureRoot();
  assert.equal(resolveStaticFile(root, '/'), path.join(root, 'index.html'));
  assert.equal(resolveStaticFile(root, '/docs'), path.join(root, 'docs', 'index.html'));
  assert.equal(resolveStaticFile(root, '/docs/'), path.join(root, 'docs', 'index.html'));
  assert.equal(
    resolveStaticFile(root, '/blog/introducing-lody'),
    path.join(root, 'blog', 'introducing-lody', 'index.html')
  );
  assert.equal(resolveStaticFile(root, '/price'), path.join(root, 'price.html'));
  assert.equal(resolveStaticFile(root, '/missing'), undefined);
  assert.equal(resolveStaticFile(root, '/docs/nope'), undefined);
  assert.equal(resolveStaticFile(root, '/404'), undefined);
  assert.equal(resolveStaticFile(root, '/404.html'), undefined);
});

await test('resolveStaticFile rejects path escape', () => {
  const root = fixtureRoot();
  assert.equal(resolveStaticFile(root, '/../package.json'), undefined);
});
