import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';
import { pageSurface as surface } from './surface';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Textarea } from '@lody/ui/textarea';
import { field } from '@lody/ui/field/field.tokens.stylex';
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
  const name = workspaceName || t('joinRequest.workspaceFallback', 'Workspace');
  const busy = state === 'loading' || state === 'submitting';

  return (
    <div {...stylex.props(surface.page)}>
      <div {...stylex.props(surface.card, styles.card)}>
        <div {...stylex.props(styles.content)}>
          {busy ? <Spinner size="large" {...stylex.props(styles.spinner)} /> : null}
          {!busy ? (
            <img
              src={workspaceAvatarPlaceholder}
              alt=""
              aria-hidden="true"
              {...stylex.props(styles.avatar)}
            />
          ) : null}
          <p {...stylex.props(styles.eyebrow)}>
            {t('joinRequest.eyebrow', 'Workspace access request')}
          </p>
          <h1 {...stylex.props(styles.title)}>
            {state === 'unavailable' ? t('joinRequest.unavailableTitle', 'Link unavailable') : name}
          </h1>

          {state === 'loading' ? (
            <p {...stylex.props(styles.loading)}>
              {t('joinRequest.loading', 'Checking this link…')}
            </p>
          ) : null}
          {state === 'unavailable' ? (
            <Message>
              {t('joinRequest.unavailable', 'This link is invalid, expired, or disabled.')}
            </Message>
          ) : null}
          {state === 'auth_required' ? (
            <>
              <Message>
                {t(
                  'joinRequest.authRequired',
                  'Sign in or create an account to request access. You can use any verified email.'
                )}
              </Message>
              <Button
                size="large"
                {...stylex.props(surface.fullWidth, styles.action)}
                onClick={onContinue}
              >
                {t('joinRequest.continue', 'Continue')}
              </Button>
            </>
          ) : null}
          {state === 'verification_required' ? (
            <>
              <Message>
                {t('joinRequest.verify', 'Verify {{email}} before submitting your request.', {
                  email: currentEmail || '',
                })}
              </Message>
              <Button
                size="large"
                {...stylex.props(surface.fullWidth, styles.action)}
                onClick={onVerifyEmail}
              >
                {t('joinRequest.verifyAction', 'Verify email')}
              </Button>
            </>
          ) : null}
          {state === 'form' || state === 'submitting' || state === 'rejected' ? (
            <div {...stylex.props(surface.fullWidth, styles.form)}>
              {state === 'rejected' ? (
                <p {...stylex.props(styles.rejected)}>
                  {t(
                    'joinRequest.rejected',
                    'Your previous request was not approved. You may submit a new reason.'
                  )}
                </p>
              ) : null}
              <label htmlFor="join-request-reason" {...stylex.props(styles.label)}>
                {t('joinRequest.reasonLabel', 'Why do you want to join?')}
              </label>
              <Textarea
                id="join-request-reason"
                {...stylex.props(styles.reason)}
                value={reason}
                maxLength={1000}
                disabled={state === 'submitting'}
                placeholder={t(
                  'joinRequest.reasonPlaceholder',
                  'Share context for the workspace owner…'
                )}
                onChange={(event) => onReasonChange(event.target.value)}
              />
              <p {...stylex.props(surface.hint, styles.identity)}>
                {t('joinRequest.identity', 'Submitting as {{email}}', {
                  email: currentEmail || '',
                })}
              </p>
              <Button
                size="large"
                {...stylex.props(surface.fullWidth, styles.submit)}
                disabled={!reason.trim() || state === 'submitting'}
                onClick={onSubmit}
              >
                {state === 'submitting'
                  ? t('joinRequest.submitting', 'Submitting…')
                  : t('joinRequest.submit', 'Submit request')}
              </Button>
            </div>
          ) : null}
          {state === 'pending' ? (
            <Message>
              {t('joinRequest.pending', 'Request sent. The workspace owner will review it.')}
            </Message>
          ) : null}
          {state === 'approved' || state === 'already_member' ? (
            <>
              <Message>
                {state === 'approved'
                  ? t('joinRequest.approved', 'Your request was approved.')
                  : t('joinRequest.alreadyMember', 'You are already a member of this workspace.')}
              </Message>
              <Button
                size="large"
                {...stylex.props(surface.fullWidth, styles.action)}
                onClick={onOpenWorkspace}
              >
                {t('joinRequest.openWorkspace', 'Open workspace')}
              </Button>
            </>
          ) : null}
          {state === 'error' ? <Message>{errorMessage || t('common.tryAgain')}</Message> : null}
          {state === 'unavailable' || state === 'error' ? (
            <Button variant="ghost" {...stylex.props(styles.back)} onClick={onBackHome}>
              {t('invite.error.backButton', 'Back to home')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <p {...stylex.props(styles.message)}>{children}</p>;
}

const styles = stylex.create({
  card: {
    overflow: 'hidden',
    borderRadius: themeRadius['2xl'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.6)',
    backgroundColor: themeColors.card,
    boxShadow: '0 8px 30px -12px rgba(0,0,0,0.12)',
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    paddingInline: themeSpace[7],
    paddingBottom: themeSpace[7],
    paddingTop: themeSpace[8],
    textAlign: 'center',
  },
  spinner: { marginBottom: themeSpace[4], color: themeColors.mutedForeground },
  avatar: {
    marginBottom: themeSpace[4],
    height: themeSpace[12],
    width: themeSpace[12],
    objectFit: 'contain',
  },
  eyebrow: {
    fontSize: '11px',
    fontWeight: themeFontWeight.medium,
    textTransform: 'uppercase',
    letterSpacing: '0.14em',
    color: 'hsl(var(--muted-foreground) / 0.8)',
  },
  title: {
    marginTop: themeSpace[1.5],
    fontSize: themeFontSize.xl,
    lineHeight: themeLineHeight.xl,
    fontWeight: themeFontWeight.semibold,
    letterSpacing: '-0.025em',
  },
  loading: {
    marginTop: themeSpace[2],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
  action: { marginTop: themeSpace[6] },
  form: { marginTop: themeSpace[5], textAlign: 'left' },
  rejected: {
    marginBottom: themeSpace[4],
    borderRadius: themeRadius.lg,
    backgroundColor: 'hsl(var(--muted) / 0.6)',
    padding: themeSpace[3],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
  label: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.medium,
  },
  reason: {
    marginTop: themeSpace[2],
    [field.textareaMinHeight]: 'calc(var(--spacing) * 28)',
  },
  identity: { marginTop: themeSpace[2] },
  submit: { marginTop: themeSpace[5] },
  back: { marginTop: themeSpace[4] },
  message: {
    marginTop: themeSpace[3],
    fontSize: themeFontSize.sm,
    lineHeight: themeSpace[6],
    color: themeColors.mutedForeground,
  },
});
