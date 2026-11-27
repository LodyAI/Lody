'use client';

import { SiteAnchor } from '@site/components/site-anchor';
import type { SiteLocale } from '@site/src/site-pages/shared';

/**
 * Public pricing page (`/price` and localized equivalents).
 *
 * Content and structure were ported from the retired VitePress site. Styles
 * live in `app/pricing.css`.
 *
 * Prerendered HTML displays standard list pricing ($96 yearly or $10 monthly per
 * seat); client mount progressively overlays active time-bound first-period
 * promotions returned by `/api/billing/public-promo`.
 */

import '@site/app/pricing.css';
import {
  computeDiscountedPlusPricing,
  formatPublicPromoBadge,
  formatPublicPromoNote,
  type PublicPromoActive,
} from '@site/lib/public-promo';
import NumberFlow from '@number-flow/react';
import { useState, type CSSProperties, type ReactNode } from 'react';

import { LandingEffects } from './landing-interactions';
import { PRICING_COPY, type FeatureSection, type PricingPlan } from './pricing-copy';
import { SiteFooter } from './site-footer';
import { SiteNav } from './site-nav';
import { usePublicPromo } from './use-public-promo';

/** Spring-ish easing matched to pricing card motion tokens. */
const PRICE_NUMBER_TIMING = {
  duration: 520,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
} as const;

const PRICE_OPACITY_TIMING = {
  duration: 280,
  easing: 'ease-out',
} as const;

export type PricingLocale = SiteLocale;

type BillingCycle = 'yearly' | 'monthly';

export function PricingPage({ locale }: { locale: PricingLocale }) {
  const page = PRICING_COPY[locale];
  const [billingCycle, setBillingCycle] = useState<BillingCycle>('yearly');
  const promo = usePublicPromo();
  const isYearly = billingCycle === 'yearly';
  return (
    <div className="landing-page-root marketing-shell">
      <LandingEffects />
      <SiteNav locale={locale} />
      <main className="landing pricing-page" data-billing={billingCycle}>
        <div aria-hidden="true" className="pricing-ambient">
          <span className="pricing-ambient-orb pricing-ambient-orb-1" />
          <span className="pricing-ambient-orb pricing-ambient-orb-2" />
          <span className="pricing-ambient-orb pricing-ambient-orb-3" />
          <span className="pricing-ambient-grid" />
        </div>

        <section className="pricing-hero">
          <h1 className="pricing-hero-title reveal delay-1">{page.title}</h1>
          <p className="pricing-hero-lead reveal delay-2">
            <span className="pricing-hero-lead-emphasis">{page.leadEmphasis}</span>{' '}
            <span className="pricing-hero-lead-rest">{page.leadRest}</span>
          </p>
        </section>

        <section aria-label={page.plansLabel} className="pricing-plans">
          <div className="pricing-toolbar scroll-reveal">
            <div
              className="pricing-toolbar-shell"
              role="group"
              aria-label={page.billing.toggleLabel}
            >
              <div aria-hidden="true" className="pricing-toolbar-track">
                <span className="pricing-toolbar-thumb" />
              </div>
              <button
                aria-pressed={!isYearly}
                className={`pricing-toolbar-option${!isYearly ? ' is-active' : ''}`}
                onClick={() => setBillingCycle('monthly')}
                type="button"
              >
                {page.billing.monthly}
              </button>
              <button
                aria-pressed={isYearly}
                className={`pricing-toolbar-option${isYearly ? ' is-active' : ''}`}
                onClick={() => setBillingCycle('yearly')}
                type="button"
              >
                {page.billing.yearly}
                <span className="pricing-toolbar-tag">{page.billing.save}</span>
              </button>
            </div>
          </div>

          <div className="pricing-grid">
            {page.plans.map((plan, index) => (
              <PricingCard
                isYearly={isYearly}
                key={plan.id}
                locale={locale}
                plan={plan}
                promo={plan.id === 'plus' ? promo : null}
                style={{ '--card-index': String(index) } as CSSProperties}
              />
            ))}
          </div>

          <p className="pricing-fineprint">{page.finePrint}</p>
        </section>

        <section
          aria-label={page.featuresLabel}
          className="pricing-included"
          id="included-features"
        >
          <div className="pricing-section-heading scroll-reveal">
            <h2>{page.featuresHeading}</h2>
            <p>
              <span className="pricing-section-lead-prefix">{page.featuresLeadPrefix}</span>{' '}
              <span className="pricing-section-lead-rest">{page.featuresLeadRest}</span>
            </p>
          </div>

          <div className="pricing-feature-table-wrap scroll-reveal">
            <div className="pricing-feature-table" role="table" aria-label={page.featuresLabel}>
              <div className="pricing-feature-table-head" role="row">
                <div
                  className="pricing-feature-table-cell pricing-feature-name"
                  role="columnheader"
                >
                  {page.comparisonFeatureLabel}
                </div>
                {page.comparisonColumns.map((column) => (
                  <div
                    className="pricing-feature-table-cell pricing-feature-plan"
                    key={column}
                    role="columnheader"
                  >
                    {column}
                  </div>
                ))}
              </div>

              {page.featureSections.map((section) => (
                <FeatureSectionBlock
                  includedLabel={page.includedLabel}
                  key={section.title}
                  section={section}
                />
              ))}
            </div>
          </div>
        </section>

        <section aria-label={page.faqLabel} className="pricing-faq">
          {/* No scroll-reveal on FAQ items: IO opacity toggles felt like collapse. */}
          <div className="pricing-section-heading">
            <h2>{page.faqHeading}</h2>
            {page.faqLead ? <p>{page.faqLead}</p> : null}
          </div>

          <div className="pricing-faq-list">
            {page.faqs.map((faq, index) => (
              <details className="pricing-faq-item" key={faq.question} open={index === 0}>
                <summary>
                  <span className="pricing-faq-question">{faq.question}</span>
                  <span aria-hidden="true" className="pricing-faq-marker">
                    <span />
                    <span />
                  </span>
                </summary>
                <div className="pricing-faq-answer">
                  <p>{faq.answer}</p>
                </div>
              </details>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter locale={locale} />
    </div>
  );
}

function FeatureSectionBlock({
  section,
  includedLabel,
}: {
  section: FeatureSection;
  includedLabel: string;
}) {
  return (
    <>
      <div className="pricing-feature-section-row" role="row">
        <div className="pricing-feature-section-title" role="cell">
          {section.title}
        </div>
      </div>
      {section.rows.map((row) => (
        <div className="pricing-feature-row" key={row.feature} role="row">
          <div className="pricing-feature-table-cell pricing-feature-name" role="cell">
            {row.feature}
          </div>
          {row.availability.map((value, index) => (
            <div
              className="pricing-feature-table-cell pricing-feature-value"
              key={`${row.feature}-${index}`}
              role="cell"
            >
              {value === true ? (
                <span className="pricing-feature-check" aria-label={includedLabel}>
                  <CheckIcon />
                </span>
              ) : (
                <span className="pricing-feature-value-text">{value as ReactNode}</span>
              )}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function PricingCard({
  isYearly,
  locale,
  plan,
  promo,
  style,
}: {
  isYearly: boolean;
  locale: PricingLocale;
  plan: PricingPlan;
  promo: PublicPromoActive | null;
  style: CSSProperties;
}) {
  const regularPrice = isYearly ? plan.yearly : plan.monthly;
  const promoPricing = promo ? computeDiscountedPlusPricing(promo) : null;
  const activePromoPercent = promoPricing
    ? isYearly
      ? promoPricing.yearlyPercent
      : promoPricing.monthlyPercent
    : 0;
  const discountedNumeric =
    activePromoPercent > 0 && promoPricing
      ? isYearly
        ? promoPricing.yearlyPerMonth
        : promoPricing.monthlyPerMonth
      : null;
  const baseNumeric =
    isNumeric(plan.yearly) && isNumeric(plan.monthly) ? Number(regularPrice) : null;
  const numericPrice = discountedNumeric ?? baseNumeric;
  const currentPriceLabel =
    numericPrice !== null
      ? Number.isInteger(numericPrice)
        ? String(numericPrice)
        : numericPrice.toFixed(2)
      : regularPrice;
  const promoNote =
    promo && activePromoPercent > 0 ? formatPublicPromoNote({ isYearly, promo, locale }) : null;
  const note = promoNote ?? (isYearly ? plan.yearlyNote : plan.monthlyNote);
  const promoBadge =
    activePromoPercent > 0 ? formatPublicPromoBadge(activePromoPercent, locale) : null;
  const isMailto = plan.href.startsWith('mailto:');
  return (
    <article
      className={[
        'pricing-card',
        `pricing-card-${plan.tone}`,
        plan.featured ? 'pricing-card-featured' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-billing={isYearly ? 'yearly' : 'monthly'}
      style={style}
    >
      <span aria-hidden="true" className="pricing-card-glow" />

      <header className="pricing-card-head">
        <span
          className={`pricing-plan-eyebrow${plan.featured ? '' : ' is-placeholder'}`}
          aria-hidden={plan.featured ? undefined : true}
        >
          {plan.featured ? plan.eyebrow : ''}
          {promoBadge ? <span className="pricing-promo-badge">{promoBadge}</span> : null}
        </span>
        <h2 className="pricing-plan-name">{plan.name}</h2>
        <p className="pricing-plan-desc">{plan.description}</p>
      </header>

      <div className="pricing-price-row">
        {plan.prefix ? <span className="pricing-price-prefix">{plan.prefix}</span> : null}
        {numericPrice !== null ? (
          <NumberFlow
            aria-label={`${currentPriceLabel}${plan.unit}`}
            className="pricing-price-value"
            format={{
              useGrouping: false,
              minimumFractionDigits: Number.isInteger(numericPrice) ? 0 : 2,
              maximumFractionDigits: Number.isInteger(numericPrice) ? 0 : 2,
            }}
            opacityTiming={PRICE_OPACITY_TIMING}
            spinTiming={PRICE_NUMBER_TIMING}
            transformTiming={PRICE_NUMBER_TIMING}
            value={numericPrice}
            willChange
          />
        ) : (
          <span className="pricing-price-custom">{regularPrice}</span>
        )}
        {discountedNumeric !== null ? (
          <s className="pricing-price-strike">
            {plan.prefix}
            {regularPrice}
          </s>
        ) : null}
        {plan.unit ? <span className="pricing-price-unit">{plan.unit}</span> : null}
      </div>

      <p className="pricing-price-note">
        <span className="pricing-price-note-text" key={note}>
          {note}
        </span>
      </p>

      <SiteAnchor
        className={`pricing-card-cta${plan.featured ? ' pricing-card-cta-primary' : ''}`}
        href={plan.href}
        rel={isMailto ? 'noopener' : undefined}
        target={isMailto ? '_blank' : '_self'}
      >
        <span>{plan.cta}</span>
        <ArrowIcon />
      </SiteAnchor>

      {plan.secondaryCta ? (
        <SiteAnchor
          className="pricing-card-secondary-cta"
          href={plan.secondaryCta.href}
          rel="noreferrer"
          target="_blank"
        >
          {plan.secondaryCta.label}
        </SiteAnchor>
      ) : null}

      <ul className="pricing-card-features">
        {plan.features.map((feature) => {
          const key = typeof feature === 'string' ? feature : feature.label;
          return (
            <li key={key}>
              <CheckIcon className="pricing-card-check" />
              {typeof feature === 'string' ? (
                <span>{feature}</span>
              ) : (
                <SiteAnchor className="pricing-card-feature-link" href={feature.href}>
                  {feature.label}
                </SiteAnchor>
              )}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 16 16">
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" className="pricing-card-cta-arrow" fill="none" viewBox="0 0 16 16">
      <path
        d="M3 8h10M9 4l4 4-4 4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  );
}

function isNumeric(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

export default PricingPage;
