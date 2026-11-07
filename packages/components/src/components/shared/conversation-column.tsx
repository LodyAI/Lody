import type { HTMLAttributes } from 'react';
import { useAtomValue } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';

import { conversationWideModeAtom } from '@/atoms/settings';
import { conversationColumnStyles as column } from '@/lib/conversation-layout';

/** One centered conversation column, synchronized with the full-width setting. */
export function ConversationColumn({
  className,
  xstyle,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { xstyle?: stylex.StyleXStyles }) {
  const wide = useAtomValue(conversationWideModeAtom);
  // Callers may inset a narrow wide-mode strip. The normal reading gutter and
  // the desktop outline-rail reservation remain the column's layout contract.
  const sx = stylex.props(
    column.base,
    wide && column.wide,
    xstyle,
    wide ? column.wideDesktop : column.capped
  );
  return (
    <div
      data-slot="conversation-column"
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...style } : style}
      {...props}
    />
  );
}
