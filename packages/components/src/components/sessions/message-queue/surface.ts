import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

const TOUCH = '@media (pointer: coarse), (max-width: 600px)';

// Real layout boxes, not overlapping pseudo-element hit areas. Touch actions
// get their own line so long messages keep the available reading width.
export const queueSurface = stylex.create({
  row: {
    display: { default: 'flex', [TOUCH]: 'grid' },
    gridTemplateColumns: { default: null, [TOUCH]: 'min-content minmax(0, 1fr)' },
  },
  actions: {
    height: { default: 'calc(0.75rem * 1.375)', [TOUCH]: 'auto' },
    gridColumn: { default: null, [TOUCH]: 2 },
    justifyContent: { default: null, [TOUCH]: 'flex-end' },
    flexWrap: { default: null, [TOUCH]: 'wrap' },
    gap: { default: 2, [TOUCH]: space[1] },
  },
  pendingActions: { gap: space[1] },
  action: {
    minHeight: { default: null, [TOUCH]: 44 },
    minWidth: { default: null, [TOUCH]: 44 },
  },
  text: { overflowWrap: 'anywhere' },
});
