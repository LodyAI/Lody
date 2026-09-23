export const ELECTRON_AUTHORIZATION_CODE_COOKIE_KEY = 'better-auth.electron';
const ELECTRON_PROTOCOL_SCHEME = 'lody';
const ELECTRON_CALLBACK_PATH = '/auth/callback';
const ELECTRON_BROWSER_CALLBACK_PATH = '/electron/callback';
const ELECTRON_WEB_LOGIN_CALLBACK_PATH = '/login';

export type ElectronOAuthQuery = {
  client_id: string;
  state: string;
  code_challenge: string;
  code_challenge_method?: string;
};

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function buildElectronOAuthSearch(query: ElectronOAuthQuery): URLSearchParams {
  const search = new URLSearchParams();
  search.set('client_id', query.client_id);
  search.set('state', query.state);
  search.set('code_challenge', query.code_challenge);
  if (query.code_challenge_method) {
    search.set('code_challenge_method', query.code_challenge_method);
  }
  return search;
}

export function readElectronAuthorizationCode(): string | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const cookiePrefix = `${ELECTRON_AUTHORIZATION_CODE_COOKIE_KEY}=`;
  const cookies = document.cookie.split(';');
  for (const rawCookie of cookies) {
    const cookie = rawCookie.trim();
    if (!cookie.startsWith(cookiePrefix)) {
      continue;
    }
    const value = cookie.slice(cookiePrefix.length);
    if (value.length === 0) {
      return null;
    }
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

export function clearElectronAuthorizationCode(): void {
  if (typeof document === 'undefined') {
    return;
  }

  document.cookie = `${ELECTRON_AUTHORIZATION_CODE_COOKIE_KEY}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`;
}

export function buildElectronAuthorizationCallbackUrl(token: string): string {
  return `${ELECTRON_PROTOCOL_SCHEME}:/${ELECTRON_CALLBACK_PATH}#token=${encodeURIComponent(token)}`;
}

// True when a `lody://` deep link is the auth callback that carries the
// authorization token back into the desktop app (`lody://auth/callback#token=…`).
// The login page watches for this to flip into a "signing in" state the moment
// the browser hands the token back, before better-auth has finished exchanging
// it for a session. The token only ever rides in the URL fragment.
export function readElectronAuthCallbackToken(deepLinkUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(deepLinkUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${ELECTRON_PROTOCOL_SCHEME}:`) {
    return null;
  }

  // `lody://auth/callback` parses as hostname `auth` + pathname `/callback`;
  // tolerate the single-slash `lody:/auth/callback` form (hostname empty) too.
  const path = `${parsed.hostname}${parsed.pathname}`.replace(/^\/+/, '').replace(/\/+$/, '');
  if (path !== ELECTRON_CALLBACK_PATH.replace(/^\//, '')) {
    return null;
  }

  const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  return new URLSearchParams(fragment).get('token');
}

export function isElectronAuthCallbackDeepLink(deepLinkUrl: string): boolean {
  return readElectronAuthCallbackToken(deepLinkUrl) != null;
}

export function buildElectronRedirectToken(authorizationCode: string, state: string): string {
  return encodeBase64Url(
    JSON.stringify({
      identifier: authorizationCode,
      state,
    })
  );
}

export function buildElectronRedirectUrl(authorizationCode: string, state: string): string {
  return buildElectronAuthorizationCallbackUrl(
    buildElectronRedirectToken(authorizationCode, state)
  );
}

// Legacy: builds the auth-origin `/electron/callback` URL. The active flow now
// finishes on web `/login` via `buildElectronWebLoginCallbackUrl`; this is kept
// only for the legacy auth-origin fallback served at that path.
export function buildElectronBrowserCallbackUrl(
  query: ElectronOAuthQuery,
  authBaseURL = import.meta.env.VITE_CONVEX_SITE_URL
): string {
  if (!authBaseURL) {
    throw new Error('VITE_CONVEX_SITE_URL is required for Electron browser callback URLs');
  }

  const url = new URL(ELECTRON_BROWSER_CALLBACK_PATH, authBaseURL);
  url.search = buildElectronOAuthSearch(query).toString();
  return url.toString();
}

export function buildElectronWebLoginCallbackUrl(
  query: ElectronOAuthQuery,
  appBaseURL = import.meta.env.BASE_URL || '/'
): string {
  // `appBaseURL` is usually a relative `BASE_URL` (`/`, `/app/`) but may be an
  // absolute site URL. Parse against a sentinel origin so both shapes share one
  // code path, then strip the sentinel back off for the relative case.
  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(appBaseURL.trim());
  const url = new URL(appBaseURL, 'http://base.invalid');
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  url.pathname = `${basePath}${ELECTRON_WEB_LOGIN_CALLBACK_PATH}`;
  url.search = buildElectronOAuthSearch(query).toString();
  url.hash = '';
  return isAbsolute ? url.toString() : `${url.pathname}${url.search}`;
}

// Navigates to an already-built `lody://auth/callback#token=…` URL. Callers that
// show the same URL as a clickable fallback link build it once with
// `buildElectronRedirectUrl` and pass it here, so the automatic attempt and the
// link the user can click carry the identical authorization payload.
export function redirectToElectronDeepLink(deepLinkUrl: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.location.replace(deepLinkUrl);
}

export function redirectToElectronWithAuthorizationCode(
  authorizationCode: string,
  state: string
): void {
  redirectToElectronDeepLink(buildElectronRedirectUrl(authorizationCode, state));
}
