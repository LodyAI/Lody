import * as stylex from '@stylexjs/stylex';
import { themeFontWeight, themeSpace } from '../../../style/theme-scale.stylex';

/**
 * The illustrated ceremony's own look.
 *
 * The ceremony is deliberately not themed: it is a printed polaroid pile on a
 * desk, so its colours are the printed ones — ink, paper, tape — and they do not
 * follow the app's palette. The Tailwind palette values they came from are
 * written out here as the same expressions, so the print stays the print.
 */
export const ceremonySurface = stylex.create({
  /** The stage the whole composition stands on. */
  stage: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    paddingInline: 'clamp(20px,4vw,56px)',
    paddingBlock: 'clamp(20px,4vh,48px)',
  },
  /** The row that holds the words beside the pile. */
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--gutter)',
  },
  /** The copy's column. */
  copyColumn: {
    display: 'flex',
    flexShrink: 0,
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  /** The fixed slot the sentence is centred in. */
  copySlot: { position: 'relative', width: '100%' },
  /** One copy layer, entering or leaving. */
  copyLayer: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
  },
  /** The headline. */
  headline: {
    whiteSpace: 'pre-line',
    textWrap: 'balance',
    color: 'var(--color-slate-950)',
  },
  /** The headline in the Chinese face. */
  headlineChinese: {
    maxWidth: '11em',
    fontSize: 'clamp(38px,4vw,46px)',
    fontWeight: themeFontWeight.normal,
    lineHeight: 1.18,
    letterSpacing: '-0.015em',
  },
  /** The headline in the Latin face. */
  headlineLatin: {
    maxWidth: '13ch',
    fontSize: 'clamp(40px,4.3vw,60px)',
    fontWeight: themeFontWeight.medium,
    lineHeight: 1.04,
    letterSpacing: '-0.04em',
  },
  /** The sentence under the headline. */
  description: {
    marginTop: themeSpace[5],
    maxWidth: '33ch',
    color: 'var(--color-slate-600)',
  },
  /** The sentence in the Chinese face. */
  descriptionChinese: {
    fontSize: '19px',
    lineHeight: 1.55,
    letterSpacing: '0.01em',
  },
  /** The sentence in the Latin face. */
  descriptionLatin: {
    fontSize: '16px',
    lineHeight: 1.625,
  },
  /** The control anchor under the sentence. */
  controlAnchor: {
    marginTop: 'clamp(18px,2.6vh,32px)',
    display: 'flex',
    alignItems: 'center',
    height: themeSpace[11],
  },
  /** One polaroid in the pile. */
  card: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    margin: 0,
    borderRadius: '8px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab, var(--color-slate-900) 6%, transparent)',
    backgroundColor: 'var(--color-white)',
    padding: 'clamp(9px,0.9vw,14px)',
    paddingBottom: 'clamp(15px,1.7vw,26px)',
  },
  /** The masking tape across the top of a polaroid. */
  tape: {
    position: 'absolute',
    top: '-0.625rem',
    left: '50%',
    height: themeSpace[6],
    width: '38%',
    borderRadius: '2px',
    backgroundColor: 'color-mix(in oklab, #d9e8f2 70%, transparent)',
    boxShadow: '0 1px 2px rgba(15,23,42,.07)',
  },
  /** The photo window of a polaroid. */
  photo: {
    display: 'block',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    borderRadius: '3px',
    backgroundColor: '#fbfbfc',
  },
  /** The illustration inside the photo window. */
  illustration: {
    width: '100%',
    height: '100%',
    userSelect: 'none',
    objectFit: 'contain',
  },
  /** The pile the polaroids stand in. */
  stack: { position: 'relative', flexShrink: 0 },
  /** The "skip" control, tucked into the headline's corner. */
  skip: {
    position: 'absolute',
    right: themeSpace[8],
    top: themeSpace[14],
    zIndex: 10,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'transparent',
    paddingInline: themeSpace[1],
    paddingBlock: themeSpace[1],
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
    fontSize: '10.5px',
    letterSpacing: '0.08em',
    color: 'var(--color-slate-600)',
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  /** The skip control under the pointer. */
  skipHover: {
    '@media (hover: hover)': {
      ':hover': {
        borderBottomColor: 'var(--color-slate-500)',
        color: 'var(--color-slate-950)',
      },
    },
  },
});
