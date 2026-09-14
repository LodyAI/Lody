import type { MachineId, SessionId } from '@lody/shared';
import { isSessionVisibleToUser, type SessionMachineRecord } from '../lib/session-visibility';

export type SessionControlAuthorization = {
  visibleMachineIds: ReadonlySet<MachineId>;
  visibleLocalProjectKeys: ReadonlySet<string>;
  currentUserId?: string;
};

export type SessionControlAuthorizationDeps = {
  getSessionMeta?: (sessionId: SessionId) => Promise<SessionMachineRecord | undefined>;
  /** Null until the authenticated machine and project snapshots are both ready. */
  getSessionControlAuthorization?: () => SessionControlAuthorization | null;
};

export async function authorizeSessionControl(
  deps: SessionControlAuthorizationDeps,
  sessionId: SessionId,
  machineId: MachineId
): Promise<boolean> {
  const meta = await deps.getSessionMeta?.(sessionId);
  const authorization = deps.getSessionControlAuthorization?.();
  if (!meta || meta.machineId !== machineId || !authorization) return false;
  return isSessionVisibleToUser(
    meta,
    authorization.visibleMachineIds,
    authorization.visibleLocalProjectKeys,
    authorization.currentUserId
  );
}
