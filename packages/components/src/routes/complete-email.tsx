import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { RouteMessage } from '@/components/route-message';
import { CompleteEmailPage } from '@/components/pages/complete-email-page';
import { useStableSession } from '@/hooks/useStableSession';
import { isMissingEmail } from '@lody/shared';
import { useAuthClient, useAuthSignOut } from '../providers/convex-provider';
import {
  getAppCurrentPathWithSearch,
  getAppOriginForUrlParsing,
  replaceAppWindowLocation,
} from '@/lib/app-location';
import { isSafeAuthRedirect } from '@/lib/auth-redirect';

type CompleteEmailSearch = {
  redirect?: string;
};

export const Route = createFileRoute('/complete-email')({
  component: CompleteEmailRoute,
  validateSearch: (search: Record<string, unknown>): CompleteEmailSearch => {
    return {
      redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
    };
  },
});

const getRedirectTarget = (redirect?: string) => {
  const safe = isSafeAuthRedirect(redirect, { appOrigin: getAppOriginForUrlParsing() });
  return safe ?? import.meta.env.BASE_URL ?? '/';
};

// TanStack Router's `<Navigate>` only navigates within the SPA route tree, so
// cross-origin targets (now possible via isSafeAuthRedirect's *.lody.ai
// whitelist) need `window.location.replace` instead.
function ExternalRedirect({ to }: { to: string }) {
  useEffect(() => {
    replaceAppWindowLocation(to);
  }, [to]);
  return null;
}

function CompleteEmailRoute() {
  const { t } = useTranslation();
  const authClient = useAuthClient();
  const signOut = useAuthSignOut();
  const { data: session, isPending, isRetrying, error } = useStableSession();
  const { redirect } = Route.useSearch();
  const [email, setEmail] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const redirectTarget = useMemo(() => getRedirectTarget(redirect), [redirect]);
  const userEmailForDisplay =
    session?.user && !isMissingEmail(session.user.email) ? session.user.email : null;
  const userLabel = session?.user
    ? [session.user.name, userEmailForDisplay].filter(Boolean).join(' · ') || session.user.id
    : '';

  if ((isPending || isRetrying) && !session?.user) {
    return null;
  }

  if (!session?.user && !isPending && !isRetrying) {
    const currentPath = getAppCurrentPathWithSearch();
    return <Navigate to="/login" search={{ redirect: currentPath }} replace />;
  }

  if (error) {
    return (
      <RouteMessage
        gate="session_load_error"
        title={t('workspace.route.sessionLoadErrorTitle')}
        description={t('workspace.route.sessionLoadErrorDescription')}
      />
    );
  }

  if (session?.user && !isMissingEmail(session.user.email)) {
    const isAbsoluteUrl = /^https?:\/\//i.test(redirectTarget);
    return isAbsoluteUrl ? (
      <ExternalRedirect to={redirectTarget} />
    ) : (
      <Navigate to={redirectTarget} replace />
    );
  }

  const handleSignOut = async () => {
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitError(null);

    const parsed = z.string().email().safeParse(email.trim());
    if (!parsed.success) {
      setSubmitError(t('completeEmail.invalidEmail', 'Please enter a valid email address.'));
      return;
    }

    setSubmitting(true);
    try {
      const response = await authClient.changeEmail({
        newEmail: parsed.data,
        callbackURL: redirectTarget,
      });
      if (response && typeof response === 'object' && 'error' in response && response.error) {
        setSubmitError(
          response.error.message ??
            t('completeEmail.updateFailed', 'Unable to update email. Please try again.')
        );
        return;
      }
      replaceAppWindowLocation(redirectTarget);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('completeEmail.updateFailed', 'Unable to update email. Please try again.');
      setSubmitError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <CompleteEmailPage
      userLabel={userLabel}
      email={email}
      submitError={submitError}
      submitting={submitting}
      signingOut={signingOut}
      onEmailChange={(value) => {
        setEmail(value);
        if (submitError) setSubmitError(null);
      }}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      onSignOut={() => {
        void handleSignOut();
      }}
    />
  );
}
