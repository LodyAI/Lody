import { useMemo, useRef, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { SessionMeta, WorkspaceId } from '@lody/shared';
import { userAtom } from '@/atoms';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import * as stylex from '@stylexjs/stylex';
import { Dialog } from '@/ui/dialog';
import { getSessionShareCandidates } from '@/lib/session-share-candidates';
import { useSessionShareManagement } from '@/hooks/use-session-share-management';
import { SessionShareManager } from './session-share-manager';
import { useKeyboardAwareScrollIntoView } from '@/hooks/use-keyboard-aware-scroll-into-view';

const styles = stylex.create({
  /** The conversation's title is one line; a long one takes the ellipsis. */
  title: {
    display: 'block',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** The one scrolling box. Its scrollbar is hidden: the sticky action row marks the end. */
  body: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    scrollbarWidth: 'none',
    '::-webkit-scrollbar': { display: 'none' },
  },
});

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
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const body = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useKeyboardAwareScrollIntoView(body);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <Dialog.Content
        ref={panel}
        tabIndex={-1}
        // Opening must not pre-select the link field or arm the sub-conversation
        // checkbox; focus the panel and let the first Tab reach the controls.
        initialFocus={() => panel.current}
        // The panel is `@lody/ui`'s own; only its vertical placement is this
        // frame's, lifted and shrunk above the native keyboard.
        style={{
          insetBlockStart:
            'calc((100dvh - var(--native-keyboard-height, 0px) + var(--safe-area-top, 0px) - max(0px, var(--safe-area-bottom, 0px) - var(--native-keyboard-height, 0px))) / 2)',
          maxHeight:
            'calc(100dvh - var(--native-keyboard-height, 0px) - 2rem - var(--safe-area-top, 0px) - max(0px, var(--safe-area-bottom, 0px) - var(--native-keyboard-height, 0px)))',
        }}
      >
        {/* The conversation being shared is the subject, so it carries the header:
            the action reads as a small label above it, not as the larger line. */}
        <Dialog.Header>
          <Dialog.Description>{t('sharing.manager.title', 'Share')}</Dialog.Description>
          <Dialog.Title>
            <span {...stylex.props(styles.title)}>{title}</span>
          </Dialog.Title>
        </Dialog.Header>
        <div ref={body} {...stylex.props(styles.body)}>
          {children}
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function ShareEditor({
  workspaceId,
  session,
  shareId,
  onClose,
  title,
}: {
  workspaceId: WorkspaceId;
  session: SessionMeta;
  shareId?: string;
  onClose: () => void;
  title: string;
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
    shareId
  );
  return (
    <SessionShareDialogFrame title={title} onClose={onClose}>
      <SessionShareManager
        sessionId={session.id}
        candidates={candidates}
        onClose={onClose}
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
}: {
  workspaceId: WorkspaceId;
  session: SessionMeta;
  onClose: () => void;
  shareId?: string;
}) {
  const { t } = useTranslation();
  const userId = useAtomValue(userAtom)?.id;
  const title = (session.title ?? '') || t('sessions.untitled', 'Untitled session');
  if (userId === undefined) return <SessionShareDialogFrame title={title} onClose={onClose} />;
  return (
    <ShareEditor
      key={`${userId}:${workspaceId}:${session.id}:${shareId ?? ''}`}
      workspaceId={workspaceId}
      session={session}
      shareId={shareId}
      onClose={onClose}
      title={title}
    />
  );
}
