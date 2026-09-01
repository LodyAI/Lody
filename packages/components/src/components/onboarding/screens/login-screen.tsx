import { useCallback, useEffect, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { usePlatformSession } from '@lody/platform/react';
import { ExternalLink, Loader2, LogIn } from 'lucide-react';
import { Button } from '@/ui/button';
import { OnboardingBackButton, OnboardingShell } from '../onboarding-shell';

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
  const [openingBrowser, setOpeningBrowser] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkStale, setCheckStale] = useState(false);

  useEffect(() => {
    if (session.status === 'authenticated') onNext();
  }, [onNext, session.status]);

  const checking = session.status === 'loading';
  useEffect(() => {
    if (!checking) {
      setCheckStale(false);
      return undefined;
    }
    const timer = setTimeout(() => setCheckStale(true), SESSION_CHECK_STALE_MS);
    return () => clearTimeout(timer);
  }, [checking]);
  // A stale check unlocks the screen: waiting forever helps no one, and
  // sign-in still works — the authenticated effect advances regardless.
  const locked = checking && !checkStale;

  const handleSignIn = useCallback(() => {
    setOpeningBrowser(true);
    setError(null);
    void (authClient as unknown as ElectronBrowserSignInClient).signIn
      .social({
        callbackURL: '/onboarding',
      })
      .catch((signInError: unknown) => {
        console.error('[onboarding] Failed to start browser sign-in:', signInError);
        setOpeningBrowser(false);
        setError(signInError instanceof Error ? signInError.message : String(signInError));
      });
  }, [authClient]);

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
        <Button size="lg" onClick={handleSignIn} disabled={locked}>
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
