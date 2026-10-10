export type AuthenticatedConvexState = {
  isAuthenticated: boolean;
  isLoading: boolean;
};

export const CONVEX_AUTH_RECOVERY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;

export const CONVEX_AUTH_RECOVERY_MAX_ATTEMPTS = CONVEX_AUTH_RECOVERY_DELAYS_MS.length;
export const CONVEX_AUTH_RECOVERY_TIMEOUT_MS = 15_000;
export const CONVEX_AUTH_HEALTHY_RESET_MS = 30_000;

export function getConvexAuthRecoveryDelayMs(attempt: number): number {
  return CONVEX_AUTH_RECOVERY_DELAYS_MS[
    Math.min(Math.max(0, attempt), CONVEX_AUTH_RECOVERY_DELAYS_MS.length - 1)
  ];
}

export function shouldRecoverConvexAuthMismatch({
  isConvexAuthenticated,
  isConvexAuthLoading,
  hasRawSessionUser,
  confirmedUnauthenticated,
}: {
  isConvexAuthenticated: boolean;
  isConvexAuthLoading: boolean;
  hasRawSessionUser: boolean;
  confirmedUnauthenticated: boolean;
}): boolean {
  return (
    hasRawSessionUser && !confirmedUnauthenticated && !isConvexAuthLoading && !isConvexAuthenticated
  );
}

export function resolveAuthenticatedConvexState({
  isConvexAuthenticated,
  isConvexAuthLoading,
  hasRawSessionUser,
  hasLocalToken,
  isSessionPending,
  isSessionRetrying,
  confirmedUnauthenticated,
}: {
  isConvexAuthenticated: boolean;
  isConvexAuthLoading: boolean;
  hasRawSessionUser: boolean;
  hasLocalToken: boolean;
  isSessionPending: boolean;
  isSessionRetrying: boolean;
  confirmedUnauthenticated: boolean;
}): AuthenticatedConvexState {
  const isSessionResolving =
    !hasRawSessionUser &&
    !confirmedUnauthenticated &&
    (hasLocalToken || isSessionPending || isSessionRetrying);
  const shouldRecoverMismatch = shouldRecoverConvexAuthMismatch({
    isConvexAuthenticated,
    isConvexAuthLoading,
    hasRawSessionUser,
    confirmedUnauthenticated,
  });

  return {
    isAuthenticated: isConvexAuthenticated && hasRawSessionUser && !confirmedUnauthenticated,
    isLoading: isConvexAuthLoading || isSessionResolving || shouldRecoverMismatch,
  };
}

export function canRunAuthedWorkspaceQuery(
  workspaceId: string | null | undefined,
  isConvexAuthenticated: boolean
): workspaceId is string {
  return typeof workspaceId === 'string' && workspaceId.length > 0 && isConvexAuthenticated;
}

export function isAuthedWorkspaceQueryLoading({
  workspaceId,
  isConvexAuthLoading,
  canQuery,
  queryResult,
}: {
  workspaceId: string | null | undefined;
  isConvexAuthLoading: boolean;
  canQuery: boolean;
  queryResult: unknown;
}): boolean {
  if (!workspaceId) return false;
  if (isConvexAuthLoading) return true;
  return canQuery && queryResult === undefined;
}
