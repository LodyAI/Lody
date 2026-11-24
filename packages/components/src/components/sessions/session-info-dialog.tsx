import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { themeSpace as appSpace } from '../../style/theme-scale.stylex';
import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Copy } from 'lucide-react';
import type { PrStatus } from '@lody/shared';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { Spinner } from '@lody/ui/spinner';
import type { WorkspaceMember } from '@/hooks/use-workspace-members';
import { writeTextToClipboard } from '@/lib/clipboard';
import type { SessionSharingState } from '@/lib/session-sharing';
import { toast } from '@/lib/toast';
import { Menu } from '@/ui/menu';
import { UserAvatar } from '@/components/user-avatar';
import {
  getSessionSharingDescription,
  getSessionSharingLabel,
  type SessionSharingTranslator,
} from '@/components/session-sharing';
import { PR_STATUS_META } from './pull-request-badge';

/**
 * Owner-transfer state for the session info dialog. Only resolved on
 * multi-member workspaces — a solo workspace has nobody to hand the session to,
 * so the caller passes `undefined` and the owner row never renders.
 */
export type SessionOwnerMenuState = {
  members: WorkspaceMember[];
  getDisabledReason?: (userId: string) => string | null;
  /** Current `SessionMeta.userId`; may name someone who already left. */
  ownerUserId: string;
  onChangeOwner: (userId: string) => void | Promise<void>;
  /** Member whose write is still in flight — keeps the row from looking inert. */
  pendingUserId?: string | null;
};

export type SessionInfoPullRequest = {
  number: number | null;
  status: PrStatus;
  onOpen: () => void;
};

export type SessionInfoDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoFullName?: string;
  currentBranch?: string;
  /** Shown only when it differs from the current branch. */
  baseBranch?: string;
  pullRequest?: SessionInfoPullRequest;
  machineName?: string | null;
  /** Local-project sessions say whether they run in a worktree or the folder itself. */
  placement?: 'worktree' | 'local';
  workspacePath?: string;
  sharing?: SessionSharingState;
  /** Omitted for archived sessions and solo workspaces. */
  owner?: SessionOwnerMenuState;
  t: SessionSharingTranslator;
};

const styles = stylex.create({
  rows: { display: 'flex', flexDirection: 'column', minWidth: 0, margin: 0 },
  row: {
    display: 'grid',
    gridTemplateColumns: '6.5rem minmax(0, 1fr) auto',
    alignItems: 'center',
    columnGap: space[3],
    minHeight: '36px',
    paddingBlock: space[1],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: { default: colors.separator, ':last-child': 'transparent' },
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
  },
  label: { margin: 0, color: colors.secondaryLabel },
  value: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    margin: 0,
    color: colors.label,
  },
  truncate: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  mono: { fontFamily: 'var(--font-mono)' },
  stack: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  secondary: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
  },
  action: { display: 'flex', justifyContent: 'flex-end' },
});

function InfoRow({
  label,
  children,
  action,
}: {
  label: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.row)}>
      <dt {...stylex.props(styles.label)}>{label}</dt>
      <dd {...stylex.props(styles.value)}>{children}</dd>
      <div {...stylex.props(styles.action)}>{action}</div>
    </div>
  );
}

/**
 * Where a session lives and who may open it, in one place: repository,
 * branches, pull request, machine, path, access and owner. It replaces the
 * identity rows that used to stack at the top of the header "⋯" menu.
 */
export function SessionInfoDialog({
  open,
  onOpenChange,
  repoFullName,
  currentBranch,
  baseBranch,
  pullRequest,
  machineName,
  placement,
  workspacePath,
  sharing,
  owner,
  t,
}: SessionInfoDialogProps) {
  const copyLabel = t('sessions.infoCard.copy', 'Copy');
  const copyButton = (value: string, label: string, copiedMessage: string) => (
    <Button
      variant="ghost"
      size="small"
      icon
      aria-label={`${copyLabel} ${label}`}
      title={copyLabel}
      onClick={() => {
        void writeTextToClipboard(value).then((ok) => {
          if (ok) toast.success(copiedMessage);
          else toast.error(t('sessions.copyFailed', 'Unable to copy'));
        });
      }}
    >
      <Copy aria-hidden="true" />
    </Button>
  );

  const showBaseBranch = Boolean(baseBranch && baseBranch !== currentBranch);
  const branch = currentBranch || baseBranch || '';
  const prMeta = pullRequest ? (PR_STATUS_META[pullRequest.status] ?? PR_STATUS_META.open) : null;
  const ownerMember = owner?.members.find((member) => member.userId === owner.ownerUserId);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content width={480} data-testid="session-info-dialog">
        <Dialog.Header>
          <Dialog.Title>{t('sessions.info.title', 'Session info')}</Dialog.Title>
        </Dialog.Header>
        <dl {...stylex.props(styles.rows)}>
          {repoFullName ? (
            <InfoRow
              label={t('sessions.infoCard.repository', 'Repository')}
              action={copyButton(
                repoFullName,
                t('sessions.infoCard.repository', 'Repository'),
                t('sessions.repoCopied', 'Repository name copied to clipboard')
              )}
            >
              <span {...stylex.props(styles.truncate)} title={repoFullName}>
                {repoFullName}
              </span>
            </InfoRow>
          ) : null}
          {branch ? (
            <InfoRow
              label={t('sessions.infoCard.branch', 'Branch')}
              action={copyButton(
                branch,
                t('sessions.infoCard.branch', 'Branch'),
                currentBranch
                  ? t('sessions.currentBranchCopied', 'Current branch name copied to clipboard')
                  : t('sessions.baseBranchCopied', 'Base branch name copied to clipboard')
              )}
            >
              <span {...stylex.props(styles.truncate, styles.mono)} title={branch}>
                {branch}
              </span>
            </InfoRow>
          ) : null}
          {showBaseBranch && baseBranch ? (
            <InfoRow
              label={t('sessions.baseBranch', 'Base branch')}
              action={copyButton(
                baseBranch,
                t('sessions.baseBranch', 'Base branch'),
                t('sessions.baseBranchCopied', 'Base branch name copied to clipboard')
              )}
            >
              <span {...stylex.props(styles.truncate, styles.mono)} title={baseBranch}>
                {baseBranch}
              </span>
            </InfoRow>
          ) : null}
          {pullRequest && prMeta ? (
            <InfoRow label={t('sessions.infoCard.pullRequest', 'Pull request')}>
              <Button
                variant="link"
                onClick={() => {
                  onOpenChange(false);
                  pullRequest.onOpen();
                }}
                aria-label={`${t('sessions.pr.openTab', 'Open pull request')}${
                  pullRequest.number != null ? ` #${pullRequest.number}` : ''
                }`}
              >
                {pullRequest.number != null ? `#${pullRequest.number}` : 'PR'}
              </Button>
              <span {...stylex.props(styles.secondary)}>
                {t(prMeta.labelKey, prMeta.labelFallback)}
              </span>
            </InfoRow>
          ) : null}
          {machineName ? (
            <InfoRow label={t('sessions.machineLabel', 'Machine')}>
              <span {...stylex.props(styles.truncate)} title={machineName}>
                {machineName}
              </span>
              {placement ? (
                <Badge>
                  {placement === 'worktree'
                    ? t('chat.workdir.worktree', 'Worktree')
                    : t('chat.workdir.local', 'Local')}
                </Badge>
              ) : null}
            </InfoRow>
          ) : null}
          {workspacePath ? (
            <InfoRow
              label={t('sessions.info.path', 'Path')}
              action={copyButton(
                workspacePath,
                t('sessions.info.path', 'Path'),
                t('sessions.workspacePathCopied', 'Session workspace path copied to clipboard')
              )}
            >
              <span {...stylex.props(styles.truncate, styles.mono)} title={workspacePath}>
                {workspacePath}
              </span>
            </InfoRow>
          ) : null}
          {sharing ? (
            <InfoRow label={t('sessions.sharing.visibility', 'Visibility')}>
              <span {...stylex.props(styles.stack)}>
                <span {...stylex.props(styles.truncate)}>{getSessionSharingLabel(t, sharing)}</span>
                <span {...stylex.props(styles.secondary)}>
                  {getSessionSharingDescription(t, sharing)}
                </span>
              </span>
            </InfoRow>
          ) : null}
          {owner ? (
            <InfoRow
              label={t('sessions.owner.label', 'Owner')}
              action={<SessionOwnerPicker owner={owner} t={t} />}
            >
              {ownerMember ? (
                <UserAvatar
                  user={{
                    id: ownerMember.userId,
                    name: ownerMember.name,
                    image: ownerMember.image,
                  }}
                  size="mini"
                  {...stylex.props(themeStyles.layout)}
                />
              ) : null}
              <span {...stylex.props(styles.truncate)}>
                {ownerMember?.name ?? t('sessions.owner.unknown', 'Unknown')}
              </span>
            </InfoRow>
          ) : null}
        </dl>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function SessionOwnerPicker({
  owner,
  t,
}: {
  owner: SessionOwnerMenuState;
  t: SessionSharingTranslator;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button variant="secondary" size="small">
            {owner.pendingUserId != null ? <Spinner size="small" label={null} /> : null}
            {t('sessions.owner.changeShort', 'Change')}
          </Button>
        }
      />
      <Menu.Content align="end" xstyle={themeStyles.glyph}>
        <Menu.RadioGroup
          value={owner.ownerUserId}
          onValueChange={(userId) => {
            // Guard in the handler, not just via `disabled`: the
            // menu stays mounted while the write is in flight.
            if (
              userId === owner.ownerUserId ||
              owner.pendingUserId != null ||
              owner.getDisabledReason?.(userId)
            )
              return;
            void owner.onChangeOwner(userId);
          }}
        >
          {owner.members.map((member) => {
            const isPending = owner.pendingUserId === member.userId;
            const disabledReason = owner.getDisabledReason?.(member.userId);
            return (
              <Menu.RadioItem
                key={member.userId}
                value={member.userId}
                disabled={owner.pendingUserId != null || !!disabledReason}
                title={disabledReason ?? member.email ?? member.name}
                indicator="check"
                indicatorSide="end"
                endContent={isPending ? <Spinner className={stylex.props(themeStyles.glyph2).className} /> : undefined}
              >
                <UserAvatar
                  user={{ id: member.userId, name: member.name, image: member.image }}
                  size="mini"
                  {...stylex.props(themeStyles.layout)}
                />
                {member.name}
                {disabledReason ? <span>{disabledReason}</span> : null}
              </Menu.RadioItem>
            );
          })}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Root>
  );
}

const themeStyles = stylex.create({
  layout: { flexShrink: 0 },
  glyph: { maxHeight: 'calc(var(--spacing) * 72)', minWidth: '200px', maxWidth: '280px', overflowY: 'auto' },
  glyph2: { height: appSpace[3.5], width: appSpace[3.5], flexShrink: 0 },
});
