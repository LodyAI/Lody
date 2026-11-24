import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useAuthClient } from './convex-provider';
import {
  acquireStableSessionSupervisor,
  getStableSessionSupervisor,
} from '../lib/stable-session-supervisor';
import { StableSessionContext, StableSessionSupervisorContext } from '../hooks/useStableSession';

export function StableSessionProvider({ children }: { children: React.ReactNode }) {
  const authClient = useAuthClient();
  const supervisor = useMemo(() => getStableSessionSupervisor(authClient), [authClient]);
  const value = useSyncExternalStore(
    supervisor.subscribe,
    supervisor.getSnapshot,
    supervisor.getSnapshot
  );

  useEffect(() => {
    const lease = acquireStableSessionSupervisor(authClient);
    return lease.release;
  }, [authClient, supervisor]);

  return (
    <StableSessionSupervisorContext.Provider value={supervisor}>
      <StableSessionContext.Provider value={value}>{children}</StableSessionContext.Provider>
    </StableSessionSupervisorContext.Provider>
  );
}
