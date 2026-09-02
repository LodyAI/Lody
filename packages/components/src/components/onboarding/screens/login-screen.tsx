import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { usePlatformSession } from '@lody/platform/react';
import { ExternalLink, Loader2, LogIn } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { OnboardingBackButton, OnboardingShell } from '../onboarding-shell';
import { useOnboardingAnalytics } from '../onboarding-analytics';

type ElectronBrowserSignInClient = {
  signIn: {
    social: (input: { callbackURL: string }) => Promise<unknown>;
  };
};

/** Bounds the session-loading lock so a hung check cannot freeze the screen. */
const SESSION_CHECK_STALE_MS = 10_000;

export function LoginScreen({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { t } = useTranslation();
  const { authClient } = useRouter().options.context;
  const session = usePlatformSession();
  const analytics = useOnboardingAnalytics();
  const signInAttemptRef = useRef(0);
  const signInSucceededRef = useRef(false);
  const [openingBrowser, setOpeningBrowser] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkStale, setCheckStale] = useState(false);

  useEffect(() => {
    if (session.status !== 'authenticated' || signInSucceededRef.current) return;
    signInSucceededRef.current = true;
    analytics.capture('onboarding/operation_succeeded', {
      step: 'login',
      operation: 'browser_sign_in',
      attempt: signInAttemptRef.current || null,
    });
    onNext();
  }, [analytics, onNext, session.status]);

  const checking = session.status === 'loading';
  useEffect(() => {
    if (!checking) {
      setCheckStale(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      setCheckStale(true);
      analytics.capture('onboarding/operation_failed', {
        step: 'login',
        operation: 'session_check',
        failure_code: 'session_check_slow',
        retryable: true,
      });
    }, SESSION_CHECK_STALE_MS);
    return () => clearTimeout(timer);
  }, [analytics, checking]);
  // A stale check unlocks the screen: waiting forever helps no one, and
  // sign-in still works — the authenticated effect advances regardless.
  const locked = checking && !checkStale;

  const handleSignIn = useCallback(() => {
    const attempt = ++signInAttemptRef.current;
    setOpeningBrowser(true);
    setError(null);
    analytics.capture('onboarding/operation_started', {
      step: 'login',
      operation: 'browser_sign_in',
      attempt,
    });
    void (authClient as unknown as ElectronBrowserSignInClient).signIn
      .social({
        callbackURL: '/onboarding',
      })
      .catch((signInError: unknown) => {
        console.error('[onboarding] Failed to start browser sign-in:', signInError);
        analytics.capture('onboarding/operation_failed', {
          step: 'login',
          operation: 'browser_sign_in',
          failure_code: 'browser_sign_in_failed',
          attempt,
          retryable: true,
        });
        setOpeningBrowser(false);
        setError(signInError instanceof Error ? signInError.message : String(signInError));
      });
  }, [analytics, authClient]);

  return (
    <OnboardingShell
      stepKey="login"
      title={t('onboarding.login.title', 'Sign in to Lody')}
      description={t(
        'onboarding.login.description',
        'Authentication finishes in your browser and returns here automatically.'
      )}
      secondaryAction={<OnboardingBackButton onClick={onBack} disabled={locked} />}
      primaryAction={
        <Button size="large" onClick={handleSignIn} disabled={locked}>
          {locked ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
          {openingBrowser
            ? t('onboarding.login.openBrowserAgain', 'Open browser again')
            : t('onboarding.login.openBrowser', 'Continue in browser')}
          {!locked ? <ExternalLink className="size-4" /> : null}
        </Button>
      }
    >
      <div className="flex min-h-48 items-center justify-center rounded-lg border border-border bg-muted/30 px-6 text-center">
        <p className="max-w-sm text-sm text-muted-foreground">
          {error ??
            (checkStale
              ? t(
                  'onboarding.login.checkingSlow',
                  'Checking your sign-in is taking longer than expected. You can go back or try signing in again.'
                )
              : openingBrowser
                ? t('onboarding.login.returnHint', 'Complete sign-in in the browser to continue.')
                : t(
                    'onboarding.login.securityHint',
                    'Your browser handles account authentication.'
                  ))}
        </p>
      </div>
    </OnboardingShell>
  );
}
