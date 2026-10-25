import * as stylex from '@stylexjs/stylex';
import { colors } from '../tokens/colors.stylex';
import { corner, duration, focus } from '../tokens/scales.stylex';
import { scrollbar } from './scroll-area.tokens.stylex';

const WEBKIT = '@supports selector(::-webkit-scrollbar)';

/** For native controls whose keyboard/scroll ownership must remain native. */
export const nativeScrollbar = stylex.create({
  appearance: {
    scrollbarWidth: { default: 'thin', [WEBKIT]: 'auto' },
    scrollbarColor: { default: `${scrollbar.thumb} transparent`, [WEBKIT]: 'auto' },
    '::-webkit-scrollbar': { width: scrollbar.size, height: scrollbar.size },
    '::-webkit-scrollbar-track': { backgroundColor: 'transparent' },
    '::-webkit-scrollbar-corner': { backgroundColor: 'transparent' },
    '::-webkit-scrollbar-thumb': {
      borderWidth: scrollbar.inset,
      borderStyle: 'solid',
      borderColor: 'transparent',
      borderRadius: scrollbar.radius,
      backgroundClip: 'content-box',
      backgroundColor: scrollbar.thumb,
    },
    '::-webkit-scrollbar-thumb:hover': { backgroundColor: scrollbar.thumbHover },
    '::-webkit-scrollbar-thumb:active': { backgroundColor: scrollbar.thumbActive },
  },
}).appearance;

export const surface = stylex.create({
  root: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'hidden',
  },
  viewport: {
    width: '100%',
    height: '100%',
    flex: '1 1 auto',
    minHeight: 0,
    borderRadius: 'inherit',
    outlineStyle: 'none',
    boxShadow: {
      default: 'none',
      ':focus-visible': `inset 0 0 0 ${focus.ringWidth} ${colors.accent}`,
    },
  },
  verticalContent: { width: '100%' },
  track: {
    display: 'flex',
    padding: scrollbar.inset,
    boxSizing: 'border-box',
    opacity: 1,
    transitionProperty: 'opacity',
    transitionDuration: duration.fast,
  },
  verticalTrack: { width: scrollbar.size },
  horizontalTrack: { height: scrollbar.size },
  compact: { padding: 0 },
  compactVertical: { width: scrollbar.compactSize },
  compactHorizontal: { height: scrollbar.compactSize },
  hidden: { opacity: 0, pointerEvents: 'none' },
  thumb: {
    width: '100%',
    height: '100%',
    borderRadius: scrollbar.radius,
    cornerShape: corner.round,
    backgroundColor: {
      default: scrollbar.thumb,
      ':hover': scrollbar.thumbHover,
      ':active': scrollbar.thumbActive,
    },
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
  },
});
