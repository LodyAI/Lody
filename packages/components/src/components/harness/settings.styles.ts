import * as stylex from '@stylexjs/stylex';
import { hx } from './harness.tokens.stylex';

/**
 * The page frame the harness lives in: its tab row, the bar saying which device
 * an edit lands on, a section's heading, and the cards a device is drawn as.
 * Ported from the design source; the pane's own overrides — one column, no side
 * padding, a tab row instead of a sidebar — are stated here as the only layout.
 */
export const settingsStyles = stylex.create({
  page: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: '18px',
    paddingBlockEnd: '40px',
    minWidth: 0,
  },
  /**
   * The strip scrolls as a whole, and the strip itself never clips: the
   * selection pill is absolutely positioned, so a clipping scroller would cut
   * it — and drag the row sideways — whenever the active tab is the last one.
   */
  nav: {
    minWidth: 0,
    overflowX: 'auto',
    scrollbarWidth: 'none',
    '::-webkit-scrollbar': { display: 'none' },
  },
  tabs: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: '1px',
    width: 'max-content',
    minWidth: '100%',
  },
  navItem: {
    position: 'relative',
    // Every tab stands above the travelling pill, as the source states: the
    // pill is painted first, and a tab's glyph and word must not be behind it.
    zIndex: 1,
    height: '32px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '0 10px',
    borderRadius: '8px',
    textAlign: 'start',
    color: hx.muted,
    fontWeight: 500,
    transitionProperty: 'color',
    transitionDuration: '0.15s',
    whiteSpace: 'nowrap',
    ':hover': { color: hx.ink },
  },
  navItemActive: { color: hx.ink },
  /** Everything in a tab rides above the travelling pill. */
  navItemLayer: { position: 'relative' },
  navCount: {
    marginInlineStart: 'auto',
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
    color: hx.faint,
  },

  main: { minWidth: 0 },
  scope: { overflow: 'hidden' },
  scopeInner: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flexWrap: 'wrap',
    marginBlockEnd: '24px',
    padding: '8px 12px 8px 14px',
    borderRadius: '12px',
    backgroundColor: hx.panel,
    boxShadow: `${hx.highlight}, ${hx.raise}`,
  },
  scopeLabel: { fontSize: '12px', fontWeight: 560, color: hx.faint },
  scopeHint: { flex: 1, minWidth: '200px', fontSize: '12px', color: hx.muted },

  section: { display: 'grid', gap: '20px' },
  sectionHead: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: '16px',
  },
  sectionTitle: {
    margin: 0,
    fontSize: '22px',
    fontWeight: 620,
    letterSpacing: '-0.02em',
    color: hx.ink,
  },
  sectionHint: { marginTop: '4px', fontSize: '13px', color: hx.muted },
  sectionHintEmphasis: { fontWeight: 560, color: hx.ink },

  devices: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
    gap: '12px',
  },
  device: {
    display: 'grid',
    alignContent: 'start',
    gap: '4px',
    padding: '16px',
    borderRadius: hx.rLg,
    backgroundColor: hx.panel,
    boxShadow: `${hx.highlight}, ${hx.card}`,
  },
  deviceActive: {
    boxShadow: `${hx.highlight}, 0 0 0 1.5px ${hx.ink}, 0 12px 28px -14px rgb(0 0 0 / 0.25)`,
  },
  deviceTop: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBlockEnd: '10px',
  },
  deviceGlyph: {
    width: '48px',
    height: '48px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: '13px',
    color: hx.ink,
    backgroundImage: `linear-gradient(180deg, ${hx.panel}, ${hx.sunken})`,
    boxShadow: `${hx.highlight}, 0 0 0 1px ${hx.line}, 0 2px 6px -2px rgb(0 0 0 / 0.08)`,
  },
  deviceName: {
    margin: '0 -6px',
    padding: '2px 6px',
    borderWidth: 0,
    borderRadius: '6px',
    fontFamily: 'inherit',
    fontSize: '15px',
    fontWeight: 600,
    color: hx.ink,
    backgroundColor: 'transparent',
    outline: 'none',
    transitionProperty: 'box-shadow, background',
    transitionDuration: '0.15s',
    ':hover': { backgroundColor: hx.hover },
    ':focus': {
      backgroundColor: hx.panel,
      boxShadow: `0 0 0 1px ${hx.accent}, 0 0 0 4px ${hx.accentSoft}`,
    },
  },
  /** The name drawn as a button that enters rename mode. */
  deviceNameButton: {
    textAlign: 'start',
    cursor: 'text',
  },

  deviceMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
    fontSize: '11.5px',
    color: hx.muted,
  },
  deviceMetaDot: { width: '6px', height: '6px', boxShadow: 'none' },
  deviceFacts: {
    display: 'grid',
    gap: '5px',
    marginBlock: '12px 4px',
    paddingBlockStart: '12px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: hx.lineSoft,
  },
  deviceFact: { display: 'flex', justifyContent: 'space-between', fontSize: '12px' },
  deviceFactLabel: { color: hx.faint },
  deviceFactValue: { color: hx.text },
  deviceFoot: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '6px',
    minHeight: '28px',
    marginBlockStart: '6px',
    fontSize: '12px',
    color: hx.muted,
  },
  deviceFootText: { marginInlineEnd: 'auto' },
  deviceAdd: {
    minHeight: '250px',
    placeContent: 'center',
    justifyItems: 'center',
    gap: '6px',
    color: hx.muted,
    backgroundColor: 'transparent',
    boxShadow: 'none',
    outline: `1.5px dashed ${hx.guide}`,
    outlineOffset: '-1.5px',
    transitionProperty: 'background, color',
    transitionDuration: '0.2s',
    ':hover': { color: hx.ink, backgroundColor: hx.hover },
  },
  deviceAddName: { fontWeight: 560 },
  deviceAddHint: { fontSize: '12px', color: hx.faint },
  devicePlus: {
    width: '36px',
    height: '36px',
    marginBlockEnd: '6px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: '10px',
    boxShadow: `inset 0 0 0 1px ${hx.line}`,
  },
});
