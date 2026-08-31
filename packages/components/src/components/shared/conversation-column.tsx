import type { HTMLAttributes } from 'react';

import { CONVERSATION_CONTENT_WIDTH_CLASS } from '@/lib/conversation-layout';
import { CHAT_WORKSPACE_GEOMETRY_ANCHORS } from '@/lib/chat-workspace-geometry';
import { cn } from '@/lib/utils';

/**
 * The ONE centered content column of the session conversation page (message
 * rows / context strip / composer content / permission surface). See
 * `@/lib/conversation-layout` for why each full-bleed region mounts its own
 * column instead of a single page-level parent.
 */
export function ConversationColumn({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(CONVERSATION_CONTENT_WIDTH_CLASS, className)}
      {...props}
      data-geometry-anchor={CHAT_WORKSPACE_GEOMETRY_ANCHORS.conversationColumn}
    />
  );
}
