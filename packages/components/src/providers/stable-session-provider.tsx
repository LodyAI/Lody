import { useAuthClient } from './convex-provider';
import { useExternalSnapshot } from '../lib/external-snapshot';
import {
  acquireStableSessionSupervisor,
  getStableSessionSupervisor,
} from '../lib/stable-session-supervisor';
import { StableSessionContext, StableSessionSupervisorContext } from '../hooks/useStableSession';

export function StableSessionProvider({ children }: { children: React.ReactNode }) {
  const authClient = useAuthClient();
  const supervisor = getStableSessionSupervisor(authClient);
  const value = useExternalSnapshot(supervisor, () => acquireStableSessionSupervisor(authClient));

  return (
    <StableSessionSupervisorContext.Provider value={supervisor}>
      <StableSessionContext.Provider value={value}>{children}</StableSessionContext.Provider>
    </StableSessionSupervisorContext.Provider>
  );
}
