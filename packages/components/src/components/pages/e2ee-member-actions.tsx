import { managementFailureKind } from '@/lib/e2ee-actionable-failure';
import { workspaceTransferErrorKey } from '../settings/workspace-transfer-errors';
import { useEffect, useRef, useState } from 'react';
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
  /** Reports the key update that followed a confirmed removal. The removal reloads the
   * list and drops this row, so the caller owns what a failed update leaves on screen. */
  onRotationSettled: (replaced: boolean) => void;
  /** Lifts row-level errors (e.g. role change failures) above the list to avoid breaking row flex. */
  onError?: (message: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [rotateAfter, setRotateAfter] = useState(true);
  const mountedRef = useRef(true);
  const managementRef = useRef(props.management);
  managementRef.current = props.management;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const { member, management } = props;
  if (member.role === 'owner') return null;
  const mayRemove = management.actorRole === 'owner' || member.role !== 'admin';
  const role = member.role === 'admin' ? 'member' : 'admin';
  const run = async (work: () => Promise<void>, inDialog = false) => {
    setPending(true);
    setFailure(undefined);
    props.onError?.(undefined);
    try {
      await work();
      if (mountedRef.current) setConfirming(false);
    } catch (error) {
      const kind = managementFailureKind(error);
      const message = transferring
        ? workspaceTransferErrorKey(error)
        : kind === 'generic'
          ? 'e2ee.members.failed'
          : `e2ee.members.error.${kind}`;
      if (mountedRef.current) setFailure(message);
      if (!inDialog) props.onError?.(message);
    } finally {
      if (mountedRef.current) setPending(false);
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
                setFailure(undefined);
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
                setFailure(undefined);
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
      {failure && !confirming && !transferring && !props.onError && (
        <Alert.Root tone="warning">
          <Alert.Description>{t(failure)}</Alert.Description>
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
            <Dialog.Description>
              {t(
                member.devices.some((device) => device.kind === 'personal')
                  ? 'e2ee.members.transferLead'
                  : 'e2ee.members.transferNeedsPersonal'
              )}
            </Dialog.Description>
          </Dialog.Header>
          <ul {...stylex.props(styles.effects)}>
            <li>{t('e2ee.members.transferEffectOwner', { name: props.name })}</li>
            <li>{t('e2ee.members.transferEffectYou')}</li>
            <li>{t('e2ee.members.transferEffectRecord')}</li>
          </ul>
          {failure && (
            <Alert.Root tone="warning">
              <Alert.Description>{t(failure)}</Alert.Description>
            </Alert.Root>
          )}
          <Dialog.Footer>
            <Button variant="ghost" disabled={pending} onClick={() => setTransferring(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="e2ee-member-transfer-confirm"
              disabled={pending || !member.devices.some((device) => device.kind === 'personal')}
              onClick={() => {
                void run(async () => {
                  await management.transfer!(member.membershipId);
                  if (mountedRef.current) setTransferring(false);
                }, true);
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
          {failure && (
            <Alert.Root tone="warning">
              <Alert.Description>{t(failure)}</Alert.Description>
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
                const activeManagement = management;
                void run(async () => {
                  await activeManagement.remove(member.membershipId);
                  if (
                    !rotateAfter ||
                    !activeManagement.rotate ||
                    managementRef.current !== activeManagement
                  )
                    return;
                  // The removal already committed; a failed key update must not
                  // read as a failed removal. It stays a retryable key update.
                  let replaced = true;
                  try {
                    await activeManagement.rotate();
                  } catch (error) {
                    if (error instanceof Error && error.message === 'e2ee_not_open') return;
                    replaced = false;
                  }
                  if (managementRef.current === activeManagement) props.onRotationSettled(replaced);
                }, true);
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
