import { Component, createElement, useCallback, useEffect, useState, type ReactNode } from 'react';
import { atom, useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import type { FunctionReturnType } from 'convex/server';
import type { CloudApi, PromoCampaignName } from '@lody/cloud-api';

type BillingOverview = NonNullable<
  FunctionReturnType<CloudApi['billing']['getBillingOverview']>
>;
import { useCloudQueryState } from '@lody/platform/react';
import { getServerNow } from '@lody/shared';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { button } from '@lody/ui/button/button.tokens.stylex';
import {
  discountBadgeValues,
  resolvePromoCampaignName,
} from '@/components/settings/discount-badge-values';
import { useAuthenticatedConvex } from '@/hooks/use-authenticated-convex';
import { useReferralPolicyRefresh } from '@/hooks/use-referral-policy-refresh';
import { useAppCapability } from '@/lib/app-platform';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { isNativeAppShell } from '@/lib/native-platform';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeShadow,
  themeSpace,
} from '../style/theme-scale.stylex';

export const DISMISSED_PROMO_CAMPAIGNS_STORAGE_KEY = 'lody:dismissedPromoCampaignIds';
const MAX_DISMISSED_CAMPAIGN_IDS = 32;

function readStoredDismissedCampaignIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(DISMISSED_PROMO_CAMPAIGNS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

function writeStoredDismissedCampaignIds(ids: readonly string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      DISMISSED_PROMO_CAMPAIGNS_STORAGE_KEY,
      JSON.stringify(ids.slice(-MAX_DISMISSED_CAMPAIGN_IDS))
    );
  } catch {
    return;
  }
}

const dismissedPromoCampaignIdsAtom = atom<string[] | null>(null);

export function useDismissedPromoCampaigns() {
  const [atomValue, setAtomValue] = useAtom(dismissedPromoCampaignIdsAtom);
  const dismissedIds = atomValue ?? readStoredDismissedCampaignIds();

  useEffect(() => {
    if (atomValue === null) {
      setAtomValue(readStoredDismissedCampaignIds());
    }
  }, [atomValue, setAtomValue]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleStorage = (event: StorageEvent) => {
      if (event.key === DISMISSED_PROMO_CAMPAIGNS_STORAGE_KEY) {
        setAtomValue(readStoredDismissedCampaignIds());
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [setAtomValue]);

  const dismissCampaign = useCallback(
    (campaignId: string) => {
      setAtomValue((previous) => {
        const current = previous ?? readStoredDismissedCampaignIds();
        if (current.includes(campaignId)) return current;
        const next = [...current, campaignId].slice(-MAX_DISMISSED_CAMPAIGN_IDS);
        writeStoredDismissedCampaignIds(next);
        return next;
      });
    },
    [setAtomValue]
  );

  return { dismissedIds, dismissCampaign };
}

export type SidebarPromoOffer =
  | {
      kind: 'new_both';
      campaignId: string;
      name: PromoCampaignName | null;
      yearlyPercent: number;
      monthlyPercent: number;
      yearlyPerSeatMonthCents: number;
    }
  | {
      kind: 'new_yearly';
      campaignId: string;
      name: PromoCampaignName | null;
      yearlyPercent: number;
      yearlyPerSeatMonthCents: number;
    }
  | {
      kind: 'new_monthly';
      campaignId: string;
      name: PromoCampaignName | null;
      monthlyPercent: number;
      monthlyCents: number;
    }
  | {
      kind: 'upgrade_yearly';
      campaignId: string;
      name: PromoCampaignName | null;
      yearlyPercent: number;
    };

function formatPromoUsd(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

export function resolveSidebarPromoOffer(
  overview: BillingOverview | null | undefined,
  nowMs: number
): SidebarPromoOffer | null {
  if (!overview) return null;
  if (overview.checkoutPending || overview.subscriptionSetupPending) return null;
  const promo = overview.pricing.promo;
  const policy = promo?.policy;
  if (!policy) return null;
  if (nowMs < policy.startsAt || nowMs >= policy.endsAt) return null;

  const isPaid =
    overview.effectivePlanTier === 'plus' || overview.effectivePlanTier === 'enterprise';
  const isPromotional = overview.entitlementSource === 'stripe_gift';
  const canScheduleAfterGift =
    Boolean(overview.giftStackingSupported) &&
    Boolean(overview.scheduleManaged) &&
    isPromotional &&
    !overview.autoRenewAfterGift &&
    !overview.canResumeAfterGift &&
    overview.effectivePlanTier === 'plus';

  if (!isPaid || canScheduleAfterGift) {
    const yearlyPercent = overview.pricing.yearlyOfferKey
      ? 0
      : (promo?.yearlyDiscountPercent ?? 0);
    const monthlyPercent = overview.pricing.monthlyOfferKey
      ? 0
      : (promo?.monthlyDiscountPercent ?? 0);
    const yearlyPerSeatMonthCents =
      yearlyPercent > 0
        ? Math.round(
            Math.round((overview.pricing.yearlyAmountCents * (100 - yearlyPercent)) / 100) / 12
          )
        : 0;
    if (yearlyPercent > 0 && monthlyPercent > 0) {
      return {
        kind: 'new_both',
        campaignId: policy.campaignId,
        name: policy.name ?? null,
        yearlyPercent,
        monthlyPercent,
        yearlyPerSeatMonthCents,
      };
    }
    if (yearlyPercent > 0) {
      return {
        kind: 'new_yearly',
        campaignId: policy.campaignId,
        name: policy.name ?? null,
        yearlyPercent,
        yearlyPerSeatMonthCents,
      };
    }
    if (monthlyPercent > 0) {
      return {
        kind: 'new_monthly',
        campaignId: policy.campaignId,
        name: policy.name ?? null,
        monthlyPercent,
        monthlyCents: Math.round(
          (overview.pricing.monthlyAmountCents * (100 - monthlyPercent)) / 100
        ),
      };
    }
    return null;
  }

  if (
    overview.entitlementSource === 'stripe' &&
    overview.billingInterval === 'month' &&
    !overview.scheduleManaged &&
    overview.offerKey !== 'founder_monthly_500_forever' &&
    !overview.cancelAtPeriodEnd &&
    (promo?.upgradeToYearlyDiscountPercent ?? 0) > 0
  ) {
    return {
      kind: 'upgrade_yearly',
      campaignId: policy.campaignId,
      name: policy.name ?? null,
      yearlyPercent: promo!.upgradeToYearlyDiscountPercent!,
    };
  }

  return null;
}

const styles = stylex.create({
  actionSpacing: {
    [button.paddingXSmall]: 'calc(var(--spacing) * 2.5)',
  },
  banner: {
    borderRadius: themeRadius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.8)',
    backgroundColor: {
      default: 'hsl(var(--background) / 0.96)',
      '@supports (backdrop-filter: blur(8px))': 'hsl(var(--background) / 0.88)',
    },
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2.5],
    boxShadow: themeShadow.lg,
    backdropFilter: 'blur(8px)',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: themeSpace[1.5],
  },
  titleGroup: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: themeSpace[1.5],
    minWidth: 0,
  },
  title: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.semibold,
    color: themeColors.foreground,
  },
  closeButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '20px',
    height: '20px',
    marginTop: '-1px',
    marginRight: '-2px',
    padding: 0,
    borderWidth: 0,
    borderRadius: themeRadius.md,
    backgroundColor: {
      default: 'transparent',
      ':hover': 'hsl(var(--hover))',
    },
    color: {
      default: themeColors.mutedForeground,
      ':hover': themeColors.foreground,
    },
    cursor: 'pointer',
  },
  closeIcon: {
    width: '14px',
    height: '14px',
  },
  description: {
    marginTop: themeSpace[1.5],
    fontSize: themeFontSize.xs,
    lineHeight: 1.55,
    color: themeColors.mutedForeground,
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: themeSpace[2],
  },
});

export function SidebarPromoBanner({
  offer,
  onViewOffer,
  onDismiss,
}: {
  offer: SidebarPromoOffer;
  onViewOffer: () => void;
  onDismiss: () => void;
}) {
  const { t, i18n } = useTranslation();
  const customTitle = resolvePromoCampaignName(offer.name, i18n.language);
  const badgeText =
    offer.kind === 'new_monthly'
      ? t('billing.promoMonthlyOfferBadge', discountBadgeValues(offer.monthlyPercent))
      : t('billing.promoYearlyExtraBadge', discountBadgeValues(offer.yearlyPercent));

  const description = (() => {
    switch (offer.kind) {
      case 'new_both': {
        const yearlyVals = discountBadgeValues(offer.yearlyPercent);
        const monthlyVals = discountBadgeValues(offer.monthlyPercent);
        return t('sidebar.promoBanner.descriptionBoth', {
          ...yearlyVals,
          monthlyDiscount: monthlyVals.discount,
          monthlyRate: monthlyVals.rate,
          perMonth: formatPromoUsd(offer.yearlyPerSeatMonthCents),
        });
      }
      case 'new_yearly':
        return t('sidebar.promoBanner.descriptionYearly', {
          ...discountBadgeValues(offer.yearlyPercent),
          perMonth: formatPromoUsd(offer.yearlyPerSeatMonthCents),
        });
      case 'new_monthly':
        return t('sidebar.promoBanner.descriptionMonthly', {
          ...discountBadgeValues(offer.monthlyPercent),
          price: formatPromoUsd(offer.monthlyCents),
        });
      case 'upgrade_yearly':
        return t('sidebar.promoBanner.descriptionUpgrade', discountBadgeValues(offer.yearlyPercent));
    }
  })();

  return (
    <div {...stylex.props(styles.banner)} role="region" aria-label={customTitle ?? t('billing.promoOfferTitle')}>
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.titleGroup)}>
          <span {...stylex.props(styles.title)}>
            {customTitle ?? t('billing.promoOfferTitle')}
          </span>
          <Badge tone="success">{badgeText}</Badge>
        </div>
        <button
          type="button"
          aria-label={t('sidebar.promoBanner.dismiss')}
          onClick={onDismiss}
          {...stylex.props(styles.closeButton)}
        >
          <X {...stylex.props(styles.closeIcon)} aria-hidden="true" />
        </button>
      </div>
      <div {...stylex.props(styles.description)}>{description}</div>
      <div {...stylex.props(styles.actions)}>
        <Button
          type="button"
          size="small"
          height="calc(var(--spacing) * 7)"
          xstyle={styles.actionSpacing}
          onClick={onViewOffer}
        >
          {t('sidebar.promoBanner.viewOffer')}
        </Button>
      </div>
    </div>
  );
}

function SidebarPromoBannerProbe({
  workspaceId,
  onOpenBilling,
}: {
  workspaceId: string;
  onOpenBilling: () => void;
}) {
  const billingAvailable = useAppCapability('billing');
  const { authSessionId } = useAuthenticatedConvex();
  const [policyRefreshKey, setPolicyRefreshKey] = useState(0);
  const bumpPolicyRefresh = useCallback(() => {
    setPolicyRefreshKey((prev) => prev + 1);
  }, []);
  const canQuery = billingAvailable && !isNativeAppShell() && Boolean(authSessionId) && Boolean(workspaceId);
  const { data: overview, error } = useCloudQueryState(
    cloudOperations.billing.getBillingOverview,
    canQuery
      ? { workspaceId, ...(policyRefreshKey ? { policyRefreshKey } : {}) }
      : 'skip'
  );
  const nextBoundary =
    overview?.pricing.promo?.nextChangeAt ?? overview?.pricing.promo?.policy?.endsAt;
  useReferralPolicyRefresh(nextBoundary, bumpPolicyRefresh);
  const { dismissedIds, dismissCampaign } = useDismissedPromoCampaigns();

  if (!canQuery || error || !overview) return null;
  const offer = resolveSidebarPromoOffer(overview, getServerNow());
  if (!offer || dismissedIds.includes(offer.campaignId)) return null;

  return (
    <SidebarPromoBanner
      offer={offer}
      onDismiss={() => dismissCampaign(offer.campaignId)}
      onViewOffer={() => {
        dismissCampaign(offer.campaignId);
        onOpenBilling();
      }}
    />
  );
}

class SidebarPromoBannerBoundary extends Component<
  { scope: string; children?: ReactNode },
  { failedScope: string | null }
> {
  override state = { failedScope: null as string | null };

  static getDerivedStateFromError() {
    return { failedScope: '' };
  }

  override componentDidCatch() {
    this.setState({ failedScope: this.props.scope });
  }

  override render() {
    const { failedScope } = this.state;
    return failedScope === '' || failedScope === this.props.scope ? null : this.props.children;
  }
}

export function SidebarPromoBannerHost({
  workspaceId,
  onOpenBilling,
}: {
  workspaceId: string;
  onOpenBilling: () => void;
}) {
  if (!workspaceId) return null;
  return createElement(
    SidebarPromoBannerBoundary,
    { scope: workspaceId },
    createElement(SidebarPromoBannerProbe, { workspaceId, onOpenBilling })
  );
}
