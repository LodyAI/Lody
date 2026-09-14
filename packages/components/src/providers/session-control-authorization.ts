import type { MachineId, SessionId, SessionMeta } from '@lody/shared';
import { getLocalProjectVisibilityKey } from '../lib/visible-local-project-index';

export type SessionControlAuthorization = {
  visibleMachineIds: ReadonlySet<MachineId>;
  visibleLocalProjectKeys: ReadonlySet<string>;
};

export type SessionControlAuthorizationDeps = {
  getSessionMeta?: (
    sessionId: SessionId
  ) => Promise<Pick<SessionMeta, 'machineId' | 'project'> | undefined>;
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
  if (!meta || meta.machineId !== machineId || !authorization?.visibleMachineIds.has(machineId))
    return false;
  // Display ownership is not a control grant; revoked machine access always denies control.
  if (meta.project?.kind === 'local') {
    const projectId = meta.project.localProjectId;
    return (
      typeof projectId === 'string' &&
      projectId.length > 0 &&
      authorization.visibleLocalProjectKeys.has(getLocalProjectVisibilityKey(machineId, projectId))
    );
  }
  return true;
}
