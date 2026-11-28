'use client';

import { SiteAnchor } from '@site/components/site-anchor';
import { formatLandingPromoBannerCopy } from '@site/lib/public-promo';
import { localizeSitePath, type SiteLocale } from '@site/src/site-pages/shared';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type MouseEvent } from 'react';
import { usePublicPromo } from './use-public-promo';

const DISMISSED_STORAGE_PREFIX = 'lody:promo-banner-dismissed:';

export function LandingPromoBanner({ locale }: { locale: SiteLocale }) {
  const promo = usePublicPromo({ deferUntilIdle: true });
  const navigate = useNavigate();
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  useEffect(() => {
    if (!promo) return;
    try {
      if (window.sessionStorage.getItem(`${DISMISSED_STORAGE_PREFIX}${promo.id}`) === '1') {
        setDismissedId(promo.id);
      }
    } catch {
      // Private mode / disabled storage keeps the banner visible for the tab visit.
    }
  }, [promo]);

  if (!promo || dismissedId === promo.id) {
    return null;
  }

  const copy = formatLandingPromoBannerCopy(promo, locale);
  const priceHref = localizeSitePath('/price', locale);

  const onNavigatePricing = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void navigate({ to: priceHref as never });
  };

  const onDismiss = () => {
    setDismissedId(promo.id);
    try {
      window.sessionStorage.setItem(`${DISMISSED_STORAGE_PREFIX}${promo.id}`, '1');
    } catch {
      // Ignore storage failures.
    }
  };

  return (
    <aside className="landing-promo-banner" role="region" aria-label={copy.badge}>
      <div className="landing-promo-banner__inner">
        <div className="landing-promo-banner__content">
          <span className="landing-promo-banner__badge">{copy.badge}</span>
          <span className="landing-promo-banner__text">{copy.message}</span>
          <SiteAnchor
            className="landing-promo-banner__cta"
            href={priceHref}
            onClick={onNavigatePricing}
          >
            <span>{copy.cta}</span>
            <svg
              aria-hidden="true"
              className="landing-promo-banner__arrow"
              fill="none"
              viewBox="0 0 16 16"
            >
              <path
                d="M3.5 8h9M8.5 4l4 4-4 4"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.7"
              />
            </svg>
          </SiteAnchor>
        </div>
        <button
          aria-label={copy.dismissLabel}
          className="landing-promo-banner__close"
          onClick={onDismiss}
          type="button"
        >
          <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
            <path
              d="m4.5 4.5 7 7m0-7-7 7"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.6"
            />
          </svg>
        </button>
      </div>
    </aside>
  );
}
