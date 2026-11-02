import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import { WORKSPACE_FRAME_CSS } from '@/lib/workspace-frame';
import { cn } from '@/lib/utils';
import { DocumentStyle } from './document-style';

const styles = stylex.create({
  /**
   * The content area is separated from the window ground by a thin rim rather than
   * floating in a wide gutter. The left edge still anchors directly to a visible
   * sidebar; the other edges keep one spacing step of shell colour around the page.
   */
  card: {
    '--lody-frame-gutter': space[1],
    '--lody-frame-radius': radius.large,
  },
});

/**
 * The page card of the workspace shell: every page sits in it, inset from the window's
 * ground (the layout root's `bg-sidebar`). Shared by `WebWorkspaceLayout` and the
 * Storybook harness so the story shows the shell instead of a look-alike.
 */
export function WorkspaceCard({
  anchored = true,
  className,
  children,
}: {
  /** False while the sidebar is hidden: the card then keeps a gutter on its left too. */
  anchored?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <>
      <DocumentStyle name="lody-workspace-frame" css={WORKSPACE_FRAME_CSS} />
      <div
        data-workspace-card
        data-anchored={anchored}
        className={cn(
          'lody-workspace-card flex min-w-0 w-full flex-1 flex-col overflow-hidden',
          stylex.props(styles.card).className,
          className
        )}
      >
        {children}
      </div>
    </>
  );
}
