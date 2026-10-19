import * as stylex from '@stylexjs/stylex';
import { Trans, useTranslation } from 'react-i18next';
import { colors } from '@lody/ui/tokens/colors.stylex';

import { Button } from '@lody/ui/button';
import { SecondaryPage } from '@/components/pages/secondary-page';
// Placeholder workspace avatar until per-workspace avatars are supported.
import workspaceAvatarPlaceholder from '@/assets/icon-transparent.png';

export type AcceptInvitationPageState =
  | 'loading'
  | 'auth_required'
  | 'account_mismatch'
  | 'verification_required'
  | 'idle'
  | 'success'
  | 'error';

export interface AcceptInvitationPageProps {
  state: AcceptInvitationPageState;
  invitationOrganizationName?: string | null;
  organizationName?: string | null;
  inviterName?: string | null;
  inviterEmail?: string | null;
  recipientEmailMasked?: string | null;
  invitationRole?: string | null;
  currentUserEmail?: string | null;
  errorMessage?: string;
  onContinue?: () => void;
  onSwitchAccount?: () => void;
  onVerifyEmail?: () => void;
  onAccept?: () => void;
  onBackHome?: () => void;
}

const styles = stylex.create({
  avatar: {
    width: 26,
    height: 26,
    objectFit: 'contain',
  },
  emphasis: {
    fontWeight: 500,
    color: colors.label,
  },
});

export function AcceptInvitationPage({
  state,
  invitationOrganizationName = null,
  organizationName = null,
  inviterName = null,
  inviterEmail = null,
  recipientEmailMasked = null,
  invitationRole = null,
  currentUserEmail = null,
  errorMessage = '',
  onContinue,
  onSwitchAccount,
  onVerifyEmail,
  onAccept,
  onBackHome,
}: AcceptInvitationPageProps) {
  const { t } = useTranslation();
  const workspaceName =
    invitationOrganizationName?.trim() ||
    organizationName?.trim() ||
    t('invite.idle.fallbackWorkspace', 'Workspace');
  const inviter = inviterName?.trim() || inviterEmail?.trim() || '';
  const normalizedRole = invitationRole?.trim().toLowerCase() || '';
  const roleLabel = normalizedRole
    ? t(`invite.role.${normalizedRole}`, normalizedRole, {
        defaultValue: normalizedRole,
      })
    : '';

  const avatar = (
    <img
      src={workspaceAvatarPlaceholder}
      alt=""
      aria-hidden="true"
      draggable={false}
      {...stylex.props(styles.avatar)}
    />
  );
  const markLabel = t('invite.markLabel', 'Workspace and Lody');
  const roleNote = roleLabel ? t('invite.role.label', 'Role: {{role}}', { role: roleLabel }) : '';

  if (state === 'loading') {
    return (
      <SecondaryPage
        state="arrive"
        from={avatar}
        markLabel={markLabel}
        title={t('invite.processing.title', 'Processing invitation')}
        description={t('invite.processing.description', 'Hang tight, this only takes a moment.')}
      />
    );
  }

  if (state === 'error') {
    return (
      <SecondaryPage
        state="blocked"
        from={avatar}
        markLabel={markLabel}
        title={t('invite.error.title', 'Invitation unavailable')}
        description={errorMessage || t('invite.error.notFound', 'Invitation not found or expired.')}
        actions={
          <Button size="large" variant="secondary" onClick={onBackHome}>
            {t('invite.error.backButton', 'Back to home')}
          </Button>
        }
      />
    );
  }

  if (state === 'success') {
    return (
      <SecondaryPage
        state="done"
        from={avatar}
        markLabel={markLabel}
        title={t('invite.success.title', "You're in")}
        description={
          <Trans
            i18nKey="invite.success.description"
            values={{ workspace: workspaceName }}
            defaults="Welcome to <strong>{{workspace}}</strong> — taking you there now…"
            components={{ strong: <span {...stylex.props(styles.emphasis)} /> }}
          />
        }
      />
    );
  }

  if (state === 'verification_required') {
    return (
      <SecondaryPage
        state="ask"
        from={avatar}
        markLabel={markLabel}
        title={t('invite.verificationRequired.title', 'Verify the invited email')}
        description={t(
          'invite.verificationRequired.description',
          'For security, verify the email address named by this invitation before accepting it.'
        )}
        actions={
          <Button size="large" onClick={onVerifyEmail}>
            {t('invite.verificationRequired.continue', 'Continue to verification')}
          </Button>
        }
      />
    );
  }

  if (state === 'account_mismatch') {
    return (
      <SecondaryPage
        state="ask"
        from={avatar}
        markLabel={markLabel}
        title={t('invite.accountMismatch.title', 'Switch accounts to continue')}
        description={
          <Trans
            i18nKey="invite.accountMismatch.description"
            values={{ invited: recipientEmailMasked || '', current: currentUserEmail || '' }}
            defaults="This invitation is for <strong>{{invited}}</strong>, but you’re signed in as <current>{{current}}</current>."
            components={{
              strong: <span {...stylex.props(styles.emphasis)} />,
              current: <span {...stylex.props(styles.emphasis)} />,
            }}
          />
        }
        note={
          <>
            {t('invite.accountMismatch.workspace', 'Invitation to {{workspace}}', {
              workspace: workspaceName,
            })}
            {roleNote ? ` · ${roleNote}` : ''}
          </>
        }
        actions={
          <>
            <Button size="large" variant="secondary" onClick={onBackHome}>
              {t('invite.error.backButton', 'Back to home')}
            </Button>
            <Button size="large" onClick={onSwitchAccount}>
              {t('invite.accountMismatch.switch', 'Switch account')}
            </Button>
          </>
        }
      />
    );
  }

  if (state === 'auth_required') {
    return (
      <SecondaryPage
        state="ask"
        from={avatar}
        markLabel={markLabel}
        title={workspaceName}
        description={
          inviter
            ? t('invite.authRequired.invitedBy', '{{inviter}} invited you to collaborate.', {
                inviter,
              })
            : t('invite.idle.invited', 'You have been invited to collaborate.')
        }
        well={
          recipientEmailMasked ? (
            <Trans
              i18nKey="invite.authRequired.recipient"
              values={{ email: recipientEmailMasked }}
              defaults="Sign in or create an account with <strong>{{email}}</strong> to continue."
              components={{ strong: <span {...stylex.props(styles.emphasis)} /> }}
            />
          ) : undefined
        }
        note={roleNote || undefined}
        actions={
          <Button size="large" onClick={onContinue}>
            {t('invite.authRequired.continue', 'Continue with invited email')}
          </Button>
        }
      />
    );
  }

  return (
    <SecondaryPage
      state="ask"
      from={avatar}
      markLabel={markLabel}
      title={workspaceName}
      description={
        inviter ? (
          <Trans
            i18nKey="invite.idle.invitedBy"
            values={{ inviter }}
            defaults="<strong>{{inviter}}</strong> invited you to collaborate."
            components={{ strong: <span {...stylex.props(styles.emphasis)} /> }}
          />
        ) : (
          t('invite.idle.invited', 'You have been invited to collaborate.')
        )
      }
      note={roleNote || undefined}
      actions={
        <Button size="large" onClick={onAccept}>
          {t('invite.idle.accept', 'Accept invitation')}
        </Button>
      }
    />
  );
}
