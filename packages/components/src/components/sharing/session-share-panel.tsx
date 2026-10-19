import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import type { SessionMeta, WorkspaceId } from '@lody/shared';
import { userAtom } from '@/atoms';
import { Skeleton } from '@lody/ui/skeleton';
import { useShareEditorModel } from './share-editor-model';
import { SessionShareManager } from './session-share-manager';

function EmbeddedEditor({
  workspaceId,
  session,
  shareId,
  onClose,
  onBusyChange,
}: {
  workspaceId: WorkspaceId;
  session: SessionMeta;
  shareId?: string;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { candidates, management } = useShareEditorModel(workspaceId, session, shareId);
  // The host must not dismiss the panel while a publication is under way: the
  // dialog's "keep this open until it finishes" promise, kept for a surface that
  // an outside press can close.
  const working = management.busy || management.phase !== 'idle';
  useEffect(() => {
    onBusyChange?.(working);
  }, [onBusyChange, working]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  return (
    <SessionShareManager
      embedded
      sessionId={session.id}
      candidates={candidates}
      onClose={onClose}
      {...management}
    />
  );
}

/**
 * The publication editor, hosted inside the header's access panel instead of a
 * dialog. Same hook, same manager, same one primary action per step; only the
 * frame differs. Mounted only while the panel's publish view is open.
 */
export function SessionShareEditorPanel({
  workspaceId,
  session,
  shareId,
  onClose,
  onBusyChange,
}: {
  workspaceId: WorkspaceId;
  session: SessionMeta;
  shareId?: string;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const userId = useAtomValue(userAtom)?.id;
  if (userId === undefined) return <Skeleton width="100%" height={48} />;
  return (
    <EmbeddedEditor
      key={`${userId}:${workspaceId}:${session.id}:${shareId ?? ''}`}
      workspaceId={workspaceId}
      session={session}
      shareId={shareId}
      onClose={onClose}
      onBusyChange={onBusyChange}
    />
  );
}
