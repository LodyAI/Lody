import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Menu } from '@lody/ui/menu';
import { Dialog } from '@lody/ui/dialog';
import { Alert } from '@lody/ui/alert';
import type { LedgerMemberOverview } from '@/lib/e2ee-ledger-overview';

export interface E2eeMemberManagement {
  actorRole: 'owner' | 'admin';
  remove(membershipId: string): Promise<void>;
  setRole(membershipId: string, role: 'admin' | 'member'): Promise<void>;
}

/** Display affordances only; native signing rechecks the current ledger and target. */
export function E2eeMemberActions(props: {
  member: LedgerMemberOverview;
  name: string;
  management: E2eeMemberManagement;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const { member, management } = props;
  if (member.role === 'owner') return null;
  const mayRemove = management.actorRole === 'owner' || member.role !== 'admin';
  const role = member.role === 'admin' ? 'member' : 'admin';
  const run = async (work: () => Promise<void>) => {
    setPending(true);
    setFailed(false);
    try {
      await work();
      setConfirming(false);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  if (!mayRemove && management.actorRole !== 'owner') return null;
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          render={
            <Button
              variant="ghost"
              size="small"
              icon
              disabled={pending}
              data-testid="e2ee-member-manage"
              data-membership-id={member.membershipId}
              aria-label={t('e2ee.members.manage', { name: props.name })}
            >
              <MoreHorizontal size={16} />
            </Button>
          }
        />
        <Menu.Content align="end" width="compact">
          {management.actorRole === 'owner' && (
            <Menu.Item
              onClick={() => {
                void run(() => management.setRole(member.membershipId, role));
              }}
            >
              {t(role === 'admin' ? 'e2ee.members.promote' : 'e2ee.members.demote')}
            </Menu.Item>
          )}
          {mayRemove && (
            <Menu.Item
              data-testid="e2ee-member-remove"
              tone="destructive"
              onClick={() => {
                setFailed(false);
                setConfirming(true);
              }}
            >
              {t('e2ee.members.remove')}
            </Menu.Item>
          )}
        </Menu.Content>
      </Menu.Root>
      {failed && !confirming && (
        <Alert.Root tone="warning">
          <Alert.Description>{t('e2ee.members.failed')}</Alert.Description>
        </Alert.Root>
      )}
      <Dialog.Root
        open={confirming}
        onOpenChange={(open) => {
          if (!pending) setConfirming(open);
        }}
      >
        <Dialog.Content width={440}>
          <Dialog.Header>
            <Dialog.Title>{t('e2ee.members.removeTitle', { name: props.name })}</Dialog.Title>
            <Dialog.Description>{t('e2ee.members.removeDescription')}</Dialog.Description>
          </Dialog.Header>
          {failed && (
            <Alert.Root tone="warning">
              <Alert.Description>{t('e2ee.members.failed')}</Alert.Description>
            </Alert.Root>
          )}
          <Dialog.Footer>
            <Button variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="e2ee-member-remove-confirm"
              tone="destructive"
              disabled={pending}
              onClick={() => {
                void run(() => management.remove(member.membershipId));
              }}
            >
              {t('e2ee.members.remove')}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
