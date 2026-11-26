import { SiteAnchor } from '@site/components/site-anchor';
import type { SiteLocale } from '@site/src/site-pages/shared';
import { LANDING_COPY } from './landing-copy';
import { SiteFooter } from './site-footer';
import { SiteNav } from './site-nav';
import { UnderwaterExperience } from './underwater-experience';

export type LandingLocale = SiteLocale;

export function LandingPage({ locale }: { locale: LandingLocale }) {
  const t = LANDING_COPY[locale];

  return (
    <div className="underwater-landing">
      <SiteAnchor className="uw-skip-link" href="#main-content">
        {t.skipToContent}
      </SiteAnchor>

      <SiteNav locale={locale} />

      <UnderwaterExperience
        subscriptions={t.subscriptions}
        orchestration={t.orchestration}
        cli={t.cli}
        power={t.power}
        mobileDeep={t.mobileDeep}
        cta={t.cta}
        hero={t.hero}
        locale={locale}
      />

      <SiteFooter locale={locale} />
    </div>
  );
}
