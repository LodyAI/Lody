import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/ui/resizable';

const styles = stylex.create({
  group: { height: '100%', minHeight: 0, minWidth: 0 },
  panel: { minWidth: 0, minHeight: 0 },
});

/**
 * Project mode's coordinator start page: the page that starts a coordinator on
 * the left and the project's conversations on the right, split by a draggable
 * divider whose position is remembered. A coordinator's own conversation shows
 * the board inside the session's right side panel instead.
 */
export function ProjectWorkspace({ main, board }: { main: ReactNode; board: ReactNode }) {
  return (
    <ResizablePanelGroup
      direction="horizontal"
      autoSaveId="project-workspace-panels"
      className={stylex.props(styles.group).className}
      data-testid="project-workspace"
    >
      <ResizablePanel id="main" order={1} defaultSize={66} minSize={30}>
        <div className="h-full min-w-0">{main}</div>
      </ResizablePanel>
      <ResizableHandle hitAreaMargins={{ coarse: 15, fine: 12 }} />
      <ResizablePanel
        id="board"
        order={2}
        defaultSize={34}
        minSize={20}
        maxSize={60}
        className={stylex.props(styles.panel).className}
      >
        {board}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
