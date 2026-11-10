import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Menu } from '@lody/ui/menu';
import { Dialog } from '@lody/ui/dialog';
import { Alert } from '@lody/ui/alert';
import { Checkbox } from '@lody/ui/checkbox';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';

const styles = stylex.create({
  effects: {
    margin: 0,
    paddingInlineStart: space[4],
    color: colors.secondaryLabel,
    fontSize: text.subheadlineSize,
    lineHeight: 1.7,
  },
  rotate: { display: 'flex', alignItems: 'center', gap: space[2], fontSize: text.subheadlineSize },
});
import type { LedgerMemberOverview } from '@/lib/e2ee-ledger-overview';

export interface E2eeMemberManagement {
  actorRole: 'owner' | 'admin';
  remove(membershipId: string): Promise<void>;
  setRole(membershipId: string, role: 'admin' | 'member'): Promise<void>;
  /** Replaces the workspace key after a removal, when this device may sign it. Explicit
   * only: the remove dialog offers it as a checked choice the person confirms. */
  rotate?(): Promise<void>;
  /** Owner-only: hands ownership to this member; the current owner becomes an admin. */
  transfer?(membershipId: string): Promise<void>;
}

/** Display affordances only; native signing rechecks the current ledger and target. */
export function E2eeMemberActions(props: {
  member: LedgerMemberOverview;
  name: string;
  management: E2eeMemberManagement;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [rotateAfter, setRotateAfter] = useState(true);
  const [rotateFailed, setRotateFailed] = useState(false);
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
              data-testid="e2ee-member-role"
              data-membership-id={member.membershipId}
              onClick={() => {
                void run(() => management.setRole(member.membershipId, role));
              }}
            >
              {t(role === 'admin' ? 'e2ee.members.promote' : 'e2ee.members.demote')}
            </Menu.Item>
          )}
          {management.actorRole === 'owner' && management.transfer && member.role !== 'guest' && (
            <Menu.Item
              data-testid="e2ee-member-transfer"
              data-membership-id={member.membershipId}
              onClick={() => {
                setFailed(false);
                setTransferring(true);
              }}
            >
              {t('e2ee.members.transfer')}
            </Menu.Item>
          )}
          {mayRemove && (
            <Menu.Item
              data-testid="e2ee-member-remove"
              tone="destructive"
              onClick={() => {
                setFailed(false);
                // Each removal starts from the recommended choice.
                setRotateAfter(true);
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
      {rotateFailed && (
        <Alert.Root tone="warning">
          <Alert.Description>{t('e2ee.members.rotateFailed')}</Alert.Description>
        </Alert.Root>
      )}
      <Dialog.Root
        open={transferring}
        onOpenChange={(open) => {
          if (!pending) setTransferring(open);
        }}
      >
        <Dialog.Content
          data-testid="e2ee-member-transfer-dialog"
          data-membership-id={member.membershipId}
          width={440}
        >
          <Dialog.Header>
            <Dialog.Title>{t('e2ee.members.transferTitle', { name: props.name })}</Dialog.Title>
            <Dialog.Description>{t('e2ee.members.removeLead')}</Dialog.Description>
          </Dialog.Header>
          <ul {...stylex.props(styles.effects)}>
            <li>{t('e2ee.members.transferEffectOwner', { name: props.name })}</li>
            <li>{t('e2ee.members.transferEffectYou')}</li>
            <li>{t('e2ee.members.transferEffectRecord')}</li>
          </ul>
          {failed && (
            <Alert.Root tone="warning">
              <Alert.Description>{t('e2ee.members.failed')}</Alert.Description>
            </Alert.Root>
          )}
          <Dialog.Footer>
            <Button variant="ghost" disabled={pending} onClick={() => setTransferring(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="e2ee-member-transfer-confirm"
              disabled={pending}
              onClick={() => {
                void run(async () => {
                  await management.transfer!(member.membershipId);
                  setTransferring(false);
                });
              }}
            >
              {t('e2ee.members.transfer')}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
      <Dialog.Root
        open={confirming}
        onOpenChange={(open) => {
          if (!pending) setConfirming(open);
        }}
      >
        <Dialog.Content
          data-testid="e2ee-member-remove-dialog"
          data-membership-id={member.membershipId}
          width={440}
        >
          <Dialog.Header>
            <Dialog.Title>{t('e2ee.members.removeTitle', { name: props.name })}</Dialog.Title>
            <Dialog.Description>{t('e2ee.members.removeLead')}</Dialog.Description>
          </Dialog.Header>
          <ul {...stylex.props(styles.effects)}>
            <li>{t('e2ee.members.removeEffectDevices', { name: props.name })}</li>
            <li>{t('e2ee.members.removeEffectFuture', { name: props.name })}</li>
            <li>{t('e2ee.members.removeEffectHistory', { name: props.name })}</li>
          </ul>
          {management.rotate && (
            <label {...stylex.props(styles.rotate)}>
              <Checkbox
                checked={rotateAfter}
                disabled={pending}
                data-testid="e2ee-member-remove-rotate"
                onCheckedChange={(checked) => setRotateAfter(checked === true)}
              />
              {t('e2ee.members.rotateWithRemoval')}
            </label>
          )}
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
                void run(async () => {
                  await management.remove(member.membershipId);
                  setRotateFailed(false);
                  if (!rotateAfter || !management.rotate) return;
                  // The removal already committed; a failed key update must not
                  // read as a failed removal. It stays a retryable key update.
                  try {
                    await management.rotate();
                  } catch {
                    setRotateFailed(true);
                  }
                });
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
