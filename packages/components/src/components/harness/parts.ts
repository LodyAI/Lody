import * as stylex from '@stylexjs/stylex';
import { hx } from './harness.tokens.stylex';

/**
 * What every harness view draws, ported rule for rule from the design source
 * (`~/dev/ui/app/features/harness/harness.css`): the panel column, a card of
 * ruled rows, a provider record, a tag, a dot, a provider's mark, the segmented
 * track, the override pill and the inline empty state.
 *
 * Two of the source sheet's mechanisms do not survive the move to StyleX, and
 * the difference is stated here rather than hidden:
 *   · `> * + *` rules between siblings are `…Ruled` styles the view applies to
 *     every child but the first, because StyleX has no child combinator.
 *   · `[data-active]`, `[data-status]` and `[data-on]` selectors are variant
 *     styles the view chooses between, for the same reason.
 * Every value is the sheet's own.
 */
export const parts = stylex.create({
  /** A page's blocks, stacked. */
  panel: { display: 'grid', gap: '16px' },

  /** Small print under a group: a lock and one sentence. */
  footnote: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '7px',
    fontSize: '12px',
    color: hx.faint,
  },
  footnoteGlyph: { flex: 'none', marginTop: '2px' },

  error: { marginTop: '6px', fontSize: '12px', color: hx.err },

  /** A group of records: one card, a line between each pair of rows. */
  list: {
    display: 'grid',
    borderRadius: '12px',
    boxShadow: `0 0 0 1px ${hx.line}`,
    overflow: 'hidden',
  },
  /** The rule between two records: longhands, because a shorthand whose colour
   *  is a `color-mix()` loses its width when StyleX expands it. */
  listRuled: { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: hx.lineSoft },

  /** A setting: what it is, and the control that sets it. */
  rows: {
    display: 'grid',
    borderRadius: '12px',
    boxShadow: `0 0 0 1px ${hx.line}`,
    backgroundColor: hx.panel,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '20px',
    padding: '13px 14px',
    minHeight: '58px',
  },
  rowTitle: { display: 'flex', alignItems: 'center', gap: '7px', fontWeight: 540, color: hx.ink },
  rowTitleGlyph: { color: hx.muted },
  rowHint: { marginTop: '1px', fontSize: '12px', color: hx.muted },
  rowControl: { flex: 'none' },

  /** A provider: its mark, what it is and how it is reached, then its one action. */
  prov: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr auto',
    alignItems: 'center',
    columnGap: '12px',
    padding: '12px 12px 12px 14px',
    backgroundColor: hx.panel,
    transitionProperty: 'background',
    transitionDuration: '0.2s',
  },
  provConnected: {
    backgroundImage: `linear-gradient(90deg, ${hx.okSoft}, transparent 45%)`,
  },
  provText: { minWidth: 0 },
  provName: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 560, color: hx.ink },
  provSub: {
    fontSize: '12px',
    color: hx.muted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  provMeta: { fontSize: '11.5px', color: hx.faint },
  provActions: { display: 'flex', alignItems: 'center', gap: '6px' },
  provWait: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '12.5px',
    color: hx.muted,
  },
  provKey: { gridColumn: '2 / -1', overflow: 'hidden' },
  provKeyRow: { display: 'flex', gap: '6px', paddingTop: '10px', margin: '0 1px 1px' },

  /** A group that has nothing in it yet. */
  emptyInline: {
    padding: '22px',
    borderRadius: '12px',
    textAlign: 'center',
    fontSize: '13px',
    color: hx.muted,
    outline: `1.5px dashed ${hx.guide}`,
    outlineOffset: '-1.5px',
  },

  /** A value this device sets differently from the profile, and its reset. */
  override: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: '19px',
    padding: '0 3px 0 7px',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: 520,
    color: hx.accent,
    backgroundColor: hx.accentSoft,
  },
  overrideReset: {
    height: '15px',
    padding: '0 6px',
    borderRadius: '999px',
    fontSize: '10.5px',
    color: hx.accent,
    backgroundColor: hx.panel,
    boxShadow: `0 0 0 1px color-mix(in srgb, ${hx.accent} 30%, transparent)`,
  },

  /** A standing fact about the thing beside it. */
  tag: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    height: '19px',
    padding: '0 7px',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: 500,
    color: hx.muted,
    backgroundColor: hx.sunken,
    boxShadow: `inset 0 0 0 1px ${hx.lineSoft}`,
    whiteSpace: 'nowrap',
  },
  tagOk: {
    color: hx.ok,
    backgroundColor: hx.okSoft,
    boxShadow: 'none',
  },

  /** Reachability as one dot. */
  dot: {
    width: '7px',
    height: '7px',
    flexShrink: 0,
    display: 'inline-block',
    borderRadius: '999px',
    backgroundColor: hx.faint,
  },
  dotOnline: { backgroundColor: hx.ok, boxShadow: `0 0 0 3px ${hx.okSoft}` },
  dotIdle: { backgroundColor: hx.warn },
  dotLive: {
    backgroundColor: hx.ok,
    boxShadow: `0 0 0 3px ${hx.okSoft}`,
    animationName: 'hx-breathe',
    animationDuration: '2s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-in-out',
  },

  /** A provider's mark: the product's glyph, or its initial on its own tint. */
  mark: {
    flexShrink: 0,
    display: 'inline-grid',
    placeItems: 'center',
    borderRadius: '28%',
    fontWeight: 650,
    color: '#fff',
    backgroundImage: `linear-gradient(180deg, color-mix(in srgb, var(--tint) 82%, #fff), var(--tint))`,
    // Every edge is drawn inside the box: a mark sits flush against clip edges,
    // and an outer ring loses its left pixel there.
    boxShadow: `inset 0 1px 0 rgb(255 255 255 / 0.3), inset 0 -1px 0 rgb(0 0 0 / 0.1), inset 0 0 0 1px color-mix(in srgb, var(--tint) 70%, #000)`,
    letterSpacing: '-0.02em',
  },
  markGlyph: { width: '58%', height: '58%' },
  glyph: { flexShrink: 0 },
  glyphFill: { fill: 'color-mix(in srgb, currentColor 8%, transparent)' },

  /** One answer out of a few: a sunken track with a thumb that travels. */
  seg: {
    // The thumb is measured against this track, so the track is its containing
    // block; without it the thumb lands on whatever ancestor is positioned.
    position: 'relative',
    display: 'inline-flex',
    padding: '2px',
    gap: '1px',
    borderRadius: '9px',
    backgroundColor: hx.sunken,
    boxShadow: `inset 0 0 0 1px ${hx.lineSoft}, inset 0 1px 2px rgb(0 0 0 / 0.03)`,
  },
  segItem: {
    position: 'relative',
    height: '28px',
    padding: '0 11px',
    borderRadius: '7px',
    color: hx.muted,
    fontWeight: 500,
    transitionProperty: 'color',
    transitionDuration: '0.15s',
    whiteSpace: 'nowrap',
    ':hover': { color: hx.ink },
  },
  segItemSm: { height: '24px', padding: '0 9px', fontSize: '12px' },
  segItemActive: { color: hx.ink },
  segDisabled: { opacity: 0.5 },
  segLabel: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '5px' },

  /** The device switcher's row menu items, and the menu itself. */
  pop: {
    zIndex: 80,
    padding: '5px',
    borderRadius: '12px',
    backgroundColor: hx.panel,
    boxShadow: `${hx.highlight}, ${hx.float}`,
  },
  popLabel: {
    padding: '7px 9px 5px',
    fontSize: '11px',
    fontWeight: 500,
    letterSpacing: '0.01em',
    color: hx.faint,
  },
  popItem: {
    width: '100%',
    minHeight: '32px',
    display: 'flex',
    alignItems: 'center',
    gap: '9px',
    padding: '5px 8px',
    borderRadius: '8px',
    textAlign: 'start',
    color: hx.text,
    transitionProperty: 'background',
    transitionDuration: '0.12s',
    ':hover': { backgroundColor: hx.hover },
  },
  popItemDevice: { minHeight: '42px' },
  popGlyph: {
    position: 'relative',
    width: '28px',
    height: '28px',
    flexShrink: 0,
    display: 'grid',
    placeItems: 'center',
    borderRadius: '8px',
    backgroundColor: hx.sunken,
    color: hx.muted,
    boxShadow: `inset 0 0 0 1px ${hx.lineSoft}`,
  },
  popTwo: { display: 'grid', minWidth: 0, flex: 1 },
  popTwoName: { fontWeight: 520, color: hx.ink },
  popTwoMeta: { fontSize: '11.5px', color: hx.muted },
  popMeta: { marginInlineStart: 'auto', fontSize: '11.5px', color: hx.faint },
  popCheck: { width: '14px', flexShrink: 0, color: hx.ink },
  popPlus: {
    width: '28px',
    height: '22px',
    display: 'grid',
    placeItems: 'center',
    color: hx.muted,
  },
  popSep: { height: '1px', marginBlock: '5px', marginInline: '-5px', backgroundColor: hx.lineSoft },
  popGrow: { flex: 1, minWidth: 0 },

  /** The one layer a group measures and moves: a tab's tint, a control's thumb,
   *  a card's ring. It belongs to the container, so it never inherits an item's
   *  stacking context or clipping box while it travels. */
  pill: {
    position: 'absolute',
    top: 0,
    left: 0,
    zIndex: 0,
    pointerEvents: 'none',
    backgroundColor: hx.hover,
  },
  thumb: {
    position: 'absolute',
    top: 0,
    left: 0,
    zIndex: 0,
    pointerEvents: 'none',
    backgroundColor: hx.panel,
    boxShadow: '0 1px 2px hsl(0 0% 0% / 0.08)',
  },
  ring: {
    position: 'absolute',
    top: 0,
    left: 0,
    zIndex: 2,
    pointerEvents: 'none',
    borderWidth: '1.5px',
    borderStyle: 'solid',
    borderColor: hx.accent,
  },

  /** A small square button that is only a glyph. */
  iconBtn: {
    width: '28px',
    height: '28px',
    flexShrink: 0,
    display: 'inline-grid',
    placeItems: 'center',
    borderRadius: '8px',
    color: hx.muted,
    transitionProperty: 'background, color',
    transitionDuration: '0.15s',
    ':hover': { color: hx.ink, backgroundColor: hx.hover },
  },

  /** An action written as a word, underlined. */
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    color: hx.muted,
    fontSize: '12.5px',
    fontWeight: 500,
    textDecoration: 'underline',
    textDecorationColor: hx.line,
    textUnderlineOffset: '3px',
    cursor: 'pointer',
    transitionProperty: 'color, text-decoration-color',
    transitionDuration: '0.15s',
    ':hover': { color: hx.ink, textDecorationColor: 'currentColor' },
  },
  linkDanger: { ':hover': { color: hx.err } },

  copyIcon: { display: 'grid', placeItems: 'center' },

  /** A field's shell, where the control is not a design-system input. */
  input: {
    width: '100%',
    height: '32px',
    padding: '0 10px',
    borderWidth: 0,
    borderRadius: '8px',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    color: hx.ink,
    backgroundColor: hx.panel,
    boxShadow: `inset 0 1px 2px rgb(0 0 0 / 0.04), 0 0 0 1px ${hx.line}`,
    outline: 'none',
    transitionProperty: 'box-shadow',
    transitionDuration: '0.15s',
    '::placeholder': { color: hx.faint },
    ':focus': { boxShadow: `0 0 0 1px ${hx.accent}, 0 0 0 4px ${hx.accentSoft}` },
  },
  inputMono: {
    fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
    fontSize: '12.5px',
  },

  /** The harness's own prose scale, at the surface's 13px base. */
});
