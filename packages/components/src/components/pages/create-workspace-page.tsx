import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, Building2, CreditCard } from 'lucide-react';
import { Loader2 } from 'lucide-react';

import { Button } from '@lody/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { PricingPageLink } from '../shared/pricing-page-link';
import { SubscribeConsentNotice } from '../shared/subscribe-consent-notice';
import { formatUsd } from '../settings/billing-setting-pure';

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
  slugChecking?: boolean;
  slugAvailable?: boolean;
  slugErrorType?: string | null;
  canResetSlug?: boolean;
  paidRequired?: boolean;
  billingInterval?: 'month' | 'year';
  /** Per-seat Plus pricing; `undefined`/`null` = not loaded, prices hidden. */
  pricing?: CreateWorkspacePricing | null;
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
  slugChecking = false,
  slugAvailable = false,
  slugErrorType = null,
  canResetSlug = false,
  paidRequired = false,
  billingInterval = 'year',
  pricing = null,
  onWorkspaceNameChange,
  onWorkspaceSlugChange,
  onResetWorkspaceSlug,
  onBackToWorkspace,
  onBillingIntervalChange,
  onSubmit,
}: CreateWorkspacePageProps) {
  const { t } = useTranslation();
  const yearlyEarlyBirdSelected =
    billingInterval === 'year' && pricing?.yearlyOfferKey === 'early_bird_yearly_6000_forever';

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        {onBackToWorkspace ? (
          <Button
            type="button"
            variant="ghost"
            size="small"
            onClick={onBackToWorkspace}
            disabled={creating}
            className="mb-3 -ml-2"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('organization.backToPreviousWorkspace', 'Back to previous workspace')}
          </Button>
        ) : null}

        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Building2 className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-2xl">
              {paidRequired
                ? t('organization.createPlusWorkspaceTitle', 'Create a Plus workspace')
                : t('organization.welcomeTitle', 'Welcome to Lody Agent')}
            </CardTitle>
            <CardDescription className="mt-2 whitespace-pre-line">
              {paidRequired
                ? t(
                    'organization.createPlusWorkspaceDescription',
                    'Your free workspace limit is full. This workspace will activate after checkout.'
                  )
                : t(
                    'organization.welcomeDescription',
                    "Let's create your first workspace to get started"
                  )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="workspace-name">{t('organization.workspaceName')}</Label>
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
                  className={error ? 'border-destructive' : ''}
                />
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
                <p className="text-xs text-muted-foreground">
                  {t(
                    'organization.workspaceNameHint',
                    'You can change this name later in settings'
                  )}
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="workspace-slug">{t('organization.workspaceSlug')}</Label>
                  <div className="flex items-center gap-2">
                    {canResetSlug ? (
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground"
                        onClick={onResetWorkspaceSlug}
                        disabled={creating}
                      >
                        {t('organization.workspaceSlugReset')}
                      </button>
                    ) : null}
                    {workspaceSlug && !slugErrorType ? (
                      <span className="text-xs text-muted-foreground">
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
                  className={slugErrorType ? 'border-destructive' : ''}
                />
                {slugErrorType ? (
                  <p className="text-xs text-destructive">
                    {t(`organization.workspaceSlugError.${slugErrorType}`)}
                  </p>
                ) : null}
              </div>

              {paidRequired ? (
                <div className="space-y-2 border-t border-border/60 pt-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <CreditCard className="h-4 w-4" />
                    {t('organization.plusBillingInterval', 'Billing interval')}
                  </div>
                  <div className="grid grid-cols-2 rounded-lg border border-border bg-muted/40 p-0.5">
                    {(['year', 'month'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => onBillingIntervalChange?.(value)}
                        disabled={creating}
                        className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                          billingInterval === value
                            ? 'bg-background text-foreground shadow-xs'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {value === 'year'
                          ? t('billing.yearly', 'Yearly')
                          : t('billing.monthly', 'Monthly')}
                        {pricing ? (
                          <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
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
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'organization.plusBillingHelp',
                      'Plus is billed per accepted workspace member. Stripe shows the final total before payment.'
                    )}
                  </p>
                  {yearlyEarlyBirdSelected ? (
                    <p className="text-xs font-medium text-foreground">
                      {t('billing.yearlyEarlyBirdCheckoutPromise')}
                    </p>
                  ) : null}
                  <PricingPageLink />
                </div>
              ) : null}

              <Button
                size="large"
                onClick={onSubmit}
                disabled={
                  creating ||
                  !workspaceName.trim() ||
                  slugChecking ||
                  Boolean(slugErrorType) ||
                  !slugAvailable
                }
                className="w-full"
              >
                {creating ? (
                  <span className="flex items-center">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {paidRequired
                      ? t('billing.startingCheckout', 'Starting checkout...')
                      : t('common.creating')}
                  </span>
                ) : (
                  <span className="flex items-center">
                    {paidRequired
                      ? yearlyEarlyBirdSelected
                        ? t('billing.upgradeEarlyBird')
                        : t('organization.continueToCheckout', 'Continue to checkout')
                      : t('organization.createWorkspace', 'Create Workspace')}
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </span>
                )}
              </Button>

              {paidRequired ? <SubscribeConsentNotice className="text-center" /> : null}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
