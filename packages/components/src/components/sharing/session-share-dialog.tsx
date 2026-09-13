import { useMemo, useRef, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { SessionMeta, WorkspaceId } from '@lody/shared';
import { userAtom } from '@/atoms';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/ui/dialog';
import { getSessionShareCandidates } from '@/lib/session-share-candidates';
import { useSessionShareManagement } from '@/hooks/use-session-share-management';
import { SessionShareManager } from './session-share-manager';
import { useKeyboardAwareScrollIntoView } from '@/hooks/use-keyboard-aware-scroll-into-view';

/**
 * Shared with the manager stories and the product dialog.
 *
 * The panel is a fixed header over one scrolling body, not a single scrolling
 * box: the manager's action row sticks to the bottom of that body, so the
 * primary action stays reachable on a narrow phone and behind a soft keyboard.
 * The keyboard hook must therefore observe the body, which is the element that
 * actually scrolls, and the portal keeps shrinking/lifting for
 * `--native-keyboard-height` because the root layout padding never reaches it.
 */
export function SessionShareDialogFrame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const body = useRef<HTMLDivElement>(null);
  useKeyboardAwareScrollIntoView(body);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <DialogContent
        className="flex w-[calc(100vw-2rem)] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:p-0"
        style={{
          top: 'calc((100dvh - var(--native-keyboard-height, 0px) + var(--safe-area-top, 0px) - max(0px, var(--safe-area-bottom, 0px) - var(--native-keyboard-height, 0px))) / 2)',
          maxHeight:
            'calc(100dvh - var(--native-keyboard-height, 0px) - 2rem - var(--safe-area-top, 0px) - max(0px, var(--safe-area-bottom, 0px) - var(--native-keyboard-height, 0px)))',
        }}
      >
        <DialogHeader className="shrink-0 gap-1 border-b border-border px-4 py-3.5 text-left sm:px-5">
          <DialogTitle className="pr-6 text-base">
            {t('sharing.manager.title', 'Share conversation')}
          </DialogTitle>
          <DialogDescription className="line-clamp-2 break-words text-xs">
            {title}
          </DialogDescription>
        </DialogHeader>
        <div
          ref={body}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShareEditor({
  workspaceId,
  session,
  shareId,
  confirmation,
}: {
  workspaceId: WorkspaceId;
  session: SessionMeta;
  shareId?: string;
  confirmation?: { requestId: string; sessionIds: string[] };
}) {
  const { t } = useTranslation();
  const meta = useAtomValue(sessionMetaCacheAtom);
  // Discovery proposes the explicit set frozen by the publishing client.
  const candidates = useMemo(
    () =>
      [session, ...getSessionShareCandidates(session.id, Object.values(meta)).slice(0, 96)].map(
        (entry) => ({
          sessionId: entry.id,
          title: (entry.title ?? '') || t('sessions.untitled', 'Untitled session'),
        })
      ),
    [meta, session, t]
  );
  const management = useSessionShareManagement(
    workspaceId,
    session.id,
    candidates.map((entry) => entry.sessionId),
    shareId,
    confirmation
  );
  return (
    <SessionShareManager
      sessionId={session.id}
      candidates={candidates}
      selectionLocked={!!confirmation}
      {...management}
    />
  );
}

/** Mounted only while open: closed headers do not query or traverse session metadata. */
export function SessionShareDialog({
  workspaceId,
  session,
  onClose,
  shareId,
  confirmation,
}: {
  workspaceId: WorkspaceId;
  session: SessionMeta;
  onClose: () => void;
  shareId?: string;
  confirmation?: { requestId: string; sessionIds: string[] };
}) {
  const { t } = useTranslation();
  const userId = useAtomValue(userAtom)?.id;
  return (
    <SessionShareDialogFrame
      title={(session.title ?? '') || t('sessions.untitled', 'Untitled session')}
      onClose={onClose}
    >
      {userId !== undefined && (
        <ShareEditor
          key={`${userId}:${workspaceId}:${session.id}:${shareId ?? ''}:${confirmation?.requestId ?? ''}`}
          workspaceId={workspaceId}
          session={session}
          shareId={shareId}
          confirmation={confirmation}
        />
      )}
    </SessionShareDialogFrame>
  );
}
