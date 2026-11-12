import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';

const styles = stylex.create({
  root: { display: 'flex', height: '100%', minHeight: 0, minWidth: 0 },
  main: { flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0 },
  board: {
    flexShrink: 0,
    width: 'clamp(300px, 34%, 440px)',
    minHeight: 0,
  },
});

/**
 * Project mode's page: the coordinator conversation (or the page that starts
 * one) on the left, the project's conversations on the right.
 */
export function ProjectWorkspace({ main, board }: { main: ReactNode; board: ReactNode }) {
  return (
    <div {...stylex.props(styles.root)} data-testid="project-workspace">
      <div {...stylex.props(styles.main)}>{main}</div>
      <div {...stylex.props(styles.board)}>{board}</div>
    </div>
  );
}
