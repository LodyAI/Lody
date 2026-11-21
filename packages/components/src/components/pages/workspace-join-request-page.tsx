import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { Textarea } from '@lody/ui/textarea';
import { SecondaryPage, type SecondaryPageState } from '@/components/pages/secondary-page';
// Placeholder workspace avatar until per-workspace avatars are supported.
import workspaceAvatarPlaceholder from '@/assets/icon-transparent.png';

export type WorkspaceJoinPageState =
  | 'loading'
  | 'unavailable'
  | 'auth_required'
  | 'verification_required'
  | 'form'
  | 'submitting'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'already_member'
  | 'error';

export interface WorkspaceJoinRequestPageProps {
  state: WorkspaceJoinPageState;
  workspaceName?: string | null;
  currentEmail?: string | null;
  reason: string;
  errorMessage?: string | null;
  onReasonChange: (reason: string) => void;
  onContinue: () => void;
  onVerifyEmail: () => void;
  onSubmit: () => void;
  onOpenWorkspace: () => void;
  onBackHome: () => void;
}

const styles = stylex.create({
  avatar: {
    width: 26,
    height: 26,
    objectFit: 'contain',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
  },
  label: {
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 500,
    color: colors.label,
  },
});

const PAGE_STATE: Record<WorkspaceJoinPageState, SecondaryPageState> = {
  loading: 'arrive',
  submitting: 'arrive',
  pending: 'arrive',
  unavailable: 'blocked',
  error: 'blocked',
  auth_required: 'ask',
  verification_required: 'ask',
  form: 'ask',
  rejected: 'ask',
  approved: 'done',
  already_member: 'done',
};

const HEADING_ID = 'join-request-title';

export function WorkspaceJoinRequestPage({
  state,
  workspaceName,
  currentEmail,
  reason,
  errorMessage,
  onReasonChange,
  onContinue,
  onVerifyEmail,
  onSubmit,
  onOpenWorkspace,
  onBackHome,
}: WorkspaceJoinRequestPageProps) {
  const { t } = useTranslation();
  const name = workspaceName?.trim() || t('joinRequest.workspaceFallback', 'Workspace');
  const avatar = (
    <img
      src={workspaceAvatarPlaceholder}
      alt=""
      aria-hidden="true"
      draggable={false}
      {...stylex.props(styles.avatar)}
    />
  );
  const common = {
    state: PAGE_STATE[state],
    from: avatar,
    markLabel: t('invite.markLabel', 'Workspace and Lody'),
  };
  const backHome = (
    <Button size="large" variant="secondary" onClick={onBackHome}>
      {t('invite.error.backButton', 'Back to home')}
    </Button>
  );

  if (state === 'loading') {
    return (
      <SecondaryPage
        {...common}
        title={t('joinRequest.eyebrow', 'Workspace access request')}
        description={t('joinRequest.loading', 'Checking this link…')}
      />
    );
  }

  if (state === 'unavailable') {
    return (
      <SecondaryPage
        {...common}
        title={t('joinRequest.unavailableTitle', 'Link unavailable')}
        description={t('joinRequest.unavailable', 'This link is invalid, expired, or disabled.')}
        actions={backHome}
      />
    );
  }

  if (state === 'error') {
    return (
      <SecondaryPage
        {...common}
        title={name}
        description={errorMessage || t('common.tryAgain')}
        actions={backHome}
      />
    );
  }

  if (state === 'auth_required') {
    return (
      <SecondaryPage
        {...common}
        title={name}
        description={t(
          'joinRequest.authRequired',
          'Sign in or create an account to request access. You can use any verified email.'
        )}
        actions={
          <Button size="large" onClick={onContinue}>
            {t('joinRequest.continue', 'Continue')}
          </Button>
        }
      />
    );
  }

  if (state === 'verification_required') {
    return (
      <SecondaryPage
        {...common}
        title={name}
        description={t('joinRequest.verify', 'Verify {{email}} before submitting your request.', {
          email: currentEmail || '',
        })}
        actions={
          <Button size="large" onClick={onVerifyEmail}>
            {t('joinRequest.verifyAction', 'Verify email')}
          </Button>
        }
      />
    );
  }

  if (state === 'pending') {
    return (
      <SecondaryPage
        {...common}
        title={name}
        description={t('joinRequest.pending', 'Request sent. The workspace owner will review it.')}
      />
    );
  }

  if (state === 'approved' || state === 'already_member') {
    return (
      <SecondaryPage
        {...common}
        title={name}
        description={
          state === 'approved'
            ? t('joinRequest.approved', 'Your request was approved.')
            : t('joinRequest.alreadyMember', 'You are already a member of this workspace.')
        }
        actions={
          <Button size="large" onClick={onOpenWorkspace}>
            {t('joinRequest.openWorkspace', 'Open workspace')}
          </Button>
        }
      />
    );
  }

  // form, submitting, rejected
  const submitting = state === 'submitting';
  return (
    <form
      aria-labelledby={HEADING_ID}
      aria-busy={submitting}
      onSubmit={(event) => {
        event.preventDefault();
        if (reason.trim() && !submitting) onSubmit();
      }}
    >
      <SecondaryPage
        {...common}
        headingId={HEADING_ID}
        title={name}
        description={
          state === 'rejected'
            ? t(
                'joinRequest.rejected',
                'Your previous request was not approved. You may submit a new reason.'
              )
            : t(
                'joinRequest.formDescription',
                'Request access. The workspace owner reviews every request.'
              )
        }
        note={
          currentEmail
            ? t('joinRequest.identity', 'Submitting as {{email}}', { email: currentEmail })
            : undefined
        }
        actions={
          <Button type="submit" size="large" disabled={!reason.trim() || submitting}>
            {submitting
              ? t('joinRequest.submitting', 'Submitting…')
              : t('joinRequest.submit', 'Submit request')}
          </Button>
        }
      >
        <div {...stylex.props(styles.field)}>
          <label htmlFor="join-request-reason" {...stylex.props(styles.label)}>
            {t('joinRequest.reasonLabel', 'Why do you want to join?')}
          </label>
          <Textarea
            id="join-request-reason"
            rows={4}
            value={reason}
            maxLength={1000}
            disabled={submitting}
            placeholder={t(
              'joinRequest.reasonPlaceholder',
              'Share context for the workspace owner…'
            )}
            onChange={(event) => onReasonChange(event.target.value)}
          />
        </div>
      </SecondaryPage>
    </form>
  );
}
