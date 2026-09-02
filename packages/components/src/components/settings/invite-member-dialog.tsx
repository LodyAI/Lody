import { useEffect, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CreditCard, Loader2, Shield, User } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { formatDate, formatUsd } from './billing-setting-pure';

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0 sm:p-0">
        <DialogHeader className="px-5 pb-4 pt-5">
          <DialogTitle className="pr-6 text-base">
            {memberLimitReached
              ? t(
                  billingUiAvailable
                    ? 'workspace.invite.limitTitle'
                    : 'workspace.invite.mobileLimitTitle'
                )
              : t('workspace.invite.titleWithWorkspace', { workspace: workspaceName })}
          </DialogTitle>
          <DialogDescription>
            {memberLimitReached
              ? t('workspace.invite.limitDescription', { limit: memberLimit ?? 3 })
              : t('workspace.invite.description')}
          </DialogDescription>
        </DialogHeader>

        {memberLimitReached ? (
          <div className="px-5 pb-5">
            <p className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
              {t(
                billingUiAvailable
                  ? 'workspace.invite.limitAlertDescription'
                  : 'workspace.invite.mobileLimitAlertDescription'
              )}
            </p>
          </div>
        ) : (
          <div className="space-y-4 px-5 pb-5">
            <div className="space-y-1.5">
              <Label htmlFor="invite-email" className="text-xs text-muted-foreground">
                {t('workspace.invite.email')}
              </Label>
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

            <div className="space-y-1.5">
              <Label htmlFor="invite-role" className="text-xs text-muted-foreground">
                {t('workspace.invite.role')}
              </Label>
              <Select value={role} onValueChange={(value) => setRole(value as InviteMemberRole)}>
                <SelectTrigger id="invite-role" className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">
                    <div className="flex items-center gap-2">
                      <User className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>{t('organization.role.member')}</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="admin">
                    <div className="flex items-center gap-2">
                      <Shield className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>{t('organization.role.admin')}</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {role === 'admin'
                  ? t('workspace.invite.roleHintAdmin')
                  : t('workspace.invite.roleHintMember')}
              </p>
            </div>

            {billingUiAvailable && <SeatCostNotice preview={seatPreview} />}
          </div>
        )}

        <DialogFooter className="gap-2 border-t border-border/60 bg-muted/20 px-5 py-3.5">
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
                <CreditCard className="mr-1.5 h-3.5 w-3.5" />
                {t('workspace.invite.upgradeButton')}
              </Button>
            )
          ) : (
            <Button size="small" onClick={submit} disabled={!email.trim() || inviting}>
              {inviting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {inviting ? t('common.inviting') : t('common.invite')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
      <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('workspace.invite.seat.loading')}
      </div>
    );
  }

  if (preview.status === 'not_billed') {
    // A free workspace has no seat billing at all — say nothing rather than
    // adding an empty cost box below the form.
    if (preview.reason === 'free') return null;
    return (
      <p className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
        {t('workspace.invite.seat.covered')}
      </p>
    );
  }

  const yearly = preview.interval === 'year';
  return (
    <div className="rounded-lg border border-border/70 bg-muted/30 p-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm font-medium text-foreground">
          {t('workspace.invite.seat.addsSeat')}
        </span>
        <span className="text-sm font-medium tabular-nums text-foreground">
          {preview.proratedAmount === null
            ? t('workspace.invite.seat.amountUnknown')
            : t('workspace.invite.seat.approxAmount', {
                amount: formatUsd(preview.proratedAmount),
              })}
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {yearly
          ? t('workspace.invite.seat.chargeNoteYear', { price: formatUsd(preview.unitAmount) })
          : t('workspace.invite.seat.chargeNoteMonth', { price: formatUsd(preview.unitAmount) })}
      </p>
      {preview.currentPeriodEnd !== null && (
        <p className="mt-2 border-t border-border/60 pt-2 text-xs leading-relaxed text-muted-foreground">
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
