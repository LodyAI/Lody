import { PricingPage } from '@site/components/pricing-page';
import { brandTitle, pageHead } from '@site/lib/metadata';
import type { SiteHead } from '@site/lib/metadata';
import { buildLocaleAlternates, localeCode, localizeSitePath, type SiteLocale } from './shared';

const pricingCopy: Record<SiteLocale, { title: string; description: string }> = {
  en: {
    title: 'Pricing',
    description: 'Lody pricing for Free, Plus, and Enterprise plans.',
  },
  zh: {
    title: '价格',
    description: 'Lody 免费版、Plus 和企业版价格。',
  },
  'zh-hant': {
    title: '定價',
    description: 'Lody 免費版、Plus 與企業版方案定價。',
  },
  ja: {
    title: '料金プラン',
    description: 'Lody の Free、Plus、Enterprise プランの料金案内。',
  },
  ko: {
    title: '요금제',
    description: 'Lody Free, Plus 및 Enterprise 요금제 안내.',
  },
  es: {
    title: 'Precios',
    description: 'Precios de Lody para los planes Free, Plus y Enterprise.',
  },
  fr: {
    title: 'Tarifs',
    description: 'Tarifs de Lody pour les forfaits Free, Plus et Enterprise.',
  },
  ru: {
    title: 'Тарифы',
    description: 'Тарифы Lody для планов Free, Plus и Enterprise.',
  },
};

const pricingAlternates = buildLocaleAlternates('/price');

export function pricingHead(locale: SiteLocale): SiteHead {
  const copy = pricingCopy[locale];
  return pageHead({
    title: brandTitle(copy.title),
    description: copy.description,
    path: localizeSitePath('/price', locale),
    locale: localeCode(locale),
    alternates: pricingAlternates,
  });
}

export function PricingRoutePage({ locale }: { locale: SiteLocale }) {
  return <PricingPage locale={locale} />;
}
