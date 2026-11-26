import { isRequestUnavailable, requestFailureCode } from '@/lib/e2ee-actionable-failure';
import { seatBillingErrorKey } from '@/components/settings/billing-errors';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import type { Invitation } from 'better-auth/plugins/organization';
import { useCloudQueryState, usePlatformCapability } from '@lody/platform/react';
import { useStableSession } from '@/hooks/useStableSession';
import { cloudOperations, type InvitationPreview } from '@/lib/cloud-api-operations';
import {
  AcceptInvitationPage,
  type AcceptInvitationPageState,
} from '@/components/pages/accept-invitation-page';
import { useAuthClient, useAuthSignOut } from '../../providers/convex-provider';

export const Route = createFileRoute('/invite/$invitationId')({
  component: AcceptInvitationComponent,
});

function isRecipientMismatchError(error: { code?: string; message?: string } | null | undefined) {
  return (
    error?.code === 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION' ||
    error?.message === 'You are not the recipient of the invitation'
  );
}

function isEmailVerificationRequiredError(
  error: { code?: string; message?: string } | null | undefined
) {
  return (
    error?.code === 'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION' ||
    error?.message?.toLowerCase().includes('email verification required') === true
  );
}

function invitationLoadError(error: unknown) {
  const status = (error as { status?: number } | null)?.status;
  const code = requestFailureCode(error);
  if (
    status === 404 ||
    /^(?:INVITATION_NOT_FOUND|INVITATION_EXPIRED|invitation_not_found|invitation_expired)$/.test(
      code ?? ''
    )
  )
    return 'invite.error.notFound';
  return isRequestUnavailable(error) ? 'invite.error.network' : 'invite.error.unknown';
}

/**
 * 接受邀请页面组件
 * 处理工作空间邀请的接受流程
 */
export function AcceptInvitationComponent() {
  const { t } = useTranslation();
  const authClient = useAuthClient();
  const signOut = useAuthSignOut();
  const [invitation, setInvitation] = useState<
    | (Invitation & { organizationName: string; organizationSlug: string; inviterEmail: string })
    | null
  >(null);
  const { invitationId } = Route.useParams();
  const navigate = useNavigate();
  const {
    data: session,
    isPending,
    isRetrying,
    error: sessionError,
    refetch: refetchSession,
  } = useStableSession();
  const isAuthenticated = Boolean(session?.user);
  const invitationsAvailable = usePlatformCapability('multiWorkspace');
  const {
    data: preview,
    error: previewError,
    retry: retryPreview,
  } = useCloudQueryState<{ invitationId: string }, InvitationPreview>(
    cloudOperations.auth.getInvitationPreview,
    { invitationId }
  );
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [loadError, setLoadError] = useState<ReturnType<typeof invitationLoadError> | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [status, setStatus] = useState<AcceptInvitationPageState>('loading');
  const [organizationName, setOrganizationName] = useState<string>('');
  const getInvitation = useCallback(
    async (id: string) => {
      return await authClient.organization.getInvitation({
        query: {
          id,
        },
      });
    },
    [authClient]
  );

  useEffect(() => {
    if (!preview || isPending || isRetrying) {
      return undefined;
    }
    setLoadError(null);
    if (preview.status === 'unavailable') {
      setLoadError('invite.error.notFound');
      return undefined;
    }
    if (!isAuthenticated) {
      setStatus('auth_required');
      setInvitation(null);
      return undefined;
    }
    if (preview.recipientMatchesSession === false) {
      setStatus('account_mismatch');
      setInvitation(null);
      return undefined;
    }
    let cancelled = false;
    setStatus('loading');
    const fetchInvitation = async () => {
      try {
        const { data: invitationData, error } = await getInvitation(invitationId);

        if (error || !invitationData) {
          if (isRecipientMismatchError(error)) {
            if (!cancelled) setStatus('account_mismatch');
            return;
          }
          if (!cancelled)
            setLoadError(error ? invitationLoadError(error) : 'invite.error.notFound');
          return;
        }

        if (!cancelled) {
          setInvitation(invitationData);
          setStatus('idle');
        }
      } catch (error) {
        if (!cancelled) setLoadError(invitationLoadError(error));
      }
    };
    void fetchInvitation();
    return () => {
      cancelled = true;
    };
  }, [getInvitation, invitationId, isAuthenticated, isPending, isRetrying, loadAttempt, preview]);

  /**
   * 接受邀请
   */
  const acceptInvitation = async () => {
    if (!invitation) {
      setStatus('error');
      setErrorMessage(t('invite.error.notFound', 'Invitation not found or expired.'));
      return;
    }

    setStatus('loading');
    const result = await authClient.organization.acceptInvitation({
      invitationId,
    });

    if (result.data) {
      setOrganizationName(invitation.organizationName || 'Unknown organization');
      setStatus('success');
      // 等待一秒后跳转到工作空间主页
      setTimeout(() => {
        if (invitation.organizationSlug) {
          void navigate({
            to: '/$workspaceName/chat',
            params: { workspaceName: invitation.organizationSlug },
          });
        } else {
          void navigate({ to: '/workspace/create' });
        }
      }, 1500);
    } else if (result.error) {
      console.error('accept invitation error', result.error);
      if (isRecipientMismatchError(result.error)) {
        setStatus('account_mismatch');
      } else if (isEmailVerificationRequiredError(result.error)) {
        setStatus('verification_required');
      } else {
        const billingKey = seatBillingErrorKey(result.error);
        setStatus(billingKey ? 'billing_blocked' : 'error');
        setErrorMessage(
          billingKey ? t(billingKey) : result.error.message || t('invite.error.unknown')
        );
      }
    }
  };

  const continueToLogin = () => {
    const currentPath = `/invite/${invitationId}`;
    void navigate({ to: '/login', search: { redirect: currentPath, view: 'email' } });
  };

  const switchAccount = async () => {
    setStatus('loading');
    await signOut();
    continueToLogin();
  };

  const loadErrorKey = !invitationsAvailable
    ? 'invite.error.unknown'
    : sessionError
      ? isRequestUnavailable(sessionError)
        ? 'invite.error.network'
        : 'invite.error.unknown'
      : previewError
        ? invitationLoadError(previewError)
        : loadError;
  if (loadErrorKey) {
    return (
      <AcceptInvitationPage
        state="error"
        errorMessage={t(loadErrorKey)}
        onRetry={
          !invitationsAvailable || loadErrorKey === 'invite.error.notFound'
            ? undefined
            : sessionError
              ? () => {
                  void refetchSession();
                }
              : previewError
                ? retryPreview
                : () => setLoadAttempt((attempt) => attempt + 1)
        }
        onBackHome={() => {
          void navigate({ to: '/' });
        }}
      />
    );
  }

  if (isPending || isRetrying || preview === undefined) {
    return <AcceptInvitationPage state="loading" />;
  }

  return (
    <AcceptInvitationPage
      state={status}
      invitationOrganizationName={
        invitation?.organizationName ||
        (preview.status === 'available' ? preview.organizationName : null)
      }
      organizationName={organizationName}
      inviterName={preview.status === 'available' ? preview.inviterName : null}
      inviterEmail={invitation?.inviterEmail}
      recipientEmailMasked={preview.status === 'available' ? preview.recipientEmailMasked : null}
      invitationRole={preview.status === 'available' ? preview.role : null}
      currentUserEmail={session?.user?.email}
      errorMessage={errorMessage}
      onContinue={continueToLogin}
      onSwitchAccount={() => {
        void switchAccount();
      }}
      onVerifyEmail={() => {
        void switchAccount();
      }}
      onAccept={() => {
        void acceptInvitation();
      }}
      onBackHome={() => {
        void navigate({ to: '/' });
      }}
    />
  );
}
