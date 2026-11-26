import { loader } from 'fumadocs-core/source';
import {
  docsEn,
  docsEs,
  docsFr,
  docsJa,
  docsKo,
  docsRu,
  docsZh,
  docsZhHant,
} from '@site/.source/server';
import type { SiteLocale } from '@site/src/site-pages/shared';

export const sourceEn = loader({
  baseUrl: '/docs',
  source: docsEn.toFumadocsSource(),
});

export const sourceZh = loader({
  baseUrl: '/zh/docs',
  source: docsZh.toFumadocsSource(),
});

export const sourceZhHant = loader({
  baseUrl: '/zh-hant/docs',
  source: docsZhHant.toFumadocsSource(),
});

export const sourceJa = loader({
  baseUrl: '/ja/docs',
  source: docsJa.toFumadocsSource(),
});

export const sourceKo = loader({
  baseUrl: '/ko/docs',
  source: docsKo.toFumadocsSource(),
});

export const sourceEs = loader({
  baseUrl: '/es/docs',
  source: docsEs.toFumadocsSource(),
});

export const sourceFr = loader({
  baseUrl: '/fr/docs',
  source: docsFr.toFumadocsSource(),
});

export const sourceRu = loader({
  baseUrl: '/ru/docs',
  source: docsRu.toFumadocsSource(),
});

export const docsSources = {
  en: sourceEn,
  zh: sourceZh,
  'zh-hant': sourceZhHant,
  ja: sourceJa,
  ko: sourceKo,
  es: sourceEs,
  fr: sourceFr,
  ru: sourceRu,
} satisfies Record<SiteLocale, typeof sourceEn>;
