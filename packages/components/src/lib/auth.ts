import { requestSessionSendExit } from './session-send-exit';
import { createAuthClient } from 'better-auth/react';
import { organizationClient } from 'better-auth/client/plugins';
import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins';
import {
  clearAuthBootstrapSnapshot,
  clearStoredAuthToken,
  writeStoredAuthToken,
} from './auth-bootstrap';
import { deferredPostHog } from './deferred-posthog';
import { registerAuthClient } from './auth-client-singleton';
import { replaceAppWindowLocation } from './app-location';
import { clearLastAppRoutePath } from './last-app-route';
import { setLoginHintCookie } from './login-hint-cookie';
import { clearPreferredWorkspaceSlug } from './workspace';

type BetterAuthClientOptions = NonNullable<Parameters<typeof createAuthClient>[0]>;
type BetterAuthClientPlugin = NonNullable<BetterAuthClientOptions['plugins']>[number];

type CreateLodyAuthClientOptions = {
  additionalPlugins?: BetterAuthClientPlugin[];
  disableDefaultFetchPlugins?: boolean;
};

export const createLodyAuthClient = (options: CreateLodyAuthClientOptions = {}) => {
  const additionalPlugins = options.additionalPlugins ?? [];

  const client = createAuthClient({
    baseURL: import.meta.env.VITE_CONVEX_SITE_URL,
    plugins: [organizationClient(), convexClient(), crossDomainClient(), ...additionalPlugins],
    disableDefaultFetchPlugins: options.disableDefaultFetchPlugins || false,
  });
  registerAuthClient(client);
  return client;
};

export type LodyAuthClient = ReturnType<typeof createLodyAuthClient>;

const AUTH_SESSION_INTENT_GENERATIONS = new WeakMap<object, number>();

export const getAuthSessionIntentGeneration = (authClient: LodyAuthClient): number =>
  AUTH_SESSION_INTENT_GENERATIONS.get(authClient) ?? 0;

const invalidateAuthSessionIntent = (authClient: LodyAuthClient): void => {
  AUTH_SESSION_INTENT_GENERATIONS.set(authClient, getAuthSessionIntentGeneration(authClient) + 1);
};

export const clearLocalAuthState = () => {
  clearStoredAuthToken();
  clearAuthBootstrapSnapshot();
  clearLastAppRoutePath();
  clearPreferredWorkspaceSlug();
  if (typeof window !== 'undefined') {
    try {
      deferredPostHog.reset();
    } catch (error) {
      console.error('PostHog reset error:', error);
    }
  }
  setLoginHintCookie(false);
};

export const persistAuthToken = (token: string) => {
  writeStoredAuthToken(token);
};

export const signOutWithoutRedirect = async (authClient: LodyAuthClient, options?: { sessionExpired?: boolean }) => {
  if (!options?.sessionExpired && !(await requestSessionSendExit('logout'))) return false;
  // Fence token requests at logout intent, before Better Auth's async sign-out
  // updates useSession(). Otherwise a token request that completes in that
  // network window can still authenticate Convex as the previous user.
  invalidateAuthSessionIntent(authClient);
  clearLocalAuthState();

  try {
    await authClient.signOut();
  } catch (error) {
    console.error('Sign out error:', error);
  }
  return true;
};

export const signOutWithAuthClient = async (authClient: LodyAuthClient) => {
  if (!(await signOutWithoutRedirect(authClient))) return;
  replaceAppWindowLocation(`${import.meta.env.BASE_URL}login`);
};
