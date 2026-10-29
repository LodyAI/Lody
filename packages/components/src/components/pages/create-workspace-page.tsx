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
import type { ReferralPolicy } from '@lody/cloud-api';
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
import { ReferralOfferNotice } from '../settings/referral-settings-pure';

export interface CreateWorkspacePricing {
  monthlyAmountCents: number;
  yearlyAmountCents: number;
  yearlyOfferKey?: string | null;
}

export interface CreateWorkspacePageProps {
  workspaceName: string;
  workspaceSlug: string;
  error?: string | null;
  creating?: boolean;
  fieldsDisabled?: boolean;
  submitDisabled?: boolean;
  retryPendingCreation?: boolean;
  creationOptions?: ReactNode;
  slugChecking?: boolean;
  slugAvailable?: boolean;
  slugErrorType?: string | null;
  canResetSlug?: boolean;
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
  fieldsDisabled = false,
  submitDisabled = false,
  retryPendingCreation = false,
  creationOptions,
  slugChecking = false,
  slugAvailable = false,
  slugErrorType = null,
  canResetSlug = false,
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
    <div {...stylex.props(surface.page)}>
      <div {...stylex.props(surface.card)}>
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
              <Building2 {...stylex.props(surface.heroIcon)} />
            </div>
            <Card.Title className="text-2xl">
              {paidRequired
                ? t('organization.createPlusWorkspaceTitle', 'Create a Plus workspace')
                : t('organization.welcomeTitle', 'Welcome to Lody Agent')}
            </Card.Title>
            <Card.Description {...stylex.props(styles.description)}>
              {paidRequired
                ? t(
                    'organization.createPlusWorkspaceDescription',
                    'Your free workspace limit is full. This workspace will activate after checkout.'
                  )
                : t(
                    'organization.welcomeDescription',
                    "Let's create your first workspace to get started"
                  )}
            </Card.Description>
          </Card.Header>
          <Card.Content>
            <div className="space-y-4">
              <div className="space-y-2">
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
                  disabled={creating || fieldsDisabled}
                  className={error ? 'border-destructive' : ''}
                />
                {error ? <p {...stylex.props(surface.error)}>{error}</p> : null}
                <p {...stylex.props(surface.hint)}>
                  {t(
                    'organization.workspaceNameHint',
                    'You can change this name later in settings'
                  )}
                </p>
              </div>

              <div className="space-y-2">
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
                        disabled={creating || fieldsDisabled}
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
                  disabled={creating || fieldsDisabled}
                  className={slugErrorType ? 'border-destructive' : ''}
                />
                {slugErrorType ? (
                  <p {...stylex.props(surface.smallError)}>
                    {t(`organization.workspaceSlugError.${slugErrorType}`)}
                  </p>
                ) : null}
              </div>

              {creationOptions}

              {paidRequired ? (
                <div className={`space-y-2 ${stylex.props(styles.billing).className}`}>
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
                  {referralOffer &&
                  pricing &&
                  !(billingInterval === 'year' && pricing.yearlyOfferKey) ? (
                    <ReferralOfferNotice
                      interval={billingInterval}
                      regularCents={
                        billingInterval === 'year'
                          ? pricing.yearlyAmountCents
                          : pricing.monthlyAmountCents
                      }
                      disabled={creating}
                      onRemove={referralOffer.onRemove}
                      policy={referralOffer.policy}
                    />
                  ) : null}
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
                  (!retryPendingCreation &&
                    (slugChecking || Boolean(slugErrorType) || !slugAvailable))
                }
                {...stylex.props(surface.fullWidth)}
              >
                {creating ? (
                  <span {...stylex.props(surface.row)}>
                    <Spinner
                      diameter="calc(var(--spacing) * 4)"
                      className={stylex.props(surface.spinnerMargin).className}
                    />
                    {paidRequired
                      ? t('billing.startingCheckout', 'Starting checkout...')
                      : t('common.creating')}
                  </span>
                ) : (
                  <span {...stylex.props(surface.row)}>
                    {retryPendingCreation
                      ? t('e2ee.create.resume')
                      : paidRequired
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
  back: { marginBottom: themeSpace[3], marginLeft: 'calc(var(--spacing) * -2)' },
  hero: {
    marginInline: 'auto',
    marginBottom: themeSpace[4],
    display: 'flex',
    height: themeSpace[12],
    width: themeSpace[12],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    backgroundColor: 'hsl(var(--primary) / 0.1)',
  },
  description: { marginTop: themeSpace[2], whiteSpace: 'pre-line' },
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
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
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
