import { PricingPage } from '@site/components/pricing-page';
import { brandTitle, pageHead } from '@site/lib/metadata';
import type { SiteHead } from '@site/lib/metadata';
import { localeCode, type SiteLocale } from './shared';

export function pricingHead(locale: SiteLocale): SiteHead {
  return pageHead({
    title: brandTitle(locale === 'zh' ? '价格' : 'Pricing'),
    description:
      locale === 'zh'
        ? 'Lody 免费版、Plus 和企业版价格。'
        : 'Lody pricing for Free, Plus, and Enterprise plans.',
    path: locale === 'zh' ? '/zh/price' : '/price',
    locale: localeCode(locale),
    alternates: [
      { lang: 'en-US', path: '/price' },
      { lang: 'zh-CN', path: '/zh/price' },
    ],
  });
}

export function PricingRoutePage({ locale }: { locale: SiteLocale }) {
  return <PricingPage locale={locale} />;
}
