import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

const TOUCH = '@media (pointer: coarse), (max-width: 600px)';

// Real layout boxes, not overlapping pseudo-element hit areas. Touch actions
// stay on the message's line; the row centers on their 44 px boxes so the
// index, text and actions read as one line instead of a detached button strip.
export const queueSurface = stylex.create({
  row: {
    display: 'flex',
    alignItems: { default: 'flex-start', [TOUCH]: 'center' },
  },
  actions: {
    height: { default: 'calc(0.75rem * 1.375)', [TOUCH]: 'auto' },
    gap: { default: 2, [TOUCH]: 0 },
  },
  pendingActions: { gap: { default: space[1], [TOUCH]: 0 } },
  action: {
    minHeight: { default: null, [TOUCH]: 44 },
    minWidth: { default: null, [TOUCH]: 44 },
  },
  text: { overflowWrap: 'anywhere' },
});
