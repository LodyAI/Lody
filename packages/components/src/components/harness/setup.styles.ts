import * as stylex from '@stylexjs/stylex';
import { hx } from './harness.tokens.stylex';

/**
 * The first-run wizard as a page of the pane: where you are, the one decision
 * in front of you, and the way on. Ported from the design source; the sheet's
 * three-column layout folds into the pane's one column, which is the layout the
 * source states for a narrow surface.
 */
export const setupStyles = stylex.create({
  setup: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    minWidth: 0,
  },

  /** One row: the step, how far the path has gone, and what this step is. */
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flexWrap: 'wrap',
    minWidth: 0,
  },
  count: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '6px',
    fontSize: '40px',
    fontWeight: 600,
    letterSpacing: '-0.04em',
    lineHeight: 1,
    color: hx.ink,
    fontVariantNumeric: 'tabular-nums',
    overflow: 'hidden',
    paddingBlock: '2px',
  },
  countTotal: {
    fontStyle: 'normal',
    fontSize: '15px',
    fontWeight: 500,
    letterSpacing: 0,
    color: hx.faint,
  },
  /** The path, as one bar per step. */
  segments: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  segment: {
    width: '18px',
    height: '4px',
    borderRadius: '999px',
    backgroundColor: hx.line,
    transitionProperty: 'background',
    transitionDuration: '0.25s',
    transitionTimingFunction: hx.ease,
  },
  segmentReached: { backgroundColor: hx.ink },
  stepname: {
    minWidth: 0,
    fontSize: '12.5px',
    color: hx.muted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  center: { position: 'relative', minWidth: 0 },
  card: {
    position: 'relative',
    borderRadius: hx.rLg,
    backgroundColor: hx.panel,
    boxShadow: `${hx.highlight}, ${hx.card}`,
  },
  /** Four registration marks on the card's corners: a frame, never a border. */
  corner: {
    position: 'absolute',
    width: '7px',
    height: '7px',
    borderRadius: '1.5px',
    backgroundColor: hx.page,
    boxShadow: `inset 0 0 0 1px ${hx.guide}`,
    zIndex: 1,
  },
  cornerTopStart: { top: '-3.5px', insetInlineStart: '-3.5px' },
  cornerTopEnd: { top: '-3.5px', insetInlineEnd: '-3.5px' },
  cornerBottomStart: { bottom: '-3.5px', insetInlineStart: '-3.5px' },
  cornerBottomEnd: { bottom: '-3.5px', insetInlineEnd: '-3.5px' },

  body: { overflow: 'hidden', borderRadius: `${hx.rLg} ${hx.rLg} 0 0` },
  bodyInner: { position: 'relative', padding: '24px 24px 22px' },
  head: { display: 'grid', gap: '5px', marginBlockEnd: '20px' },
  title: {
    margin: 0,
    fontSize: '18px',
    fontWeight: 600,
    letterSpacing: '-0.015em',
    color: hx.ink,
  },
  lede: { margin: 0, fontSize: '13px', color: hx.muted, textWrap: 'pretty' },

  /** The way on stays reachable while the step above it scrolls. */
  foot: {
    position: 'sticky',
    bottom: 0,
    zIndex: 2,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '10px 12px 10px 16px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: hx.lineSoft,
    borderRadius: `0 0 ${hx.rLg} ${hx.rLg}`,
    backgroundColor: hx.sunken,
  },
  footHint: { fontSize: '12.5px', color: hx.faint },
});
