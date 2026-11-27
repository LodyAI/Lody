import { LandingPage } from '@site/components/landing';
import { landingJsonLd, landingMetaDescription, landingPageTitle } from '@site/lib/landing-seo';
import { pageHead } from '@site/lib/metadata';
import type { SiteHead } from '@site/lib/metadata';
import { buildLocaleAlternates, localeCode, localizeSitePath, type SiteLocale } from './shared';

const landingAlternates = buildLocaleAlternates('/');

export function landingHead(locale: SiteLocale, options?: { noindex?: boolean }): SiteHead {
  const noindex = options?.noindex === true;
  return pageHead({
    title: landingPageTitle(locale),
    description: landingMetaDescription(locale),
    path: localizeSitePath(noindex ? '/home' : '/', locale),
    locale: localeCode(locale),
    alternates: noindex ? undefined : landingAlternates,
    canonical: !noindex,
    robots: noindex ? { index: false, follow: true } : undefined,
    jsonLd: noindex ? undefined : landingJsonLd(locale),
  });
}

export function LandingRoutePage({ locale }: { locale: SiteLocale }) {
  return <LandingPage locale={locale} />;
}
