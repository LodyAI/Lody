import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localeFromPathname, notFoundCopy, notFoundHead } from './not-found-seo.ts';

await test('localeFromPathname treats /zh and /zh/... as Chinese', () => {
  assert.equal(localeFromPathname('/zh'), 'zh');
  assert.equal(localeFromPathname('/zh/'), 'zh');
  assert.equal(localeFromPathname('/zh/docs/nope'), 'zh');
  assert.equal(localeFromPathname('/docs/nope'), 'en');
  assert.equal(localeFromPathname('/zha'), 'en');
});

await test('notFoundHead uses a branded 404 title and noindex', () => {
  const en = notFoundHead('en');
  const zh = notFoundHead('zh');

  assert.equal(en.meta.find((entry) => entry.title)?.title, notFoundCopy.en.title);
  assert.equal(zh.meta.find((entry) => entry.title)?.title, notFoundCopy.zh.title);
  assert.equal(en.meta.find((entry) => entry.name === 'robots')?.content, 'noindex, follow');
  assert.equal(zh.meta.find((entry) => entry.name === 'robots')?.content, 'noindex, follow');
  assert.match(notFoundCopy.en.title, /\| Lody$/u);
  assert.match(notFoundCopy.zh.title, /\| Lody$/u);
});

await test('notFoundHead does not canonicalize or og:url to the homepage', () => {
  const head = notFoundHead('en');
  assert.equal(
    head.links.some((link) => link.rel === 'canonical'),
    false
  );
  assert.equal(
    head.meta.some((entry) => entry.property === 'og:url' && entry.content === 'https://lody.ai/'),
    false
  );
  assert.notEqual(head.meta.find((entry) => entry.title)?.title, 'Lody Docs');
  assert.doesNotMatch(
    head.meta.find((entry) => entry.title)?.title ?? '',
    /Run your agents in parallel/u
  );
});
