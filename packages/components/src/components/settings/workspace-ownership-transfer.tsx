import { useId, useRef, useState } from 'react';
import { ConvexError } from 'convex/values';
import { useTranslation } from 'react-i18next';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import type { AccountMember } from './account-setting-pure';

const errorKeys: Record<string, string> = {
  workspace_transfer_not_owner: 'workspace.transfer.errors.notOwner',
  workspace_transfer_invalid_member: 'workspace.transfer.errors.invalidMember',
  workspace_transfer_deleting: 'workspace.transfer.errors.deleting',
  workspace_transfer_billing_owner_mismatch: 'workspace.transfer.errors.support',
  workspace_transfer_contact_support: 'workspace.transfer.errors.support',
  workspace_transfer_billing_busy: 'workspace.transfer.errors.billingBusy',
  workspace_transfer_free_limit: 'workspace.transfer.errors.freeLimit',
};

export function WorkspaceOwnershipTransfer({
  workspaceName,
  currentUserId,
  members,
  onTransfer,
}: {
  workspaceName: string;
  currentUserId: string;
  members: AccountMember[];
  onTransfer: (targetMemberId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = members.filter(
    (member) =>
      member.userId !== currentUserId && ['member', 'admin'].includes(member.role) && member.user
  );
  const target = candidates.find((member) => member.id === targetId);
  const canConfirm = Boolean(target) && confirmation === workspaceName && !busy;
  const changeOpen = (value: boolean) => {
    if (inFlight.current) return;
    setOpen(value);
    setTargetId('');
    setConfirmation('');
    setError(null);
  };
  const submit = async () => {
    if (!canConfirm || !target || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onTransfer(target.id);
      setOpen(false);
    } catch (cause) {
      const code =
        cause instanceof ConvexError && typeof cause.data === 'object' && cause.data !== null
          ? cause.data.code
          : null;
      setError(
        typeof code === 'string'
          ? (errorKeys[code] ?? 'workspace.transfer.errors.failed')
          : 'workspace.transfer.errors.failed'
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t('workspace.transfer.title')}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(candidates.length ? 'workspace.transfer.description' : 'workspace.transfer.noMembers')}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={!candidates.length}
        onClick={() => changeOpen(true)}
      >
        {t('workspace.transfer.button')}
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('workspace.transfer.title')}</DialogTitle>
            <DialogDescription>{t('workspace.transfer.warning')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`${id}-member`}>{t('workspace.transfer.newOwner')}</Label>
              <Select
                value={targetId}
                onValueChange={(value) => {
                  setTargetId(value);
                  setError(null);
                }}
                disabled={busy}
              >
                <SelectTrigger id={`${id}-member`}>
                  <SelectValue placeholder={t('workspace.transfer.selectMember')} />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      {member.user?.name || member.user?.email}
                      {member.user?.name && member.user?.email ? ` (${member.user.email})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-confirm`}>
                {t('workspace.transfer.confirmLabel', { workspace: workspaceName })}
              </Label>
              <Input
                id={`${id}-confirm`}
                value={confirmation}
                disabled={busy}
                autoComplete="off"
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {t(error)}
              </p>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" disabled={busy} onClick={() => changeOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" disabled={!canConfirm} onClick={() => void submit()}>
              {t(busy ? 'workspace.transfer.transferring' : 'workspace.transfer.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
