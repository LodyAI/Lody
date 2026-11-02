import { useAtomValue } from 'jotai';
import type { SessionId } from '@lody/shared';
import { sessionMetaIdentityAtomFamily } from '@/atoms/doc-meta';

/** Read-only repo-cache identity; pending sends and catalog guesses are excluded. */
export function SessionMetaIdentityMarker({
  sessionId,
  isVisible,
}: {
  sessionId: SessionId;
  isVisible: boolean;
}) {
  const identity = useAtomValue(sessionMetaIdentityAtomFamily(sessionId));
  if (!isVisible || !identity) return null;
  return (
    <span
      hidden
      data-testid="session-meta-identity"
      data-source="repo-cache"
      data-workspace-id={identity.workspaceId}
      data-session-id={identity.sessionId}
      data-machine-id={identity.machineId}
    />
  );
}
