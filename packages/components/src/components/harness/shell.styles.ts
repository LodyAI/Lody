import * as stylex from '@stylexjs/stylex';
import { hx } from './harness.tokens.stylex';

/**
 * The shell: the page column the settings pane gives this surface, the device
 * switcher and its menu, the pairing sheet, the confirmation chip and the empty
 * state's guided grid. Ported from the design source; every value is the
 * sheet's.
 */
export const shell = stylex.create({
  /**
   * The pane header puts its title in a 760px column inset by 16px, centred in
   * the pane. The surface takes the same column so the page title and the page
   * itself start on one line.
   */
  surface: {
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: '760px',
    marginInline: 'auto',
    paddingInline: '16px',
    display: 'flex',
    flexDirection: 'column',
    color: hx.text,
    fontFamily: 'var(--font-sans, ui-sans-serif, system-ui, -apple-system, sans-serif)',
    fontSize: '13px',
    lineHeight: 1.45,
    fontFeatureSettings: "'cv11', 'ss01', 'ss03'",
    WebkitFontSmoothing: 'antialiased',
    /**
     * The clip belongs to the padded column, not to the content column inside
     * it: a card's edge is a 1px ring drawn outside its box, and clipping at
     * the content edge cuts that ring off along both sides of every card.
     */
    overflowX: 'clip',
  },
  /** The pane is the scroller; the surface does not scroll inside it. */
  body: { flexGrow: 1, minHeight: 0, overflowY: 'visible' },

  /* ── device switcher ─────────────────────────────────────────────────── */

  switcherWrap: { position: 'relative' },
  switcher: {
    height: '30px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    padding: '0 8px 0 6px',
    borderRadius: '9px',
    backgroundColor: hx.page,
    boxShadow: `inset 0 0 0 1px ${hx.line}`,
    color: hx.ink,
    fontWeight: 500,
    transitionProperty: 'box-shadow, transform',
    transitionDuration: '0.2s, 0.12s',
    transitionTimingFunction: hx.ease,
    ':hover': { boxShadow: `inset 0 0 0 1px ${hx.line}, 0 0 0 3px ${hx.hover}` },
    ':active': { transform: 'scale(0.98)' },
  },
  switcherGlyph: {
    position: 'relative',
    width: '20px',
    height: '20px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: '6px',
    backgroundColor: hx.sunken,
    color: hx.muted,
  },
  switcherName: {
    display: 'inline-block',
    maxWidth: '160px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  switcherChev: { color: hx.faint },
  switcherMenu: {
    position: 'absolute',
    insetInlineEnd: 0,
    top: 'calc(100% + 8px)',
    width: '290px',
    transformOrigin: 'top right',
  },
  /** A dot on a glyph's corner: the panel's own fill keeps it readable. */
  dotOnGlyph: {
    position: 'absolute',
    insetInlineEnd: '-2px',
    bottom: '-2px',
    boxShadow: `0 0 0 2px ${hx.panel}`,
  },

  /* ── the confirmation chip ───────────────────────────────────────────── */

  toast: {
    position: 'absolute',
    left: '50%',
    bottom: '24px',
    zIndex: 90,
    translate: '-50% 0',
    display: 'flex',
    alignItems: 'center',
    gap: '9px',
    height: '38px',
    padding: '0 14px 0 10px',
    borderRadius: '12px',
    fontWeight: 500,
    color: hx.page,
    backgroundColor: hx.ink,
    boxShadow: '0 12px 28px -8px hsl(0 0% 0% / 0.4)',
  },
  toastIcon: {
    width: '18px',
    height: '18px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: '999px',
    color: hx.ink,
    backgroundColor: hx.ok,
  },

  /* ── the empty state: pairing is the page ────────────────────────────── */

  empty: {
    position: 'relative',
    minHeight: '100%',
    display: 'flex',
    justifyContent: 'center',
    padding: '56px 0 72px',
  },
  emptyGrid: {
    position: 'absolute',
    inset: 0,
    backgroundImage: `radial-gradient(${hx.guide} 1px, transparent 1px)`,
    backgroundSize: '22px 22px',
    backgroundPosition: 'center top',
    maskImage: 'radial-gradient(ellipse 60% 50% at 50% 22%, #000 0%, transparent 75%)',
    pointerEvents: 'none',
  },
  emptyInner: {
    position: 'relative',
    width: 'min(760px, 100%)',
    display: 'grid',
    gap: '28px',
    justifyItems: 'center',
  },
  emptyCopy: { textAlign: 'center', display: 'grid', gap: '10px', justifyItems: 'center' },
  emptyTitle: {
    margin: 0,
    fontSize: '30px',
    lineHeight: 1.15,
    fontWeight: 620,
    letterSpacing: '-0.025em',
    color: hx.ink,
    textWrap: 'balance',
  },
  emptyLede: {
    margin: 0,
    maxWidth: '520px',
    fontSize: '14.5px',
    lineHeight: 1.55,
    color: hx.muted,
    textWrap: 'pretty',
  },

  /* ── pairing sheet ───────────────────────────────────────────────────── */

  sheet: {
    position: 'fixed',
    inset: 0,
    // Portalled to `body`, so it has to clear the settings overlay.
    zIndex: 120,
    display: 'grid',
    placeItems: 'start center',
    padding: '10vh 20px 20px',
    backgroundColor: 'rgb(10 10 14 / 0.28)',
    backdropFilter: 'blur(3px)',
    overflow: 'auto',
  },
  sheetPanel: {
    width: 'min(780px, 100%)',
    display: 'grid',
    gap: '18px',
    padding: '20px',
    borderRadius: '18px',
    backgroundColor: hx.page,
    boxShadow: `${hx.highlight}, ${hx.float}`,
  },
  sheetHead: { display: 'flex', justifyContent: 'space-between', gap: '16px' },
  sheetTitle: {
    margin: 0,
    fontSize: '17px',
    fontWeight: 600,
    letterSpacing: '-0.01em',
    color: hx.ink,
  },
  sheetLede: { marginTop: '2px', fontSize: '13px', color: hx.muted },

  /** The wizard is a page of the pane, not an overlay. */
  setupPage: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minHeight: '100%',
  },
});
