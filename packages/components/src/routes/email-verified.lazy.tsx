import { createLazyFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';

import { EmailVerifiedPage } from '@/components/pages/email-verified-page';
import { getAppWindowSearchParams, replaceAppWindowLocation } from '@/lib/app-location';

// How long the success screen stays up before forwarding to the sign-in view.
const REDIRECT_DELAY_SECONDS = 3;

// Params we hand straight back to /login so the user keeps their place: the
// verified email (pre-fills + shows the next-steps panel), a safe post-login
// redirect, and any Electron OAuth handshake state.
const FORWARDED_PARAM_KEYS = [
  'email',
  'redirect',
  'client_id',
  'state',
  'code_challenge',
  'code_challenge_method',
] as const;

const normalizeBasePath = () => {
  const baseUrl = import.meta.env.BASE_URL || '/';
  return baseUrl === '/' || baseUrl === './' || baseUrl === '.' ? '' : baseUrl.replace(/\/$/, '');
};

function buildLoginUrl(source: URLSearchParams, errorCode: string | null): string {
  const params = new URLSearchParams({ view: 'email' });
  for (const key of FORWARDED_PARAM_KEYS) {
    const value = source.get(key);
    if (value) {
      params.set(key, value);
    }
  }
  // better-auth appends `?error=<code>` on a failed verify; pass it through so the
  // login page renders the matching inline message via its existing handling.
  if (errorCode) {
    params.set('error', errorCode);
  }
  const query = params.toString();
  return `${normalizeBasePath()}/login${query ? `?${query}` : ''}`;
}

export const Route = createLazyFileRoute('/email-verified')({
  component: EmailVerifiedRoute,
});

function EmailVerifiedRoute() {
  const { errorCode, email, loginUrl } = useMemo(() => {
    const source = getAppWindowSearchParams();
    const code = source.get('error');
    return {
      errorCode: code,
      email: source.get('email') ?? '',
      loginUrl: buildLoginUrl(source, code),
    };
  }, []);

  const [secondsRemaining, setSecondsRemaining] = useState(REDIRECT_DELAY_SECONDS);

  // A failed verify carries `?error=<code>`: skip the success screen entirely and
  // bounce to /login so its inline error UI takes over without a false success flash.
  useEffect(() => {
    if (errorCode) {
      replaceAppWindowLocation(loginUrl);
    }
  }, [errorCode, loginUrl]);

  // Success path: tick down, then forward to the email sign-in view.
  useEffect(() => {
    if (errorCode) {
      return undefined;
    }
    if (secondsRemaining <= 0) {
      replaceAppWindowLocation(loginUrl);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setSecondsRemaining((value) => value - 1);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [errorCode, secondsRemaining, loginUrl]);

  if (errorCode) {
    return null;
  }

  return (
    <EmailVerifiedPage
      email={email}
      secondsRemaining={secondsRemaining}
      onContinue={() => replaceAppWindowLocation(loginUrl)}
    />
  );
}
