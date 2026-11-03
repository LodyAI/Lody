import { describe, expect, it } from 'vitest';
import {
  isAuthedWorkspaceQueryLoading,
  resolveAuthenticatedConvexState,
  shouldRecoverConvexAuthMismatch,
} from '../src/lib/authed-convex-query';

describe('resolveAuthenticatedConvexState', () => {
  const authenticated = {
    isConvexAuthenticated: true,
    isConvexAuthLoading: false,
    hasRawSessionUser: true,
    hasLocalToken: true,
    isSessionPending: false,
    isSessionRetrying: false,
    confirmedUnauthenticated: false,
  };

  it('requires both the Better Auth session and Convex server confirmation', () => {
    expect(resolveAuthenticatedConvexState(authenticated)).toEqual({
      isAuthenticated: true,
      isLoading: false,
    });
    expect(resolveAuthenticatedConvexState({ ...authenticated, hasRawSessionUser: false })).toEqual(
      { isAuthenticated: false, isLoading: true }
    );
    expect(
      resolveAuthenticatedConvexState({ ...authenticated, isConvexAuthenticated: false })
    ).toEqual({ isAuthenticated: false, isLoading: true });
    expect(
      shouldRecoverConvexAuthMismatch({
        ...authenticated,
        hasRawSessionUser: true,
        isConvexAuthenticated: false,
      })
    ).toBe(true);
  });

  it('waits through session recovery but settles after confirmed expiry', () => {
    expect(
      resolveAuthenticatedConvexState({
        ...authenticated,
        hasRawSessionUser: false,
        isSessionRetrying: true,
      })
    ).toEqual({ isAuthenticated: false, isLoading: true });
    expect(
      resolveAuthenticatedConvexState({
        ...authenticated,
        hasRawSessionUser: false,
        confirmedUnauthenticated: true,
      })
    ).toEqual({ isAuthenticated: false, isLoading: false });
  });

  it('keeps an established raw session usable during background refetch', () => {
    expect(resolveAuthenticatedConvexState({ ...authenticated, isSessionPending: true })).toEqual({
      isAuthenticated: true,
      isLoading: false,
    });
  });
});

describe('isAuthedWorkspaceQueryLoading', () => {
  it('waits while Convex auth is still loading for a workspace', () => {
    expect(
      isAuthedWorkspaceQueryLoading({
        workspaceId: 'workspace-1',
        isConvexAuthLoading: true,
        canQuery: false,
        queryResult: undefined,
      })
    ).toBe(true);
  });

  it('does not treat a skipped query as loading after auth has settled', () => {
    expect(
      isAuthedWorkspaceQueryLoading({
        workspaceId: 'workspace-1',
        isConvexAuthLoading: false,
        canQuery: false,
        queryResult: undefined,
      })
    ).toBe(false);
  });
});
