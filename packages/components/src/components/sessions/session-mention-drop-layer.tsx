import { clsx } from 'clsx';
import { type ReactNode } from 'react';

import { useSessionMentionDropZone } from '@/hooks/use-session-mention-drag';
import { ConversationDropOverlay } from '@/components/shared/conversation-drop-overlay';
import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  layer: {
    position: 'relative',
    height: '100%',
    minHeight: 'calc(var(--spacing) * 0)',
    overflow: 'hidden',
  },
});

/**
 * One drop mask for a keep-alive tab stack (parent + child + draft tabs).
 *
 * Overlay cannot live inside each tab page: inactive pages are `hidden`, draft
 * tabs are a different component, and `absolute` masks then either vanish or
 * stack against the wrong pane. This layer is the conversation column itself.
 */
export function SessionMentionDropLayer({
  enabled,
  excludeSessionId,
  onDropSessionId,
  className,
  children,
}: {
  enabled: boolean;
  excludeSessionId?: string | null;
  onDropSessionId: (sessionId: string) => void;
  className?: string;
  children: ReactNode;
}) {
  const { dropZone, overlayActive } = useSessionMentionDropZone({
    enabled,
    excludeSessionId,
    onDropSessionId,
  });

  return (
    <div
      className={clsx(stylex.props(styles.layer).className, className)}
      data-session-mention-drop-layer=""
      {...dropZone.handlers}
    >
      <ConversationDropOverlay active={overlayActive} kind="session-mention" />
      {children}
    </div>
  );
}
