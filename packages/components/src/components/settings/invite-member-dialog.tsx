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
import { formatDate, formatUsd } from './billing-setting-pure';
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
export type SeatInvitePreview =
  | { status: 'not_billed'; reason: 'free' | 'covered' }
  | {
      status: 'billed';
      interval: 'month' | 'year';
      /** Per-seat list price for the current interval. */
      unitAmount: number;
      /** Estimated charge on acceptance; null when the period is unknown. */
      proratedAmount: number | null;
      currentPeriodEnd: number | null;
      seatCount: number;
      nextSeatCount: number;
      nextRenewalAmount: number;
    };

export interface InviteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceName: string;
  /** Free-plan member cap; null when the workspace is paid. */
  memberLimit?: number | null;
  memberLimitReached?: boolean;
  /** Billing copy and prices are hidden on native shells. */
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
 * workspace bills per seat and Stripe invoices the prorated difference as soon
 * as the invitee accepts, so the seat cost is stated here — before sending —
 * rather than showing up unannounced on the next invoice.
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
    if (!email.trim() || inviting) return;
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

            {billingUiAvailable && <SeatCostNotice preview={seatPreview} />}
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
            <Button size="small" onClick={submit} disabled={!email.trim() || inviting}>
              {inviting && <Spinner size="small" />}
              {inviting ? t('common.inviting') : t('common.invite')}
            </Button>
          )}
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * Seat cost for this invitation. A paid workspace is charged the prorated
 * remainder of the current period the moment the invitee accepts, so the
 * amount is an estimate until Stripe settles it at that point.
 */
function SeatCostNotice({ preview }: { preview?: SeatInvitePreview | null }) {
  const { t } = useTranslation();

  if (preview === null) return null;

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
      <p {...stylex.props(surface.formBlock, styles.note)}>{t('workspace.invite.seat.covered')}</p>
    );
  }

  const yearly = preview.interval === 'year';
  return (
    <div {...stylex.props(surface.formBlock)}>
      <div {...stylex.props(styles.costLine)}>
        <span>{t('workspace.invite.seat.addsSeat')}</span>
        <span {...stylex.props(styles.amount)}>
          {preview.proratedAmount === null
            ? t('workspace.invite.seat.amountUnknown')
            : t('workspace.invite.seat.approxAmount', {
                amount: formatUsd(preview.proratedAmount),
              })}
        </span>
      </div>
      <p {...stylex.props(styles.costNote)}>
        {yearly
          ? t('workspace.invite.seat.chargeNoteYear', { price: formatUsd(preview.unitAmount) })
          : t('workspace.invite.seat.chargeNoteMonth', { price: formatUsd(preview.unitAmount) })}
      </p>
      {preview.currentPeriodEnd !== null && (
        <p {...stylex.props(styles.costNote, styles.renewal)}>
          {yearly
            ? t('workspace.invite.seat.renewalYear', {
                date: formatDate(preview.currentPeriodEnd),
                amount: formatUsd(preview.nextRenewalAmount),
                seats: preview.nextSeatCount,
              })
            : t('workspace.invite.seat.renewalMonth', {
                date: formatDate(preview.currentPeriodEnd),
                amount: formatUsd(preview.nextRenewalAmount),
                seats: preview.nextSeatCount,
              })}
        </p>
      )}
    </div>
  );
}
