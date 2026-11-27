import { isSafeAuthRedirect } from './auth-redirect';
import type { ElectronOAuthQuery } from './electron-oauth';

type BuildEmailVerificationCallbackSearchInput = {
  targetEmail: string;
  sourceSearchParams: URLSearchParams;
  appOrigin: string;
  loginPathname: string;
  electronOAuthQuery?: ElectronOAuthQuery | undefined;
};

type BuildEmailVerificationCallbackUrlInput = BuildEmailVerificationCallbackSearchInput & {
  callbackBaseUrl: string;
  // Path better-auth bakes into the verification link. Defaults to `loginPathname`
  // for backwards compatibility; pass `/email-verified` so a successful verify
  // lands on the confirmation screen instead of dropping straight onto /login.
  // `loginPathname` stays in `input` so the redirect-safety check still forbids
  // bouncing back to the login page itself.
  callbackPathname?: string;
};

function normalizeCallbackPath(loginPathname: string): string {
  const trimmed = loginPathname.trim();
  if (!trimmed) {
    return '/login';
  }
  if (trimmed === '.') {
    return '/';
  }
  if (trimmed.startsWith('./')) {
    return `/${trimmed.slice(2)}`;
  }
  if (trimmed.startsWith('/')) {
    return trimmed;
  }
  return `/${trimmed}`;
}

function joinBasePath(callbackBaseUrl: string, callbackPath: string): URL {
  const baseUrl = new URL(callbackBaseUrl);
  const basePath = baseUrl.pathname === '/' ? '' : baseUrl.pathname.replace(/\/$/, '');
  const pathWithBase =
    basePath && callbackPath !== basePath && !callbackPath.startsWith(`${basePath}/`)
      ? `${basePath}${callbackPath}`
      : callbackPath;

  return new URL(pathWithBase, baseUrl.origin);
}

export function buildEmailVerificationCallbackSearch({
  targetEmail,
  sourceSearchParams,
  appOrigin,
  loginPathname,
  electronOAuthQuery,
}: BuildEmailVerificationCallbackSearchInput): URLSearchParams {
  const params = new URLSearchParams({ view: 'email', email: targetEmail });
  const redirect = isSafeAuthRedirect(sourceSearchParams.get('redirect'), {
    appOrigin,
    forbiddenSamePathname: loginPathname,
  });
  if (redirect !== null) {
    params.set('redirect', redirect);
  }

  if (electronOAuthQuery !== undefined) {
    params.set('client_id', electronOAuthQuery.client_id);
    params.set('state', electronOAuthQuery.state);
    params.set('code_challenge', electronOAuthQuery.code_challenge);
    if (electronOAuthQuery.desktop_channel !== undefined) {
      params.set('desktop_channel', electronOAuthQuery.desktop_channel);
    }
    if (electronOAuthQuery.code_challenge_method !== undefined) {
      params.set('code_challenge_method', electronOAuthQuery.code_challenge_method);
    }
  }

  return params;
}

export function buildEmailVerificationCallbackUrl({
  callbackBaseUrl,
  callbackPathname,
  ...input
}: BuildEmailVerificationCallbackUrlInput): string {
  const params = buildEmailVerificationCallbackSearch(input);
  const callbackPath = normalizeCallbackPath(callbackPathname ?? input.loginPathname);
  const url = joinBasePath(callbackBaseUrl, callbackPath);
  url.search = params.toString();
  return url.toString();
}
