import * as stylex from '@stylexjs/stylex';

/**
 * The harness sheet's own ramp, ported from the design source
 * (`~/dev/ui/app/features/harness/harness.css`).
 *
 * Surfaces, ink and lines point at the app's theme variables, so the surface
 * reads as Lody in whatever palette the person picked; layout, density, motion
 * and the material ladder are the design's. Every value here is the source
 * sheet's, unchanged: this file exists so the styles are StyleX rather than a
 * stylesheet, not so the design moves.
 */
export const hx = stylex.defineVars({
  page: 'hsl(var(--background))',
  canvas: 'hsl(var(--card))',
  panel: 'hsl(var(--popover))',
  sunken: 'color-mix(in oklab, hsl(var(--foreground)) 4%, hsl(var(--background)))',
  hover: 'color-mix(in oklab, hsl(var(--foreground)) 5%, transparent)',
  press: 'color-mix(in oklab, hsl(var(--foreground)) 9%, transparent)',

  ink: 'hsl(var(--foreground))',
  text: 'hsl(var(--foreground))',
  muted: 'hsl(var(--muted-foreground))',
  faint: 'color-mix(in oklab, hsl(var(--muted-foreground)) 55%, transparent)',

  line: 'hsl(var(--border))',
  lineSoft: 'color-mix(in oklab, hsl(var(--border)) 55%, transparent)',
  guide: 'hsl(var(--border))',

  accent: 'hsl(var(--primary))',
  accentSoft: 'hsl(var(--primary) / 0.1)',
  ok: 'hsl(var(--status-success))',
  okSoft: 'hsl(var(--status-success) / 0.12)',
  warn: 'hsl(var(--status-warning))',
  err: 'hsl(var(--status-danger))',
  flash: 'hsl(var(--primary) / 0.16)',

  c1: 'hsl(var(--primary))',
  c2: 'hsl(var(--status-info))',
  c3: 'hsl(var(--status-success))',
  c4: 'hsl(var(--status-warning))',

  // The material ladder: a half-pixel edge in ink, then the small drops that
  // lift a control or a card. No full 1px border — that reads as an outlined
  // box beside the product's flat, divided surfaces.
  highlight: '0 0 0 0 transparent',
  raise: '0 0 0 0.5px hsl(var(--foreground) / 0.1), 0 1px 1.5px hsl(0 0% 0% / 0.06)',
  card: '0 0 0 0.5px hsl(var(--foreground) / 0.1), 0 1px 1.5px hsl(0 0% 0% / 0.04), 0 2px 6px -2px hsl(0 0% 0% / 0.04)',
  float:
    '0 0 0 0.5px hsl(var(--foreground) / 0.12), 0 2px 6px hsl(0 0% 0% / 0.12), 0 14px 32px -14px hsl(0 0% 0% / 0.2)',
  /** The product's selected-card ring: accent, never the text ink. */
  selected: '0 0 0 1.5px hsl(var(--primary))',

  rSm: '7px',
  r: '10px',
  rLg: '14px',
  ease: 'cubic-bezier(0.22, 1, 0.36, 1)',

  /** The terminal block's own ink: a command is dark in both palettes. */
  cmdBg: '#0f0f12',
  cmdInk: '#e9e9ee',
  cmdDim: '#6e6e78',
  cmdShadow:
    'inset 0 1px 0 rgb(255 255 255 / 0.06), 0 0 0 1px #000, 0 6px 14px -8px rgb(0 0 0 / 0.5)',

  /** The file's token colours, which the source sheet lists per palette. */
  tkKey: 'hsl(var(--foreground))',
  tkEq: 'color-mix(in oklab, hsl(var(--muted-foreground)) 55%, transparent)',
  tkStr: 'hsl(var(--status-success))',
  tkBool: 'hsl(var(--status-warning))',
});
