import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brandTitle, pageHead } from './metadata.ts';

await test('brandTitle appends | Lody when the title is unbranded', () => {
  assert.equal(brandTitle('Introduction'), 'Introduction | Lody');
  assert.equal(brandTitle('Blog'), 'Blog | Lody');
  assert.equal(brandTitle('价格'), '价格 | Lody');
});

await test('brandTitle returns the brand when the title is empty', () => {
  assert.equal(brandTitle(''), 'Lody');
});

await test('brandTitle does not double-brand titles that already include Lody', () => {
  assert.equal(
    brandTitle('Lody - Run your agents in parallel, safely'),
    'Lody - Run your agents in parallel, safely'
  );
  assert.equal(brandTitle('Introduction | Lody'), 'Introduction | Lody');
  assert.equal(brandTitle('Changelog – Lody'), 'Changelog – Lody');
  assert.equal(brandTitle('Pricing - Lody'), 'Pricing - Lody');
  assert.equal(brandTitle('Download Lody'), 'Download Lody');
});

await test('pageHead serializes JSON-LD scripts and does not noindex by default', () => {
  const head = pageHead({
    title: 'Share a Coding Agent Session | Lody',
    path: '/docs/session-handoff',
    locale: 'en-US',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [],
    },
  });
  assert.equal(head.scripts?.[0]?.type, 'application/ld+json');
  assert.match(head.scripts?.[0]?.children ?? '', /"@type":"FAQPage"/u);
  assert.equal(
    head.meta.some((entry) => entry.name === 'robots' && /noindex/u.test(entry.content ?? '')),
    false
  );
});

await test('pageHead falls back to the product description', () => {
  const head = pageHead({
    title: 'Introduction | Lody',
    path: '/docs',
    locale: 'en-US',
  });
  const description = head.meta.find((entry) => entry.name === 'description');
  assert.equal(
    description?.content,
    'Lody is a team workspace for running AI coding agents in parallel with isolated Git worktrees, live diff review, GitHub integration, and mobile access.'
  );
});

await test('versioned changelog metadata uses final directory URLs in both locales', () => {
  const slug = '20260929-0.102.0';
  for (const locale of ['en-US', 'zh-CN'] as const) {
    const en = `/changelog/${slug}`;
    const zh = `/zh/changelog/${slug}`;
    const canonical = `https://lody.ai${locale === 'zh-CN' ? zh : en}/`;
    const head = pageHead({
      title: 'Release | Lody',
      path: locale === 'zh-CN' ? zh : en,
      locale,
      alternates: [
        { lang: 'en-US', path: en },
        { lang: 'zh-CN', path: zh },
      ],
    });
    assert.deepEqual(head.links, [
      { rel: 'canonical', href: canonical },
      { rel: 'alternate', hrefLang: 'en-US', href: `https://lody.ai${en}/` },
      { rel: 'alternate', hrefLang: 'zh-CN', href: `https://lody.ai${zh}/` },
      { rel: 'alternate', hrefLang: 'x-default', href: `https://lody.ai${en}/` },
    ]);
    assert.equal(head.meta.find((entry) => entry.property === 'og:url')?.content, canonical);
    assert.equal(
      head.meta.find((entry) => entry.property === 'og:image')?.content,
      'https://lody.ai/og-image.png'
    );
  }
});

await test('page metadata never rewrites image URLs as directory pages', () => {
  for (const image of ['/image-without-extension?v=1#preview', 'https://cdn.example/image?v=1']) {
    const head = pageHead({ title: 'Docs', path: '/docs', locale: 'en-US', image });
    assert.equal(
      head.meta.find((entry) => entry.property === 'og:image')?.content,
      new URL(image, 'https://lody.ai').toString()
    );
  }
});
