import { LandingPage } from '@site/components/landing';
import { landingJsonLd, landingMetaDescription, landingPageTitle } from '@site/lib/landing-seo';
import { pageHead } from '@site/lib/metadata';
import type { SiteHead } from '@site/lib/metadata';
import { buildLocaleAlternates, localeCode, localizeSitePath, type SiteLocale } from './shared';

const landingAlternates = buildLocaleAlternates('/');

export function landingHead(locale: SiteLocale, options?: { noindex?: boolean }): SiteHead {
  return pageHead({
    title: landingPageTitle(locale),
    description: landingMetaDescription(locale),
    path: localizeSitePath('/', locale),
    locale: localeCode(locale),
    alternates: landingAlternates,
    robots: options?.noindex ? { index: false, follow: true } : undefined,
    jsonLd: landingJsonLd(locale),
  });
}

export function LandingRoutePage({ locale }: { locale: SiteLocale }) {
  return <LandingPage locale={locale} />;
}
