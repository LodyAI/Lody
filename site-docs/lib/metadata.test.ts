import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildLocaleAlternates,
  detectSiteLocaleFromPath,
  htmlLangForLocale,
  localeCode,
  localePrefix,
  localizeSitePath,
  ogLocaleForLocale,
  SITE_LOCALES,
  switchSiteLocalePath,
} from '../src/site-pages/shared.ts';
import {
  landingJsonLd,
  landingMetaDescription,
  landingPageTitle,
  landingSeoKeywords,
} from './landing-seo.ts';
import { brandTitle, pageHead } from './metadata.ts';
import { appOwnedRel, isAppOwnedHref } from './site-url.mjs';

await test('brandTitle appends | Lody when the title is unbranded', () => {
  assert.equal(brandTitle('Introduction'), 'Introduction | Lody');
  assert.equal(brandTitle('Blog'), 'Blog | Lody');
  assert.equal(brandTitle('价格'), '价格 | Lody');
  assert.equal(brandTitle('料金プラン'), '料金プラン | Lody');
  assert.equal(brandTitle('요금제'), '요금제 | Lody');
  assert.equal(brandTitle('Тарифы'), 'Тарифы | Lody');
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
  assert.equal(brandTitle('Lody をダウンロード'), 'Lody をダウンロード');
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

await test('versioned changelog metadata uses final directory URLs and og:locale in all 8 locales', () => {
  const slug = '20260929-0.102.0';
  const enPath = `/changelog/${slug}`;
  const alternates = buildLocaleAlternates(enPath);

  for (const locale of SITE_LOCALES) {
    const localizedPath = localizeSitePath(enPath, locale);
    const canonical = `https://lody.ai${localizedPath}/`;
    const head = pageHead({
      title: 'Release | Lody',
      path: localizedPath,
      locale: localeCode(locale),
      alternates,
    });
    assert.deepEqual(head.links, [
      { rel: 'canonical', href: canonical },
      ...SITE_LOCALES.map((altLocale) => ({
        rel: 'alternate',
        hrefLang: localeCode(altLocale),
        href: `https://lody.ai${localizeSitePath(enPath, altLocale)}/`,
      })),
      { rel: 'alternate', hrefLang: 'x-default', href: `https://lody.ai${enPath}/` },
    ]);
    assert.equal(head.meta.find((entry) => entry.property === 'og:url')?.content, canonical);
    assert.equal(
      head.meta.find((entry) => entry.property === 'og:locale')?.content,
      ogLocaleForLocale(locale)
    );
    assert.equal(
      head.meta.find((entry) => entry.property === 'og:image')?.content,
      'https://lody.ai/og-image.png'
    );
  }
});

await test('locale path helpers handle all 8 locales and zh-hant vs zh prefix precedence', () => {
  assert.equal(localizeSitePath('/', 'en'), '/');
  assert.equal(localizeSitePath('/', 'ja'), '/ja');
  assert.equal(localizeSitePath('/docs/quickstart', 'zh-hant'), '/zh-hant/docs/quickstart');
  assert.equal(localizeSitePath('/docs/quickstart/', 'ko'), '/ko/docs/quickstart');

  assert.equal(detectSiteLocaleFromPath('/zh-hant/docs'), 'zh-hant');
  assert.equal(detectSiteLocaleFromPath('/zh-hant'), 'zh-hant');
  assert.equal(detectSiteLocaleFromPath('/zh/docs'), 'zh');
  assert.equal(detectSiteLocaleFromPath('/zha'), 'en');
  assert.equal(detectSiteLocaleFromPath('/ja/blog'), 'ja');
  assert.equal(detectSiteLocaleFromPath('/japan'), 'en');

  assert.equal(
    switchSiteLocalePath('/zh-hant/blog/introducing-lody/', 'ja'),
    '/ja/blog/introducing-lody'
  );
  assert.equal(switchSiteLocalePath('/ja', 'en'), '/');
  assert.equal(switchSiteLocalePath('/', 'ru'), '/ru');
  assert.equal(switchSiteLocalePath('/home', 'ja'), '/ja');
  assert.equal(switchSiteLocalePath('/zh/home/', 'en'), '/');
  assert.equal(switchSiteLocalePath('/fr/docs/quickstart', 'es'), '/es/docs/quickstart');

  assert.equal(localePrefix('en'), '');
  assert.equal(localePrefix('zh-hant'), '/zh-hant');
  assert.equal(htmlLangForLocale('zh-hant'), 'zh-Hant');
  assert.equal(ogLocaleForLocale('zh-hant'), 'zh_TW');
  assert.equal(ogLocaleForLocale('ja'), 'ja_JP');
  assert.equal(ogLocaleForLocale('ko'), 'ko_KR');
  assert.equal(ogLocaleForLocale('es'), 'es_ES');
  assert.equal(ogLocaleForLocale('fr'), 'fr_FR');
  assert.equal(ogLocaleForLocale('ru'), 'ru_RU');
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

await test('noindex compatibility pages can omit cross-page canonical and hreflang signals', () => {
  const head = pageHead({
    title: 'Lody - Run your agents in parallel, safely',
    path: '/home',
    locale: 'en-US',
    canonical: false,
    robots: { index: false, follow: true },
  });
  assert.equal(head.meta.find((entry) => entry.name === 'robots')?.content, 'noindex, follow');
  assert.equal(
    head.meta.some((entry) => entry.property === 'og:url'),
    false
  );
  assert.deepEqual(head.links, []);
});

await test('app-owned auth entrypoints receive nofollow without losing existing rel tokens', () => {
  assert.equal(isAppOwnedHref('/login'), true);
  assert.equal(isAppOwnedHref('/login?next=%2Fapp'), true);
  assert.equal(isAppOwnedHref('https://lody.ai/login'), true);
  assert.equal(isAppOwnedHref('/docs/quickstart'), false);

  assert.equal(appOwnedRel('/login'), 'nofollow');
  assert.equal(appOwnedRel('/login', 'noreferrer'), 'noreferrer nofollow');
  assert.equal(appOwnedRel('/login', 'nofollow noreferrer'), 'nofollow noreferrer');
  assert.equal(appOwnedRel('/docs/quickstart', 'noreferrer'), 'noreferrer');
});

await test('landing SEO maps localized primary keywords, titles, descriptions, and JSON-LD inLanguage across all 8 locales', () => {
  const titles = new Set();
  const descriptions = new Set();

  for (const locale of SITE_LOCALES) {
    const keywords = landingSeoKeywords(locale);
    const title = landingPageTitle(locale);
    const description = landingMetaDescription(locale);
    const jsonLd = landingJsonLd(locale);

    assert.ok(title.startsWith('Lody'), `Landing title must lead with brand for ${locale}`);
    assert.equal(brandTitle(title), title, `Landing title must not double-brand for ${locale}`);
    assert.ok(
      title.toLowerCase().includes(keywords.primary.toLowerCase()),
      `Landing title for ${locale} ("${title}") must include native primary keyword "${keywords.primary}"`
    );
    assert.ok(
      keywords.secondary.length >= 5,
      `Landing keyword map for ${locale} should include native secondary keywords`
    );
    assert.equal(jsonLd.inLanguage, localeCode(locale));
    assert.equal(jsonLd.description, description);
    assert.equal(jsonLd.url, `https://lody.ai${localePrefix(locale)}/`);
    assert.equal(Array.isArray(jsonLd.featureList) && jsonLd.featureList.length, 12);

    titles.add(title);
    descriptions.add(description);
  }

  assert.equal(titles.size, SITE_LOCALES.length);
  assert.equal(descriptions.size, SITE_LOCALES.length);
});
