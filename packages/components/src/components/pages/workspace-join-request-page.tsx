import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Textarea } from '@/ui/textarea';
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
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-4">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-border/60 bg-card shadow-[0_8px_30px_-12px_rgba(0,0,0,0.12)]">
        <div className="flex flex-col items-center px-7 pb-7 pt-8 text-center">
          {busy ? <Loader2 className="mb-4 size-6 animate-spin text-muted-foreground" /> : null}
          {!busy ? (
            <img
              src={workspaceAvatarPlaceholder}
              alt=""
              aria-hidden="true"
              className="mb-4 h-12 w-12 object-contain"
            />
          ) : null}
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
            {t('joinRequest.eyebrow', 'Workspace access request')}
          </p>
          <h1 className="mt-1.5 text-xl font-semibold tracking-tight">
            {state === 'unavailable' ? t('joinRequest.unavailableTitle', 'Link unavailable') : name}
          </h1>

          {state === 'loading' ? (
            <p className="mt-2 text-sm text-muted-foreground">
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
              <Button size="large" className="mt-6 w-full" onClick={onContinue}>
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
              <Button size="large" className="mt-6 w-full" onClick={onVerifyEmail}>
                {t('joinRequest.verifyAction', 'Verify email')}
              </Button>
            </>
          ) : null}
          {state === 'form' || state === 'submitting' || state === 'rejected' ? (
            <div className="mt-5 w-full text-left">
              {state === 'rejected' ? (
                <p className="mb-4 rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
                  {t(
                    'joinRequest.rejected',
                    'Your previous request was not approved. You may submit a new reason.'
                  )}
                </p>
              ) : null}
              <label htmlFor="join-request-reason" className="text-sm font-medium">
                {t('joinRequest.reasonLabel', 'Why do you want to join?')}
              </label>
              <Textarea
                id="join-request-reason"
                className="mt-2 min-h-28 resize-y"
                value={reason}
                maxLength={1000}
                disabled={state === 'submitting'}
                placeholder={t(
                  'joinRequest.reasonPlaceholder',
                  'Share context for the workspace owner…'
                )}
                onChange={(event) => onReasonChange(event.target.value)}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t('joinRequest.identity', 'Submitting as {{email}}', {
                  email: currentEmail || '',
                })}
              </p>
              <Button
                size="large"
                className="mt-5 w-full"
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
              <Button size="large" className="mt-6 w-full" onClick={onOpenWorkspace}>
                {t('joinRequest.openWorkspace', 'Open workspace')}
              </Button>
            </>
          ) : null}
          {state === 'error' ? <Message>{errorMessage || t('common.tryAgain')}</Message> : null}
          {state === 'unavailable' || state === 'error' ? (
            <Button variant="ghost" className="mt-4" onClick={onBackHome}>
              {t('invite.error.backButton', 'Back to home')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-sm leading-6 text-muted-foreground">{children}</p>;
}
