import { atom } from 'jotai';
import type { SessionArchiveMode } from '@lody/shared';
import { getSessionRoomId, type SessionId } from '@lody/shared';
import { atomFamily } from 'jotai/utils';
import { sessionMetaAtomFamily } from './doc-meta';

export const pendingArchiveRootAtomFamily = atomFamily((id: string) =>
  atom((get) => {
    const meta = get(sessionMetaAtomFamily(getSessionRoomId(id as SessionId)));
    if (meta?.isArchived || !meta?.archivePending) return null;
    const root = get(sessionMetaAtomFamily(getSessionRoomId(meta.archivePending.rootId)));
    if (
      root?.archiveCancelledRequestId === meta.archivePending.requestId ||
      root?.archiveRequest?.phase === 'completed' ||
      root?.archiveRequest?.phase === 'cancelled'
    )
      return null;
    return meta.archivePending.rootId;
  })
);

export const sessionArchiveDialogAtom = atom<{
  count: number;
  resolve: (mode: SessionArchiveMode | null) => void;
} | null>(null);
