import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  localeFromPathname,
  notFoundCopy,
  notFoundHead,
  type NotFoundSeoLocale,
} from './not-found-seo.ts';

const ALL_LOCALES: readonly NotFoundSeoLocale[] = [
  'en',
  'zh',
  'zh-hant',
  'ja',
  'ko',
  'es',
  'fr',
  'ru',
];

const EXPECTED_OG_LOCALE: Record<NotFoundSeoLocale, string> = {
  en: 'en_US',
  zh: 'zh_CN',
  'zh-hant': 'zh_TW',
  ja: 'ja_JP',
  ko: 'ko_KR',
  es: 'es_ES',
  fr: 'fr_FR',
  ru: 'ru_RU',
};

await test('localeFromPathname resolves all 8 locales with zh-hant before zh', () => {
  assert.equal(localeFromPathname('/zh-hant'), 'zh-hant');
  assert.equal(localeFromPathname('/zh-hant/'), 'zh-hant');
  assert.equal(localeFromPathname('/zh-hant/docs/nope'), 'zh-hant');
  assert.equal(localeFromPathname('/zh'), 'zh');
  assert.equal(localeFromPathname('/zh/'), 'zh');
  assert.equal(localeFromPathname('/zh/docs/nope'), 'zh');
  assert.equal(localeFromPathname('/ja/docs/nope'), 'ja');
  assert.equal(localeFromPathname('/ko/blog/nope'), 'ko');
  assert.equal(localeFromPathname('/es/price/nope'), 'es');
  assert.equal(localeFromPathname('/fr/changelog/nope'), 'fr');
  assert.equal(localeFromPathname('/ru/download/nope'), 'ru');
  assert.equal(localeFromPathname('/docs/nope'), 'en');
  assert.equal(localeFromPathname('/zha'), 'en');
  assert.equal(localeFromPathname('/japan'), 'en');
});

await test('notFoundHead uses a branded 404 title, noindex, and og:locale for all 8 locales', () => {
  for (const locale of ALL_LOCALES) {
    const head = notFoundHead(locale);
    assert.equal(head.meta.find((entry) => entry.title)?.title, notFoundCopy[locale].title);
    assert.equal(head.meta.find((entry) => entry.name === 'robots')?.content, 'noindex, follow');
    assert.equal(
      head.meta.find((entry) => entry.property === 'og:locale')?.content,
      EXPECTED_OG_LOCALE[locale]
    );
    assert.match(notFoundCopy[locale].title, /\| Lody$/u);
  }
});

await test('notFoundHead does not canonicalize or og:url to the homepage', () => {
  for (const locale of ALL_LOCALES) {
    const head = notFoundHead(locale);
    assert.equal(
      head.links.some((link) => link.rel === 'canonical'),
      false
    );
    assert.equal(
      head.meta.some(
        (entry) => entry.property === 'og:url' && entry.content === 'https://lody.ai/'
      ),
      false
    );
    assert.notEqual(head.meta.find((entry) => entry.title)?.title, 'Lody Docs');
    assert.doesNotMatch(
      head.meta.find((entry) => entry.title)?.title ?? '',
      /Run your agents in parallel/u
    );
  }
});
