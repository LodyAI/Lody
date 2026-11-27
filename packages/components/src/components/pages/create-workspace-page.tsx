import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeShadow,
  themeSpace,
} from '../../style/theme-scale.stylex';
import { pageSurface as surface } from './surface';
import type { PromoCheckoutOffer, ReferralPolicy } from '@lody/cloud-api';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, Building2, CreditCard } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import type { ReactNode } from 'react';

import { Button } from '@lody/ui/button';
import { Card } from '@/ui/card';
import { Input } from '@lody/ui/input';
import { Field as UiField } from '@lody/ui/field';
import { PricingPageLink } from '../shared/pricing-page-link';
import { SubscribeConsentNotice } from '../shared/subscribe-consent-notice';
import { formatUsd } from '../settings/billing-setting-pure';
import { PromoOfferNotice, ReferralOfferNotice } from '../settings/referral-settings-pure';

const layoutStyles = stylex.create({
  page: {
    boxSizing: 'border-box',
    height: { default: '100vh', '@supports (height: 100dvh)': '100dvh' },
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    backgroundColor: colors.background,
    paddingBlock: space[3],
    paddingInline: space[4],
  },
  content: {
    width: '100%',
    maxWidth: '28rem',
    flexShrink: 0,
    marginBlock: 'auto',
  },
});

export interface CreateWorkspacePricing {
  monthlyAmountCents: number;
  yearlyAmountCents: number;
  yearlyOfferKey?: string | null;
  promo?: PromoCheckoutOffer | null;
}

export interface CreateWorkspacePageProps {
  workspaceName: string;
  workspaceSlug: string;
  error?: string | null;
  creating?: boolean;
  creatingLabel?: string;
  submitDisabled?: boolean;
  creationOptions?: ReactNode;
  slugChecking?: boolean;
  slugAvailable?: boolean;
  slugErrorType?: string | null;
  canResetSlug?: boolean;
  hasExistingWorkspaces?: boolean;
  paidRequired?: boolean;
  billingInterval?: 'month' | 'year';
  /** Per-seat Plus pricing; `undefined`/`null` = not loaded, prices hidden. */
  pricing?: CreateWorkspacePricing | null;
  /** The server confirmed this checkout would get the referral discount. */
  referralOffer?: { onRemove: () => void; policy?: ReferralPolicy } | null;
  onWorkspaceNameChange: (value: string) => void;
  onWorkspaceSlugChange: (value: string) => void;
  onResetWorkspaceSlug: () => void;
  onBackToWorkspace?: () => void;
  onBillingIntervalChange?: (value: 'month' | 'year') => void;
  onSubmit: () => void;
}

export function CreateWorkspacePage({
  workspaceName,
  workspaceSlug,
  error = null,
  creating = false,
  creatingLabel,
  submitDisabled = false,
  creationOptions,
  slugChecking = false,
  slugAvailable = false,
  slugErrorType = null,
  canResetSlug = false,
  hasExistingWorkspaces = false,
  paidRequired = false,
  billingInterval = 'year',
  pricing = null,
  referralOffer = null,
  onWorkspaceNameChange,
  onWorkspaceSlugChange,
  onResetWorkspaceSlug,
  onBackToWorkspace,
  onBillingIntervalChange,
  onSubmit,
}: CreateWorkspacePageProps) {
  const { t } = useTranslation();

  return (
    <div data-testid="create-workspace-page" {...stylex.props(layoutStyles.page)}>
      <div {...stylex.props(layoutStyles.content)}>
        {onBackToWorkspace ? (
          <Button
            type="button"
            variant="ghost"
            size="small"
            onClick={onBackToWorkspace}
            disabled={creating}
            {...stylex.props(styles.back)}
          >
            <ArrowLeft {...stylex.props(surface.smallIcon)} />
            {t('organization.backToPreviousWorkspace', 'Back to previous workspace')}
          </Button>
        ) : null}

        <Card.Root>
          <Card.Header {...stylex.props(surface.center)}>
            <div {...stylex.props(styles.hero)}>
              <Building2 size={18} strokeWidth={1.75} aria-hidden="true" />
            </div>
            <Card.Title {...stylex.props(surface.authTitle)}>
              {paidRequired
                ? t('organization.createPlusWorkspaceTitle', 'Create a Plus workspace')
                : hasExistingWorkspaces
                  ? t('organization.createNewWorkspace', 'Create New Workspace')
                  : t('organization.welcomeTitle', 'Welcome to Lody')}
            </Card.Title>
            <Card.Description {...stylex.props(styles.description)}>
              {paidRequired
                ? t(
                    'organization.createPlusWorkspaceDescription',
                    'Your free workspace limit is full. This workspace will activate after checkout.'
                  )
                : hasExistingWorkspaces
                  ? t('organization.createNewWorkspaceDescription')
                  : t(
                      'organization.welcomeDescription',
                      "Let's create your first workspace to get started"
                    )}
            </Card.Description>
          </Card.Header>
          <Card.Content>
            <div {...stylex.props(styles.formStack)}>
              <div {...stylex.props(styles.fieldStack)}>
                <UiField.Label htmlFor="workspace-name">
                  {t('organization.workspaceName')}
                </UiField.Label>
                <Input
                  id="workspace-name"
                  type="text"
                  placeholder={t('organization.workspaceNamePlaceholder', 'My Workspace')}
                  value={workspaceName}
                  onChange={(event) => onWorkspaceNameChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !creating) {
                      onSubmit();
                    }
                  }}
                  disabled={creating}
                  xstyle={error ? styles.fieldError : undefined}
                />
                {error ? <p {...stylex.props(surface.error)}>{error}</p> : null}
                <p {...stylex.props(surface.hint)}>
                  {t(
                    'organization.workspaceNameHint',
                    'You can change this name later in settings'
                  )}
                </p>
              </div>

              <div {...stylex.props(styles.fieldStack)}>
                <div {...stylex.props(styles.between)}>
                  <UiField.Label htmlFor="workspace-slug">
                    {t('organization.workspaceSlug')}
                  </UiField.Label>
                  <div {...stylex.props(styles.row)}>
                    {canResetSlug ? (
                      <button
                        type="button"
                        {...stylex.props(styles.reset)}
                        onClick={onResetWorkspaceSlug}
                        disabled={creating}
                      >
                        {t('organization.workspaceSlugReset')}
                      </button>
                    ) : null}
                    {workspaceSlug && !slugErrorType ? (
                      <span {...stylex.props(surface.hint)}>
                        {slugChecking
                          ? t('organization.workspaceSlugChecking')
                          : slugAvailable
                            ? t('organization.workspaceSlugAvailable')
                            : null}
                      </span>
                    ) : null}
                  </div>
                </div>

                <Input
                  id="workspace-slug"
                  type="text"
                  placeholder={t('organization.workspaceSlugPlaceholder', 'my-workspace')}
                  value={workspaceSlug}
                  onChange={(event) => onWorkspaceSlugChange(event.target.value)}
                  disabled={creating}
                  xstyle={slugErrorType ? styles.fieldError : undefined}
                />
                {slugErrorType ? (
                  <p {...stylex.props(surface.smallError)}>
                    {t(`organization.workspaceSlugError.${slugErrorType}`)}
                  </p>
                ) : null}
              </div>

              {creationOptions}

              {paidRequired ? (
                <div {...stylex.props(styles.fieldStack, styles.billing)}>
                  <div {...stylex.props(styles.billingHeading)}>
                    <CreditCard {...stylex.props(surface.smallIcon)} />
                    {t('organization.plusBillingInterval', 'Billing interval')}
                  </div>
                  <div {...stylex.props(styles.intervals)}>
                    {(['year', 'month'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => onBillingIntervalChange?.(value)}
                        disabled={creating}
                        {...stylex.props(
                          styles.interval,
                          billingInterval === value
                            ? styles.intervalSelected
                            : styles.intervalUnselected
                        )}
                      >
                        {value === 'year'
                          ? t('billing.yearly', 'Yearly')
                          : t('billing.monthly', 'Monthly')}
                        {pricing ? (
                          <span {...stylex.props(styles.intervalPrice)}>
                            {t('organization.plusPricePerSeatMonth', {
                              price: formatUsd(
                                value === 'year'
                                  ? Math.round(pricing.yearlyAmountCents / 12)
                                  : pricing.monthlyAmountCents
                              ),
                            })}
                            {value === 'year' ? (
                              <>
                                {' · '}
                                {t('organization.plusPriceBilledYearly')}
                              </>
                            ) : null}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                  {(() => {
                    if (!pricing || (billingInterval === 'year' && pricing.yearlyOfferKey)) {
                      return null;
                    }
                    const regularCents =
                      billingInterval === 'year'
                        ? pricing.yearlyAmountCents
                        : pricing.monthlyAmountCents;
                    const promoPercent =
                      billingInterval === 'year'
                        ? (pricing.promo?.yearlyDiscountPercent ?? 0)
                        : (pricing.promo?.monthlyDiscountPercent ?? 0);
                    const referralPercent = referralOffer
                      ? (referralOffer.policy?.discountPercent ?? 10)
                      : 0;
                    if (promoPercent > 0 && (!referralOffer || promoPercent > referralPercent)) {
                      return (
                        <PromoOfferNotice
                          interval={billingInterval}
                          regularCents={regularCents}
                          discountPercent={promoPercent}
                          policy={pricing.promo?.policy}
                        />
                      );
                    }
                    if (referralOffer) {
                      return (
                        <ReferralOfferNotice
                          interval={billingInterval}
                          regularCents={regularCents}
                          disabled={creating}
                          onRemove={referralOffer.onRemove}
                          policy={referralOffer.policy}
                        />
                      );
                    }
                    return null;
                  })()}
                  <p {...stylex.props(surface.hint)}>
                    {t(
                      'organization.plusBillingHelp',
                      'Plus is billed per accepted workspace member. Stripe shows the final total before payment.'
                    )}
                  </p>
                  <PricingPageLink />
                </div>
              ) : null}

              <Button
                size="large"
                onClick={onSubmit}
                disabled={
                  creating ||
                  submitDisabled ||
                  !workspaceName.trim() ||
                  slugChecking ||
                  Boolean(slugErrorType) ||
                  !slugAvailable
                }
                {...stylex.props(surface.fullWidth)}
              >
                {creating ? (
                  <span {...stylex.props(surface.row)}>
                    <Spinner
                      diameter="calc(var(--spacing) * 4)"
                      className={stylex.props(surface.spinnerMargin).className}
                    />
                    {creatingLabel ??
                      (paidRequired
                        ? t('billing.startingCheckout', 'Starting checkout...')
                        : t('common.creating'))}
                  </span>
                ) : (
                  <span {...stylex.props(surface.row)}>
                    {paidRequired
                      ? t('organization.continueToCheckout', 'Continue to checkout')
                      : t('organization.createWorkspace', 'Create Workspace')}
                    <ArrowRight {...stylex.props(surface.smallIcon, styles.trailingIcon)} />
                  </span>
                )}
              </Button>

              {paidRequired ? <SubscribeConsentNotice {...stylex.props(surface.center)} /> : null}
            </div>
          </Card.Content>
        </Card.Root>
      </div>
    </div>
  );
}

const styles = stylex.create({
  formStack: {
    ':is(*) > :where(:not(:last-child))': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 3)',
    },
  },
  fieldStack: {
    ':is(*) > :where(:not(:last-child))': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 1.5)',
    },
  },
  fieldError: { borderColor: themeColors.destructive },
  back: { marginBottom: themeSpace[2], marginLeft: 'calc(var(--spacing) * -2)' },
  hero: {
    marginInline: 'auto',
    marginBottom: themeSpace[2.5],
    display: 'flex',
    height: themeSpace[10],
    width: themeSpace[10],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.lg,
    backgroundColor: colors.secondaryBackground,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.separator,
    color: colors.label,
  },
  description: { marginTop: themeSpace[1], whiteSpace: 'pre-line' },
  between: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  row: { display: 'flex', alignItems: 'center', gap: themeSpace[2] },
  reset: {
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: { default: themeColors.mutedForeground, ':hover': themeColors.foreground },
  },
  billing: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.6)',
    paddingTop: themeSpace[4],
  },
  billingHeading: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  intervals: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    borderRadius: themeRadius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: themeColors.border,
    backgroundColor: 'hsl(var(--muted) / 0.4)',
    padding: themeSpace[0.5],
  },
  interval: {
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.medium,
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  intervalSelected: {
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
    boxShadow: themeShadow.xs,
  },
  intervalUnselected: {
    color: { default: themeColors.mutedForeground, ':hover': themeColors.foreground },
  },
  intervalPrice: {
    marginTop: themeSpace[0.5],
    display: 'block',
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    fontWeight: themeFontWeight.normal,
    color: themeColors.mutedForeground,
  },
  trailingIcon: { marginLeft: themeSpace[2] },
});
