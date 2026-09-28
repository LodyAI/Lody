import type { HTMLAttributes } from 'react';
import { useAtomValue } from 'jotai';

import { conversationWideModeAtom } from '@/atoms/settings';
import {
  CONVERSATION_CONTENT_WIDTH_CLASS,
  CONVERSATION_CONTENT_WIDTH_WIDE_CLASS,
} from '@/lib/conversation-layout';
import { cn } from '@/lib/utils';

/**
 * The ONE centered content column of the session conversation page (message
 * rows / context strip / composer content / permission surface). See
 * `@/lib/conversation-layout` for why each full-bleed region mounts its own
 * column instead of a single page-level parent.
 *
 * Reads `conversationWideModeAtom` itself so every region switches together:
 * in wide mode the column keeps its gutter but drops the max-width cap.
 */
export function ConversationColumn({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const wide = useAtomValue(conversationWideModeAtom);
  return (
    <div
      className={cn(
        wide ? CONVERSATION_CONTENT_WIDTH_WIDE_CLASS : CONVERSATION_CONTENT_WIDTH_CLASS,
        className
      )}
      {...props}
    />
  );
}
