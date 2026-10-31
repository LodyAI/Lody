import { createContext, useContext } from 'react';
import type { AuthenticatedConvexState } from '@/lib/authed-convex-query';

export type AuthenticatedConvexContextValue = AuthenticatedConvexState & {
  authSessionId: string | null;
  confirmedUnauthenticated: boolean;
  isRecovering: boolean;
  claimAutomaticCommand: (key: string) => boolean;
  requestAuthRecovery: () => void;
};

export const AuthenticatedConvexContext = createContext<AuthenticatedConvexContextValue | null>(
  null
);

export function useOptionalAuthenticatedConvex(): AuthenticatedConvexContextValue | null {
  return useContext(AuthenticatedConvexContext);
}

export function useAuthenticatedConvex(): AuthenticatedConvexContextValue {
  const context = useOptionalAuthenticatedConvex();
  if (!context) {
    throw new Error('useAuthenticatedConvex must be used within an AuthenticatedConvexProvider');
  }
  return context;
}
