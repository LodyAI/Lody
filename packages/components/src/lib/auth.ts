import { createAuthClient } from 'better-auth/react';
import { organizationClient } from 'better-auth/client/plugins';
import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins';
import {
  clearAuthBootstrapSnapshot,
  clearStoredAuthToken,
  writeStoredAuthToken,
} from './auth-bootstrap';
import { getAuthResponseError, type AuthResponseError } from './auth-response';
import { deferredPostHog } from './deferred-posthog';
import { registerAuthClient } from './auth-client-singleton';
import { replaceAppWindowLocation } from './app-location';
import { setLoginHintCookie } from './login-hint-cookie';
import { clearPreferredWorkspaceSlug } from './workspace';

type BetterAuthClientOptions = NonNullable<Parameters<typeof createAuthClient>[0]>;
type BetterAuthClientPlugin = NonNullable<BetterAuthClientOptions['plugins']>[number];

type CreateLodyAuthClientOptions<Plugins extends BetterAuthClientPlugin[]> = {
  additionalPlugins?: Plugins;
  disableDefaultFetchPlugins?: boolean;
};

export const createLodyAuthClient = <const Plugins extends BetterAuthClientPlugin[] = []>(
  options: CreateLodyAuthClientOptions<Plugins> = {}
) => {
  const additionalPlugins = options.additionalPlugins ?? [];

  const client = createAuthClient({
    baseURL: import.meta.env.VITE_CONVEX_SITE_URL,
    plugins: [
      organizationClient(),
      convexClient(),
      crossDomainClient(),
      ...additionalPlugins,
    ] as const,
    disableDefaultFetchPlugins: options.disableDefaultFetchPlugins || false,
  });
  // The singleton needs only the base client. Better Auth cannot reduce its
  // conditional plugin types until the caller supplies the concrete extra plugins.
  registerAuthClient(client as unknown as LodyAuthClient);
  return client;
};

export type LodyAuthClient = ReturnType<typeof createLodyAuthClient<[]>>;

const AUTH_SESSION_INTENT_GENERATIONS = new WeakMap<object, number>();

export const getAuthSessionIntentGeneration = (authClient: LodyAuthClient): number =>
  AUTH_SESSION_INTENT_GENERATIONS.get(authClient) ?? 0;

const invalidateAuthSessionIntent = (authClient: LodyAuthClient): void => {
  AUTH_SESSION_INTENT_GENERATIONS.set(authClient, getAuthSessionIntentGeneration(authClient) + 1);
};

const localAuthStateClearedListeners = new Set<() => void>();

/** App-store owners subscribe for logout intent, before async auth state catches up. */
export const subscribeLocalAuthStateCleared = (listener: () => void): (() => void) => {
  localAuthStateClearedListeners.add(listener);
  return () => {
    localAuthStateClearedListeners.delete(listener);
  };
};

export const clearLocalAuthState = () => {
  clearStoredAuthToken();
  clearAuthBootstrapSnapshot();
  clearPreferredWorkspaceSlug();
  if (typeof window !== 'undefined') {
    try {
      deferredPostHog.reset();
    } catch (error) {
      console.error('PostHog reset error:', error);
    }
  }
  setLoginHintCookie(false);
  for (const listener of localAuthStateClearedListeners) listener();
};

export const persistAuthToken = (token: string) => {
  writeStoredAuthToken(token);
};

/**
 * Whether the server actually ended the session. Local state is cleared either
 * way (see the fence below), so a caller that must not keep acting on the
 * previous identity — the desktop handoff's "use a different account", where the
 * session cookie is exactly what the next transfer would hand over — has to be
 * able to tell a failed sign-out from a successful one. Better Auth reports
 * transport failures by throwing and API failures in `response.error`; both
 * arrive here as `ok: false`.
 */
export type SignOutOutcome = { ok: true } | { ok: false; error: AuthResponseError };

export const signOutWithoutRedirect = async (
  authClient: LodyAuthClient
): Promise<SignOutOutcome> => {
  // Fence token requests at logout intent, before Better Auth's async sign-out
  // updates useSession(). Otherwise a token request that completes in that
  // network window can still authenticate Convex as the previous user.
  invalidateAuthSessionIntent(authClient);
  clearLocalAuthState();

  try {
    const response = await authClient.signOut();
    const responseError = getAuthResponseError(response);
    if (responseError) {
      console.error('Sign out error:', responseError);
      return { ok: false, error: responseError };
    }
    return { ok: true };
  } catch (error) {
    console.error('Sign out error:', error);
    return {
      ok: false,
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }
};

export const signOutWithAuthClient = async (authClient: LodyAuthClient) => {
  await signOutWithoutRedirect(authClient);
  replaceAppWindowLocation(`${import.meta.env.BASE_URL}login`);
};
