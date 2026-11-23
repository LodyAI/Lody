import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ConvexProviderWithAuth, type ConvexReactClient } from 'convex/react';
import { getAuthSessionIntentGeneration, type LodyAuthClient } from '../lib/auth';
import { activateConvexJwtAuthKey, requestConvexJwt } from '../lib/convex-jwt';

type RecoverableConvexBetterAuthProviderProps = {
  authClient: LodyAuthClient;
  children: ReactNode;
  client: ConvexReactClient;
  recoveryGeneration: number;
};

type CachedToken = {
  authKey: string;
  token: string | null;
};

type PendingToken = {
  authKey: string;
  promise: Promise<string | null>;
};

export function RecoverableConvexBetterAuthProvider({
  authClient,
  children,
  client,
  recoveryGeneration,
}: RecoverableConvexBetterAuthProviderProps) {
  const useBetterAuth = useRecoverableBetterAuth(authClient, recoveryGeneration);

  useEffect(() => {
    void (async () => {
      if (typeof window === 'undefined' || !window.location?.href) return;

      const url = new URL(window.location.href);
      const token = url.searchParams.get('ott');
      if (!token) return;

      url.searchParams.delete('ott');
      window.history.replaceState({}, '', url);
      const result = await authClient.crossDomain.oneTimeToken.verify({ token });
      const session = result.data?.session;
      if (!session) return;

      await authClient.getSession({
        fetchOptions: {
          headers: { Authorization: `Bearer ${session.token}` },
        },
      });
      await authClient.updateSession();
    })().catch((error) => {
      // A navigation or renderer teardown can disconnect any request in this
      // bootstrap. Keep that expected lifecycle failure out of global error handling.
      console.warn('[Auth] Failed to bootstrap session from one-time token', error);
    });
  }, [authClient]);

  return (
    <ConvexProviderWithAuth client={client} useAuth={useBetterAuth}>
      {children}
    </ConvexProviderWithAuth>
  );
}

function useRecoverableBetterAuth(authClient: LodyAuthClient, generation: number) {
  return useMemo(
    () =>
      function useAuthFromBetterAuth() {
        const { data: session, isPending: isSessionPending } = authClient.useSession();
        const sessionId = session?.session?.id;
        const hasSession = Boolean(session?.session);
        const authIntentGeneration = getAuthSessionIntentGeneration(authClient);
        const authKey = `${generation}:${authIntentGeneration}:${sessionId ?? ''}`;
        const [cachedTokenState, setCachedTokenState] = useState<CachedToken>({
          authKey,
          token: null,
        });
        const cachedTokenRef = useRef(cachedTokenState);
        const pendingTokenRef = useRef<PendingToken | null>(null);
        const activeAuthKeyRef = useRef(authKey);
        const requestSequenceRef = useRef(0);
        const mountedRef = useRef(true);
        activeAuthKeyRef.current = authKey;
        // Out-of-band JWT recovery joins this session's request; publish before any effect runs.
        const jwtIdentity = `${authIntentGeneration}:${sessionId ?? ''}`;
        activateConvexJwtAuthKey(authClient, authKey, jwtIdentity);
        const cachedToken = cachedTokenState.authKey === authKey ? cachedTokenState.token : null;

        useEffect(
          () => activateConvexJwtAuthKey(authClient, authKey, jwtIdentity),
          [authKey, jwtIdentity]
        );

        useEffect(() => {
          mountedRef.current = true;
          return () => {
            mountedRef.current = false;
            requestSequenceRef.current += 1;
            pendingTokenRef.current = null;
          };
        }, []);

        useEffect(() => {
          if (!session && !isSessionPending && cachedToken !== null) {
            const next = { authKey, token: null };
            cachedTokenRef.current = next;
            setCachedTokenState(next);
          }
        }, [authKey, cachedToken, isSessionPending, session]);

        const fetchAccessToken = useCallback(
          async ({ forceRefreshToken = false }: { forceRefreshToken?: boolean } = {}) => {
            if (
              !mountedRef.current ||
              getAuthSessionIntentGeneration(authClient) !== authIntentGeneration
            ) {
              return null;
            }
            const currentCachedToken =
              cachedTokenRef.current.authKey === authKey ? cachedTokenRef.current.token : null;
            if (!forceRefreshToken) {
              if (currentCachedToken !== null) {
                return currentCachedToken;
              }
              if (pendingTokenRef.current?.authKey === authKey) {
                return pendingTokenRef.current.promise;
              }

              // Convex deliberately asks for a possibly cached token first and
              // then force-refreshes after the server confirms it. Better Auth's
              // token endpoint has no synchronous client cache, so fetching here
              // would turn that protocol into two startup HTTP requests. Returning
              // null makes Convex immediately take its fresh-token path instead.
              return null;
            }
            if (pendingTokenRef.current?.authKey === authKey) {
              return pendingTokenRef.current.promise;
            }

            const requestSequence = requestSequenceRef.current + 1;
            requestSequenceRef.current = requestSequence;
            const promise = requestConvexJwt(authClient, authKey)
              .then((token) => {
                const isCurrentRequest =
                  mountedRef.current &&
                  getAuthSessionIntentGeneration(authClient) === authIntentGeneration &&
                  activeAuthKeyRef.current === authKey &&
                  requestSequenceRef.current === requestSequence;
                if (!isCurrentRequest) {
                  // Convex can keep awaiting a force-refresh after the provider
                  // has logged out or switched sessions. Never hand that old
                  // session's JWT back to its still-live auth manager.
                  return null;
                }

                const next = { authKey, token };
                cachedTokenRef.current = next;
                setCachedTokenState(next);
                return token;
              })
              .catch(() => {
                if (
                  activeAuthKeyRef.current === authKey &&
                  requestSequenceRef.current === requestSequence
                ) {
                  const next = { authKey, token: null };
                  cachedTokenRef.current = next;
                  setCachedTokenState(next);
                }
                return null;
              })
              .finally(() => {
                if (pendingTokenRef.current?.promise === promise) {
                  pendingTokenRef.current = null;
                }
              });

            pendingTokenRef.current = { authKey, promise };
            return promise;
          },
          [authIntentGeneration, authKey]
        );

        return useMemo(
          () => ({
            isLoading: isSessionPending && cachedToken === null,
            isAuthenticated: hasSession || cachedToken !== null,
            fetchAccessToken,
          }),
          [cachedToken, fetchAccessToken, hasSession, isSessionPending]
        );
      },
    [authClient, generation]
  );
}
