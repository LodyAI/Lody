import { useEffect, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CreditCard, Shield, User } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { Spinner } from '@lody/ui/spinner';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Field as UiField } from '@lody/ui/field';
import { Select } from '@lody/ui/select';
import { Dialog } from '@/ui/dialog';
import { settingsSurface as surface } from './surface';

const styles = stylex.create({
  form: { display: 'flex', flexDirection: 'column', gap: space[4] },
  field: { display: 'flex', flexDirection: 'column', gap: space[1.5] },
  /** A note inside the dialog's form is the region rung: a fill, no edge. */
  note: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: colors.secondaryLabel },
  loading: { display: 'flex', alignItems: 'center', gap: space[2] },
  option: { display: 'flex', alignItems: 'center', gap: space[2] },
  optionIcon: { width: '14px', height: '14px', flexShrink: 0, color: colors.tertiaryLabel },
  icon: { width: '14px', height: '14px', flexShrink: 0 },
  costLine: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space[4],
    fontSize: '13px',
    color: colors.label,
  },
  amount: { fontVariantNumeric: 'tabular-nums' },
  costNote: {
    margin: 0,
    marginTop: space[1],
    fontSize: '12px',
    lineHeight: 1.5,
    color: colors.secondaryLabel,
  },
  /** The renewal is a second fact in the same block: set apart by space, not a rule. */
  renewal: { marginTop: space[2] },
});

export type InviteMemberRole = 'member' | 'admin';

/**
 * What accepting one more invitation costs, as resolved by
 * `billing:getWorkspaceSeatInvitePreview`. `not_billed` covers free workspaces
 * and gift/enterprise entitlements that are not billed per seat.
 */
export type { SeatInvitePreview } from '@lody/cloud-api';
import type { SeatInvitePreview } from '@lody/cloud-api';

export function isSeatInvitePreviewReady(preview?: SeatInvitePreview | null): boolean {
  return preview != null && (preview.status === 'not_billed' || preview.proratedAmount !== null);
}

/** A price estimate is enough to invite; admission also needs current payment readiness. */
export function isSeatAdmissionReady(preview?: SeatInvitePreview | null): boolean {
  return (
    isSeatInvitePreviewReady(preview) && (preview?.status !== 'billed' || !preview.paymentAction)
  );
}

export function SeatAdmissionActions({
  preview,
  pending,
  onRefresh,
  onOpenBilling,
}: {
  preview?: SeatInvitePreview | null;
  pending: boolean;
  onRefresh?: () => void;
  onOpenBilling?: () => void;
}) {
  const { t } = useTranslation();
  if (preview?.status !== 'billed' || !preview.paymentAction) return null;
  const blocked = preview.paymentAction !== 'refresh';
  return (
    <>
      {onRefresh && (
        <Button variant={blocked ? 'ghost' : 'primary'} disabled={pending} onClick={onRefresh}>
          {t('billing.seatRefreshPayment')}
        </Button>
      )}

      {blocked &&
        (onOpenBilling ? (
          <Button disabled={pending} onClick={onOpenBilling}>
            {t(
              preview.paymentAction === 'method_required'
                ? 'billing.seatResolveMethod'
                : 'billing.seatResolvePayment'
            )}
          </Button>
        ) : (
          <p>{t('billing.seatResolveOnWeb')}</p>
        ))}
    </>
  );
}

export interface InviteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceName: string;
  /** Free-plan member cap; null when the workspace is paid. */
  memberLimit?: number | null;
  memberLimitReached?: boolean;
  /** Whether this surface may navigate to billing purchase controls. */
  billingUiAvailable?: boolean;
  hasAdminPermission?: boolean;
  /** `undefined` while loading; `null` when seat billing state is unavailable. */
  seatPreview?: SeatInvitePreview | null;
  inviting?: boolean;
  onInvite: (email: string, role: InviteMemberRole) => void | Promise<void>;
  onOpenBilling?: () => void;
}

/**
 * Invite dialog shared by the desktop and mobile account settings. A paid
 * workspace accrues a prorated fee when a member joins and collects it later.
 * Sending an invitation itself never incurs a charge.
 */
export function InviteMemberDialog({
  open,
  onOpenChange,
  workspaceName,
  memberLimit = null,
  memberLimitReached = false,
  billingUiAvailable = true,
  hasAdminPermission = false,
  seatPreview,
  inviting = false,
  onInvite,
  onOpenBilling,
}: InviteMemberDialogProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteMemberRole>('member');

  // Reopening the dialog must not resurrect the previous draft.
  useEffect(() => {
    if (!open) return;
    setEmail('');
    setRole('member');
  }, [open]);

  const submit = () => {
    if (!email.trim() || inviting || !isSeatInvitePreviewReady(seatPreview)) return;
    void onInvite(email, role);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submit();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>
            {memberLimitReached
              ? t(
                  billingUiAvailable
                    ? 'workspace.invite.limitTitle'
                    : 'workspace.invite.mobileLimitTitle'
                )
              : t('workspace.invite.titleWithWorkspace', { workspace: workspaceName })}
          </Dialog.Title>
          <Dialog.Description>
            {memberLimitReached
              ? t('workspace.invite.limitDescription', { limit: memberLimit ?? 3 })
              : t('workspace.invite.description')}
          </Dialog.Description>
        </Dialog.Header>

        {memberLimitReached ? (
          <p {...stylex.props(surface.formBlock, styles.note)}>
            {t(
              billingUiAvailable
                ? 'workspace.invite.limitAlertDescription'
                : 'workspace.invite.mobileLimitAlertDescription'
            )}
          </p>
        ) : (
          <div {...stylex.props(styles.form)}>
            <div {...stylex.props(styles.field)}>
              <UiField.Label htmlFor="invite-email">{t('workspace.invite.email')}</UiField.Label>
              <Input
                id="invite-email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('workspace.invite.emailPlaceholder')}
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>

            <div {...stylex.props(styles.field)}>
              <UiField.Label htmlFor="invite-role">{t('workspace.invite.role')}</UiField.Label>
              <Select.Root
                items={[
                  { value: 'member', label: t('organization.role.member') },
                  { value: 'admin', label: t('organization.role.admin') },
                ]}
                value={role}
                onValueChange={(value) => {
                  if (value != null) setRole(value as InviteMemberRole);
                }}
              >
                <Select.Trigger id="invite-role">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="member">
                    <div {...stylex.props(styles.option)}>
                      <User {...stylex.props(styles.optionIcon)} />
                      <span>{t('organization.role.member')}</span>
                    </div>
                  </Select.Item>
                  <Select.Item value="admin">
                    <div {...stylex.props(styles.option)}>
                      <Shield {...stylex.props(styles.optionIcon)} />
                      <span>{t('organization.role.admin')}</span>
                    </div>
                  </Select.Item>
                </Select.Content>
              </Select.Root>
              <UiField.Description>
                {role === 'admin'
                  ? t('workspace.invite.roleHintAdmin')
                  : t('workspace.invite.roleHintMember')}
              </UiField.Description>
            </div>

            <SeatCostNotice
              preview={seatPreview}
              onOpenBilling={billingUiAvailable ? onOpenBilling : undefined}
            />
          </div>
        )}

        <Dialog.Footer>
          <Button
            variant="secondary"
            size="small"
            onClick={() => onOpenChange(false)}
            disabled={inviting}
          >
            {memberLimitReached ? t('common.close') : t('common.cancel')}
          </Button>
          {memberLimitReached ? (
            hasAdminPermission &&
            billingUiAvailable &&
            onOpenBilling && (
              <Button
                size="small"
                onClick={() => {
                  onOpenChange(false);
                  onOpenBilling();
                }}
              >
                <CreditCard {...stylex.props(styles.icon)} />
                {t('workspace.invite.upgradeButton')}
              </Button>
            )
          ) : (
            <Button
              size="small"
              onClick={submit}
              disabled={!email.trim() || inviting || !isSeatInvitePreviewReady(seatPreview)}
            >
              {inviting && <Spinner size="small" />}
              {inviting ? t('common.inviting') : t('common.invite')}
            </Button>
          )}
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** Admission accrues a daily-prorated charge; collection happens later. */
export function SeatCostNotice({
  preview,
  onOpenBilling,
}: {
  preview?: SeatInvitePreview | null;
  onOpenBilling?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const formatDate = (value: number) =>
    new Intl.DateTimeFormat(i18n.language.replace('_', '-'), { dateStyle: 'medium' }).format(value);

  if (preview === null)
    return (
      <p role="status" {...stylex.props(surface.formBlock, styles.note)}>
        {t('workspace.invite.seat.unavailable')}
      </p>
    );

  if (preview === undefined) {
    return (
      <div {...stylex.props(surface.formBlock, styles.note, styles.loading)}>
        <Spinner size="small" />
        {t('workspace.invite.seat.loading')}
      </div>
    );
  }

  if (preview.status === 'not_billed') {
    // A free workspace has no seat billing at all — say nothing rather than
    // adding an empty cost box below the form.
    if (preview.reason === 'free') return null;
    return (
      <p {...stylex.props(surface.formBlock, styles.note)}>
        {preview.availableSeats !== undefined
          ? t('workspace.invite.seat.available', { count: preview.availableSeats })
          : t('workspace.invite.seat.covered')}
      </p>
    );
  }

  const formatAmount = (amount: number) =>
    new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: preview.currency ?? 'usd',
    }).format(amount / 100);
  if (preview.proratedAmount === null)
    return (
      <p role="status" {...stylex.props(surface.formBlock, styles.note)}>
        {t('workspace.invite.seat.unavailable')}
      </p>
    );
  const yearly = preview.interval === 'year';
  return (
    <div {...stylex.props(surface.formBlock)}>
      <div {...stylex.props(styles.costLine)}>
        <span>{t('workspace.invite.seat.addsSeats', { count: preview.addedSeats ?? 1 })}</span>
        <span {...stylex.props(styles.amount)}>
          {preview.proratedAmount === null
            ? t('workspace.invite.seat.amountUnknown')
            : t('workspace.invite.seat.approxAmount', {
                amount: formatAmount(preview.proratedAmount),
              })}
        </span>
      </div>
      <p {...stylex.props(styles.costNote)}>{t('workspace.invite.seat.acceptanceNote')}</p>
      {preview.paymentAction && (
        <p role="status" {...stylex.props(styles.costNote)}>
          {t(
            preview.paymentAction === 'method_required'
              ? 'workspace.invite.seat.methodRequired'
              : preview.paymentAction === 'payment_required'
                ? 'workspace.invite.seat.paymentRequired'
                : 'workspace.invite.seat.paymentCheck'
          )}
        </p>
      )}
      {preview.paymentAction && onOpenBilling && (
        <Button variant="secondary" size="small" onClick={onOpenBilling}>
          {t('workspace.invite.seat.manageBilling')}
        </Button>
      )}
      {preview.currentPeriodEnd !== null && (
        <p {...stylex.props(styles.costNote)}>
          {t('workspace.invite.seat.serviceThrough', {
            date: formatDate(preview.currentPeriodEnd),
          })}
        </p>
      )}
      {preview.invoiceAt != null && (
        <p {...stylex.props(styles.costNote)}>
          {t('workspace.invite.seat.collectionDate', { date: formatDate(preview.invoiceAt) })}
        </p>
      )}
      <p {...stylex.props(styles.costNote)}>
        {yearly
          ? t('workspace.invite.seat.chargeNoteYear')
          : t('workspace.invite.seat.chargeNoteMonth')}
      </p>
      {preview.nextRenewalAmount === null && (
        <p {...stylex.props(styles.costNote)}>{t('workspace.invite.seat.renewalUnknown')}</p>
      )}
      {preview.currentPeriodEnd !== null && preview.nextRenewalAmount !== null && (
        <p {...stylex.props(styles.costNote, styles.renewal)}>
          {yearly
            ? t('workspace.invite.seat.renewalYear', {
                date: formatDate(preview.currentPeriodEnd),
                amount: formatAmount(preview.nextRenewalAmount),
                seats: preview.nextSeatCount,
              })
            : t('workspace.invite.seat.renewalMonth', {
                date: formatDate(preview.currentPeriodEnd),
                amount: formatAmount(preview.nextRenewalAmount),
                seats: preview.nextSeatCount,
              })}
        </p>
      )}
    </div>
  );
}
