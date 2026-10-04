import type { HTMLAttributes } from 'react';
import { useAtomValue } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

import { conversationWideModeAtom } from '@/atoms/settings';
import {
  CONVERSATION_CONTENT_WIDTH_CLASS,
  CONVERSATION_CONTENT_WIDTH_WIDE_CLASS,
} from '@/lib/conversation-layout';
import { cn } from '@/lib/utils';

const styles = stylex.create({
  wide: {
    paddingInline: {
      default: '14px',
      // Leave room for the outline rail, including its magnified ticks.
      '@media (min-width: 640px)': `calc(${space[8]} * 2)`,
    },
  },
});

/**
 * The ONE centered content column of the session conversation page (message
 * rows / context strip / composer content / permission surface). See
 * `@/lib/conversation-layout` for why each full-bleed region mounts its own
 * column instead of a single page-level parent.
 *
 * Reads `conversationWideModeAtom` itself so every region switches together:
 * In wide mode the column drops its cap and reserves symmetric desktop gutters
 * so the outline rail cannot overlap the content.
 */
export function ConversationColumn({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const wide = useAtomValue(conversationWideModeAtom);
  return (
    <div
      className={cn(
        wide ? CONVERSATION_CONTENT_WIDTH_WIDE_CLASS : CONVERSATION_CONTENT_WIDTH_CLASS,
        wide && stylex.props(styles.wide).className,
        className
      )}
      {...props}
    />
  );
}
