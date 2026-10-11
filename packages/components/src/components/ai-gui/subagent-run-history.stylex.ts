import * as stylex from '@stylexjs/stylex';
import { conversation } from './conversation.tokens.stylex';

export const styles = stylex.create({
  list: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  row: { minWidth: 0 },
  prose: { paddingTop: conversation.proseGap },
  surface: { paddingTop: conversation.surfaceGap },
  first: { paddingTop: 0 },
  thoughtLabel: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },
});
