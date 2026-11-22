import * as stylex from '@stylexjs/stylex';
import { hx } from './harness.tokens.stylex';

/**
 * The four configuration panels: a group of provider records, the plugin grid,
 * the autonomy cards, the guard chips, the review summary and the small forms
 * that grow inside them. Ported from the design source, values
 * unchanged.
 */
export const panelStyles = stylex.create({
  plugroup: { display: 'grid', gap: '8px' },
  plugroupHead: { display: 'flex', alignItems: 'baseline', gap: '10px' },
  plugroupTitle: { margin: 0, fontSize: '12.5px', fontWeight: 600, color: hx.ink },
  plugroupHint: { fontSize: '12px', color: hx.faint },

  plugs: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' },
  plug: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '11px 12px',
    borderRadius: '11px',
    cursor: 'pointer',
    backgroundColor: hx.panel,
    boxShadow: `0 0 0 1px ${hx.line}`,
    transitionProperty: 'box-shadow, background',
    transitionDuration: '0.2s',
    transitionTimingFunction: hx.ease,
    userSelect: 'none',
    ':hover': { boxShadow: `0 0 0 1px color-mix(in srgb, ${hx.ink} 20%, transparent)` },
  },
  plugOn: {
    backgroundImage: `linear-gradient(180deg, ${hx.panel}, color-mix(in srgb, ${hx.accent} 4%, ${hx.panel}))`,
    boxShadow: `${hx.highlight}, 0 0 0 1px color-mix(in srgb, ${hx.accent} 35%, transparent), 0 2px 6px -2px rgb(59 91 253 / 0.15)`,
  },
  plugText: { display: 'grid', gap: '2px', minWidth: 0 },
  plugName: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 560, color: hx.ink },
  plugBody: { fontSize: '12px', lineHeight: 1.45, color: hx.muted },
  plugSide: { display: 'grid', justifyItems: 'end', alignContent: 'start', gap: '6px' },

  /** A sub-heading inside a panel: "Autonomy", "Always ask before". */
  sub: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBlockEnd: '-6px',
    fontSize: '12.5px',
    fontWeight: 600,
    color: hx.ink,
  },

  /* ── autonomy ────────────────────────────────────────────────────────── */

  auto: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' },
  autoCard: {
    position: 'relative',
    display: 'grid',
    alignContent: 'start',
    gap: '4px',
    padding: '14px',
    borderRadius: '12px',
    textAlign: 'start',
    backgroundColor: hx.panel,
    boxShadow: `0 0 0 1px ${hx.line}`,
    transitionProperty: 'box-shadow',
    transitionDuration: '0.2s',
    transitionTimingFunction: hx.ease,
    ':hover': { boxShadow: `0 0 0 1px color-mix(in srgb, ${hx.ink} 22%, transparent)` },
  },
  autoRing: {
    position: 'absolute',
    inset: 0,
    borderRadius: 'inherit',
    boxShadow: '0 0 0 1.5px hsl(var(--foreground)), 0 8px 18px -10px rgb(0 0 0 / 0.3)',
    pointerEvents: 'none',
  },
  autoName: { fontWeight: 580, color: hx.ink },
  autoBody: { fontSize: '12px', lineHeight: 1.45, color: hx.muted },
  autoExample: { marginBlockStart: '6px', fontSize: '11.5px', color: hx.faint },
  autoGlyph: { display: 'flex', gap: '3px', marginBlockEnd: '10px' },
  autoGate: {
    width: '14px',
    height: '18px',
    borderRadius: '4px',
    backgroundColor: hx.sunken,
    boxShadow: `inset 0 0 0 1.5px ${hx.line}`,
    transitionProperty: 'all',
    transitionDuration: '0.3s',
    transitionTimingFunction: hx.ease,
  },
  autoGateClosedActive: {
    backgroundColor: `color-mix(in srgb, ${hx.warn} 18%, ${hx.panel})`,
    boxShadow: `inset 0 0 0 1.5px color-mix(in srgb, ${hx.warn} 60%, transparent)`,
  },
  autoGateOpen: {
    backgroundColor: hx.ok,
    boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.3)',
  },

  /* ── guard chips ─────────────────────────────────────────────────────── */

  chips: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  chip: {
    height: '30px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    padding: '0 11px 0 8px',
    borderRadius: '9px',
    fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
    fontSize: '12px',
    color: hx.muted,
    backgroundColor: hx.panel,
    boxShadow: `0 0 0 1px ${hx.line}`,
    transitionProperty: 'all',
    transitionDuration: '0.18s',
    transitionTimingFunction: hx.ease,
  },
  chipBox: {
    width: '15px',
    height: '15px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: '4px',
    color: hx.panel,
    boxShadow: `inset 0 0 0 1.5px ${hx.line}`,
    transitionProperty: 'all',
    transitionDuration: '0.18s',
    transitionTimingFunction: hx.ease,
  },

  /* ── review ──────────────────────────────────────────────────────────── */

  summary: { display: 'grid', borderRadius: '12px', boxShadow: `0 0 0 1px ${hx.line}` },
  summaryRow: {
    display: 'grid',
    gridTemplateColumns: '100px 1fr auto',
    alignItems: 'center',
    gap: '12px',
    padding: '11px 14px',
  },
  summaryRowRuled: { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: hx.lineSoft },
  summaryTerm: { fontSize: '12px', color: hx.faint },
  summaryValue: { color: hx.ink, fontWeight: 500 },

  checks: {
    padding: '12px 14px 8px',
    borderRadius: '12px',
    backgroundColor: hx.sunken,
    boxShadow: `inset 0 0 0 1px ${hx.lineSoft}`,
    transitionProperty: 'box-shadow, background',
    transitionDuration: '0.4s',
    transitionTimingFunction: hx.ease,
  },
  checksDone: {
    backgroundColor: `color-mix(in srgb, ${hx.ok} 5%, ${hx.sunken})`,
    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${hx.ok} 25%, transparent)`,
  },
  checksHead: {
    display: 'flex',
    alignItems: 'center',
    gap: '9px',
    paddingBlockEnd: '6px',
    fontWeight: 560,
    color: hx.ink,
  },
  checksOk: {
    width: '18px',
    height: '18px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: '999px',
    color: '#fff',
    backgroundColor: hx.ok,
  },
  checksCount: {
    marginInlineStart: 'auto',
    fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
    fontSize: '11.5px',
    fontWeight: 400,
    color: hx.faint,
  },
  checksList: { margin: 0, padding: 0, listStyle: 'none', display: 'grid' },
  checkRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 0',
    fontSize: '12.5px',
    color: hx.muted,
  },
  checkRowDone: { color: hx.ink },
  checkIcon: {
    width: '16px',
    height: '16px',
    flexShrink: 0,
    display: 'grid',
    placeItems: 'center',
    color: hx.faint,
  },
  checkIconDone: { color: hx.ok },

  /* ── the models an endpoint serves ───────────────────────────────────── */

  provModels: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '4px',
    marginTop: '4px',
  },
  modelChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    height: '20px',
    padding: '0 4px 0 7px',
    borderRadius: '6px',
    fontSize: '11px',
    color: hx.text,
    backgroundColor: hx.sunken,
  },
  modelChipRemove: {
    display: 'grid',
    placeItems: 'center',
    width: '14px',
    height: '14px',
    borderRadius: '4px',
    color: hx.faint,
    ':hover': { color: hx.err, backgroundColor: hx.hover },
  },
  modelAdd: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    height: '20px',
    padding: '0 7px',
    borderRadius: '6px',
    fontSize: '11px',
    color: hx.faint,
    boxShadow: `inset 0 0 0 1px ${hx.line}`,
    ':hover': { color: hx.ink },
  },
  modelInput: {
    height: '20px',
    width: '120px',
    padding: '0 6px',
    borderRadius: '6px',
    fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
    fontSize: '11px',
    color: hx.text,
    backgroundColor: hx.panel,
    boxShadow: `inset 0 0 0 1px ${hx.accent}`,
    outline: 'none',
  },
  /** The window a model offers, beside its name in the picker. */
  modelMeta: { fontSize: '11.5px', color: hx.faint },

  /* ── adding an endpoint inside the group it joins ────────────────────── */

  endpointForm: {
    display: 'grid',
    gap: '12px',
    padding: '14px',
    borderRadius: hx.r,
    backgroundColor: hx.panel,
    boxShadow: `inset 0 0 0 1px ${hx.line}`,
  },
  endpointFields: {
    display: 'grid',
    gap: '10px',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  },
  endpointFoot: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  endpointActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    marginInlineStart: 'auto',
  },
  field: { display: 'grid', gap: '5px' },
  fieldLabel: { fontSize: '11.5px', fontWeight: 500, color: hx.muted },
});
