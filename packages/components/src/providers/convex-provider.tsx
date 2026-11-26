import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { ConvexProviderWithAuth, ConvexReactClient } from 'convex/react';
import { LodyAuthClient, signOutWithAuthClient } from '../lib/auth';
import { clearSessionImageCache } from '../lib/session-image-cache';
import { RecoverableConvexBetterAuthProvider } from './recoverable-convex-better-auth-provider';

/**
 * Stand-in client when `VITE_CONVEX_DEPLOY_URL` is unset (site-docs landing
 * preview, unit tests without Convex). Must tolerate React Fast Refresh and
 * other export introspection (`toString`, `$$typeof`, plain-object probes) —
 * a throw-on-every-get Proxy blows up module evaluation before any real call.
 * Real Convex method use still throws with a clear missing-env message.
 */
function createMissingConvexClient(): ConvexReactClient {
  const message = 'VITE_CONVEX_DEPLOY_URL is required to use ConvexProvider.';
  const throwMissing = () => {
    throw new Error(message);
  };
  return new Proxy({} as ConvexReactClient, {
    get(_target, prop) {
      if (prop === 'toString' || prop === 'valueOf') {
        return () => '[MissingConvexClient]';
      }
      if (prop === Symbol.toStringTag) {
        return 'MissingConvexClient';
      }
      if (prop === Symbol.toPrimitive) {
        return () => '[MissingConvexClient]';
      }
      // Bundler / Fast Refresh probes and thenable checks — never throw here.
      if (
        prop === 'then' ||
        prop === '$$typeof' ||
        prop === 'constructor' ||
        prop === 'prototype' ||
        prop === '__esModule' ||
        typeof prop === 'symbol'
      ) {
        return undefined;
      }
      // Data fields callers often read before calling methods (e.g. github-token).
      if (prop === 'url' || prop === 'address') {
        return undefined;
      }
      // Method-like access: callable that throws only when invoked.
      return throwMissing;
    },
  });
}

export const convexClient = import.meta.env.VITE_CONVEX_DEPLOY_URL
  ? new ConvexReactClient(import.meta.env.VITE_CONVEX_DEPLOY_URL)
  : createMissingConvexClient();

type AuthContextValue = {
  authClient: LodyAuthClient;
  signOut: () => Promise<void>;
};

type ConvexProviderProps = {
  authClient: LodyAuthClient;
  children: React.ReactNode;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const ConvexAuthRestartContext = createContext<(() => void) | null>(null);

export const AuthProvider = ({ authClient, children }: ConvexProviderProps) => {
  const signOut = useCallback(async () => {
    clearSessionImageCache();
    await signOutWithAuthClient(authClient);
  }, [authClient]);
  const value = useMemo<AuthContextValue>(
    () => ({
      authClient,
      signOut,
    }),
    [authClient, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const ConvexProvider = ({ authClient, children }: ConvexProviderProps) => {
  const [authGeneration, setAuthGeneration] = useState(0);
  const restartConvexAuth = useCallback(() => {
    setAuthGeneration((generation) => generation + 1);
  }, []);

  return (
    <AuthProvider authClient={authClient}>
      <ConvexAuthRestartContext.Provider value={restartConvexAuth}>
        <RecoverableConvexBetterAuthProvider
          authClient={authClient}
          client={convexClient}
          recoveryGeneration={authGeneration}
        >
          {children}
        </RecoverableConvexBetterAuthProvider>
      </ConvexAuthRestartContext.Provider>
    </AuthProvider>
  );
};

const noopRestartConvexAuth = () => {};

const useLocalPlatformNoopConvexAuth = () =>
  useMemo(
    () => ({
      isLoading: false,
      isAuthenticated: false,
      fetchAccessToken: async () => null,
    }),
    []
  );

/**
 * Local-platform (open-source build) replacement for `ConvexProvider`: mounts
 * the same client/auth contexts so `useConvex*`/`useAuthClient` consumers keep
 * working, but the auth adapter is a permanent no-op — no Better Auth session
 * fetch, no Convex `setAuth`, zero cloud I/O. Auth-gated Convex queries skip
 * because `isAuthenticated` stays false. `VITE_CONVEX_DEPLOY_URL` is unset in
 * local builds, so `convexClient` is the inert MissingConvexClient above.
 */
export const LocalPlatformConvexProvider = ({ authClient, children }: ConvexProviderProps) => {
  return (
    <AuthProvider authClient={authClient}>
      <ConvexAuthRestartContext.Provider value={noopRestartConvexAuth}>
        <ConvexProviderWithAuth client={convexClient} useAuth={useLocalPlatformNoopConvexAuth}>
          {children}
        </ConvexProviderWithAuth>
      </ConvexAuthRestartContext.Provider>
    </AuthProvider>
  );
};

const useAuthContext = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('Auth context is not available. Wrap the app with ConvexProvider.');
  }
  return context;
};

export const useAuthClient = () => useAuthContext().authClient;
export const useAuthSignOut = () => useAuthContext().signOut;

export const useRestartConvexAuth = () => {
  const restart = useContext(ConvexAuthRestartContext);
  if (!restart) {
    throw new Error('Convex auth restart is not available. Wrap the app with ConvexProvider.');
  }
  return restart;
};
