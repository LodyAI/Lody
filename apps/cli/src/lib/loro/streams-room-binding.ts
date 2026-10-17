import type { RepoTransportRoomStatus } from 'loro-repo';
import type { WorkspaceRoom, WorkspaceRoomBinding } from '@lody/shared/workspace-data/repo-legacy';

export const STREAMS_TRANSPORT_ID = 'streams';

/** The scoped native room's UI view preserves deliberate absence as detached. */
export type StreamsRoomBinding = WorkspaceRoomBinding;

/** An absent route is idle; only an attached, broken route needs recovery. */
export const isRecoverableStreamsRoomStatus = (status: RepoTransportRoomStatus | null): boolean =>
  status === 'disconnected' || status === 'error';

export function streamsRoomBinding(sub: WorkspaceRoom): StreamsRoomBinding {
  return sub.subscription(STREAMS_TRANSPORT_ID);
}
