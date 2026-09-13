import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { SessionMeta, WorkspaceId } from '@lody/shared';
import { userAtom } from '@/atoms';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { cn } from '@/lib/utils';
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
  wide,
  children,
}: {
  title: string;
  onClose?: () => void;
  /** Widen for the frozen-copy preview, which needs conversation-sized room. */
  wide?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const body = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useKeyboardAwareScrollIntoView(body);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <DialogContent
        ref={panel}
        tabIndex={-1}
        // Opening must not pre-select the link field or arm the sub-conversation
        // checkbox; focus the panel and let the first Tab reach the controls.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          panel.current?.focus();
        }}
        className={cn(
          'flex w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:p-0',
          'transition-[max-width] duration-300 ease-out motion-reduce:transition-none',
          wide ? 'max-w-3xl' : 'max-w-md'
        )}
        style={{
          top: 'calc((100dvh - var(--native-keyboard-height, 0px) + var(--safe-area-top, 0px) - max(0px, var(--safe-area-bottom, 0px) - var(--native-keyboard-height, 0px))) / 2)',
          maxHeight:
            'calc(100dvh - var(--native-keyboard-height, 0px) - 2rem - var(--safe-area-top, 0px) - max(0px, var(--safe-area-bottom, 0px) - var(--native-keyboard-height, 0px)))',
        }}
      >
        <DialogHeader className="shrink-0 gap-0.5 px-5 pb-3 pt-4 text-left">
          <DialogTitle className="pr-7 text-[0.9375rem] font-semibold leading-6">
            {t('sharing.manager.title', 'Share conversation')}
          </DialogTitle>
          <DialogDescription className="truncate text-xs text-muted-foreground">
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
  onClose,
  title,
}: {
  workspaceId: WorkspaceId;
  session: SessionMeta;
  shareId?: string;
  confirmation?: { requestId: string; sessionIds: string[] };
  onClose: () => void;
  title: string;
}) {
  const { t } = useTranslation();
  const meta = useAtomValue(sessionMetaCacheAtom);
  const [wide, setWide] = useState(false);
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
    <SessionShareDialogFrame title={title} onClose={onClose} wide={wide}>
      <SessionShareManager
        sessionId={session.id}
        candidates={candidates}
        selectionLocked={!!confirmation}
        onClose={onClose}
        onPreviewOpenChange={setWide}
        {...management}
      />
    </SessionShareDialogFrame>
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
  const title = (session.title ?? '') || t('sessions.untitled', 'Untitled session');
  if (userId === undefined) return <SessionShareDialogFrame title={title} onClose={onClose} />;
  return (
    <ShareEditor
      key={`${userId}:${workspaceId}:${session.id}:${shareId ?? ''}:${confirmation?.requestId ?? ''}`}
      workspaceId={workspaceId}
      session={session}
      shareId={shareId}
      confirmation={confirmation}
      onClose={onClose}
      title={title}
    />
  );
}
