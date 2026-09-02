import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import { Button } from '@lody/ui/button';
import { cn } from '@/lib/utils';
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

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-border/60 bg-card shadow-[0_8px_30px_-12px_rgba(0,0,0,0.12)]">
        <div className="flex flex-col items-center px-7 pb-7 pt-8 text-center">
          {state === 'loading' ? (
            <>
              <Loader2
                className="mb-4 size-6 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
              <Title>{t('invite.processing.title', 'Processing invitation')}</Title>
              <Description>
                {t('invite.processing.description', 'Hang tight, this only takes a moment.')}
              </Description>
            </>
          ) : null}

          {state === 'idle' ? (
            <>
              <img
                src={workspaceAvatarPlaceholder}
                alt=""
                aria-hidden="true"
                draggable={false}
                className="mb-4 h-12 w-12 object-contain"
              />
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
                {t('invite.idle.eyebrow', 'Workspace invitation')}
              </p>
              <Title className="mt-1.5">{workspaceName}</Title>
              <Description>
                {inviter ? (
                  <Trans
                    i18nKey="invite.idle.invitedBy"
                    values={{ inviter }}
                    defaults="<strong>{{inviter}}</strong> invited you to collaborate."
                    components={{ strong: <span className="font-medium text-foreground" /> }}
                  />
                ) : (
                  t('invite.idle.invited', 'You have been invited to collaborate.')
                )}
              </Description>
              {roleLabel ? <InvitationRole role={roleLabel} /> : null}
              <Button size="large" onClick={onAccept} className="mt-6 w-full">
                {t('invite.idle.accept', 'Accept invitation')}
              </Button>
            </>
          ) : null}

          {state === 'auth_required' ? (
            <>
              <img
                src={workspaceAvatarPlaceholder}
                alt=""
                aria-hidden="true"
                draggable={false}
                className="mb-4 h-12 w-12 object-contain"
              />
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
                {t('invite.idle.eyebrow', 'Workspace invitation')}
              </p>
              <Title className="mt-1.5">{workspaceName}</Title>
              <Description>
                {inviter
                  ? t('invite.authRequired.invitedBy', '{{inviter}} invited you to collaborate.', {
                      inviter,
                    })
                  : t('invite.idle.invited', 'You have been invited to collaborate.')}
              </Description>
              {roleLabel ? <InvitationRole role={roleLabel} /> : null}
              {recipientEmailMasked ? (
                <p className="mt-4 rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
                  <Trans
                    i18nKey="invite.authRequired.recipient"
                    values={{ email: recipientEmailMasked }}
                    defaults="Sign in or create an account with <strong>{{email}}</strong> to continue."
                    components={{ strong: <span className="font-medium text-foreground" /> }}
                  />
                </p>
              ) : null}
              <Button size="large" onClick={onContinue} className="mt-6 w-full">
                {t('invite.authRequired.continue', 'Continue with invited email')}
              </Button>
            </>
          ) : null}

          {state === 'account_mismatch' ? (
            <>
              <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
                {t('invite.accountMismatch.workspace', 'Invitation to {{workspace}}', {
                  workspace: workspaceName,
                })}
              </p>
              <Title>{t('invite.accountMismatch.title', 'Switch accounts to continue')}</Title>
              <Description>
                <Trans
                  i18nKey="invite.accountMismatch.description"
                  values={{ invited: recipientEmailMasked || '', current: currentUserEmail || '' }}
                  defaults="This invitation is for <strong>{{invited}}</strong>, but you’re signed in as <current>{{current}}</current>."
                  components={{
                    strong: <span className="font-medium text-foreground" />,
                    current: <span className="font-medium text-foreground" />,
                  }}
                />
              </Description>
              {roleLabel ? <InvitationRole role={roleLabel} /> : null}
              <Button size="large" onClick={onSwitchAccount} className="mt-6 w-full">
                {t('invite.accountMismatch.switch', 'Switch account')}
              </Button>
              <Button size="large" onClick={onBackHome} variant="ghost" className="mt-2 w-full">
                {t('invite.error.backButton', 'Back to home')}
              </Button>
            </>
          ) : null}

          {state === 'verification_required' ? (
            <>
              <Title>{t('invite.verificationRequired.title', 'Verify the invited email')}</Title>
              <Description>
                {t(
                  'invite.verificationRequired.description',
                  'For security, verify the email address named by this invitation before accepting it.'
                )}
              </Description>
              <Button size="large" onClick={onVerifyEmail} className="mt-6 w-full">
                {t('invite.verificationRequired.continue', 'Continue to verification')}
              </Button>
            </>
          ) : null}

          {state === 'success' ? (
            <>
              <Title>{t('invite.success.title', "You're in")}</Title>
              <Description>
                <Trans
                  i18nKey="invite.success.description"
                  values={{ workspace: workspaceName }}
                  defaults="Welcome to <strong>{{workspace}}</strong> — taking you there now…"
                  components={{ strong: <span className="font-medium text-foreground" /> }}
                />
              </Description>
            </>
          ) : null}

          {state === 'error' ? (
            <>
              <Title>{t('invite.error.title', 'Invitation unavailable')}</Title>
              <Description>
                {errorMessage || t('invite.error.notFound', 'Invitation not found or expired.')}
              </Description>
              <Button size="large" onClick={onBackHome} variant="secondary" className="mt-6 w-full">
                {t('invite.error.backButton', 'Back to home')}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Title({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h1
      className={cn(
        'max-w-full truncate text-xl font-semibold leading-tight tracking-tight text-foreground',
        className
      )}
    >
      {children}
    </h1>
  );
}

function Description({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

function InvitationRole({ role }: { role: string }) {
  const { t } = useTranslation();
  return (
    <p className="mt-3 rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
      {t('invite.role.label', 'Role: {{role}}', { role })}
    </p>
  );
}
