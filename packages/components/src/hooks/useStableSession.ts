import { createContext, useContext } from 'react';
import { useAuthClient } from '../providers/convex-provider';
import { useExternalSnapshot } from '../lib/external-snapshot';
import {
  acquireStableSessionSupervisor,
  getStableSessionSupervisor,
  type StableSessionOptions,
  type StableSessionSupervisor,
  type StableSessionValue,
} from '../lib/stable-session-supervisor';

export type { StableSessionOptions, StableSessionSupervisor, StableSessionValue };

const StableSessionContext = createContext<StableSessionValue | null>(null);
const StableSessionSupervisorContext = createContext<StableSessionSupervisor | null>(null);

export { StableSessionContext, StableSessionSupervisorContext };

/**
 * React only projects the external auth supervisor. It does not call Better
 * Auth hooks, install lifecycle listeners, own retry timers, or perform reads.
 */
export function useStableSessionInternal(options?: StableSessionOptions): StableSessionValue {
  const authClient = useAuthClient();
  const supervisor = getStableSessionSupervisor(authClient, options);
  return useExternalSnapshot(supervisor, () => acquireStableSessionSupervisor(authClient));
}

export function useStableSessionSupervisor(): StableSessionSupervisor {
  const supervisor = useContext(StableSessionSupervisorContext);
  if (!supervisor) {
    throw new Error('useStableSessionSupervisor must be used within a StableSessionProvider');
  }
  return supervisor;
}

export function useStableSession(): StableSessionValue {
  const ctx = useContext(StableSessionContext);
  if (!ctx) {
    throw new Error('useStableSession must be used within a StableSessionProvider');
  }
  return ctx;
}
