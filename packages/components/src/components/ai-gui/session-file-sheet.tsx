import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import type { SessionFileKind } from '@/lib/session-file-presentation';

/*
 * The paper a delivered file lies on. It prints no glyph and no text — a glyph
 * made it read as a badge, and the name beside it already says what the file is.
 * What it has instead is a few faint marks of ink, drawn differently per kind of
 * file, so a column of attachments reads as different pages at a glance. The marks
 * are tonal (a step of `label` over the paper), never a hue: colour is reserved
 * for outcomes.
 */

/** The folded corner's side. It follows the type size, like the sheet it cuts. */
const FOLD = `calc(${text.captionSize} * 0.8)`;
const PAPER = `linear-gradient(${colors.raisedBackground}, ${colors.raisedBackground})`;
/* The underside of the fold: paper a shade into shadow, never a new colour. */
const FLAP = `linear-gradient(to bottom left, transparent 50%, color-mix(in srgb, ${colors.raisedBackground}, ${colors.label} 9%) 50%)`;
const INK = `color-mix(in srgb, ${colors.label} 10%, transparent)`;
const INK_STRONG = `color-mix(in srgb, ${colors.label} 18%, transparent)`;

type Art = 'lines' | 'code' | 'data' | 'grid' | 'zip' | 'wave' | 'frame' | 'play';

const ART: Record<SessionFileKind, Art> = {
  text: 'lines',
  document: 'lines',
  binary: 'lines',
  code: 'code',
  data: 'data',
  spreadsheet: 'grid',
  archive: 'zip',
  audio: 'wave',
  image: 'frame',
  video: 'play',
};

/** A line of ink: its width, and how far in it starts. */
type Line = readonly [width: string, indent?: string];

/* The first line of every page stops short of the folded corner. */
const LINES: Record<'lines' | 'code' | 'data', readonly Line[]> = {
  lines: [['50%'], ['100%'], ['100%'], ['100%'], ['55%']],
  code: [['44%'], ['62%', '22%'], ['48%', '22%'], ['70%', '22%'], ['30%']],
  data: [['24%'], ['56%', '22%'], ['44%', '22%'], ['60%', '22%'], ['14%']],
};

const WAVE_HEIGHTS = ['35%', '70%', '100%', '55%', '80%', '40%'] as const;
const ZIP_TEETH = ['-4px', '4px', '-4px', '4px'] as const;

const sheet = stylex.create({
  /* Its top-right corner is not painted at all — the tray shows through the cut,
     whatever tint the tray has taken — and the fold lies in the half of that
     corner square that is left. Painted as three background layers (left column,
     lower-right block, flap) so nothing is clipped and the shadow still follows
     the box. The columns overlap by a pixel to hide the seam fractional sizes
     would open. */
  root: {
    position: 'relative',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    width: `calc(${text.captionSize} * 2.5)`,
    height: `calc(${text.captionSize} * 3.4)`,
    paddingBlock: space[1.5],
    paddingInline: space[1],
    borderRadius: radius.mini,
    cornerShape: corner.shape,
    backgroundImage: `${FLAP}, ${PAPER}, ${PAPER}`,
    backgroundRepeat: 'no-repeat',
    backgroundSize: `${FOLD} ${FOLD}, calc(100% - ${FOLD} + 1px) 100%, ${FOLD} calc(100% - ${FOLD} + 1px)`,
    backgroundPosition: 'right top, left top, right bottom',
    boxShadow: shadow.card,
    transitionProperty: 'transform, box-shadow, opacity',
    transitionDuration: {
      default: duration.regular,
      '@media (prefers-reduced-motion: reduce)': '0ms',
    },
    transitionTimingFunction: ease.standard,
  },
  /* A card that opens something: the sheet lifts a hair and tilts, as if picked
     up. The marker is the card's main button, so hover on the secondary download
     button does not move it. */
  live: {
    transform: {
      default: 'none',
      [stylex.when.ancestor(':hover')]: 'translateY(-1px) rotate(-2deg)',
      [stylex.when.ancestor(':focus-visible')]: 'translateY(-1px) rotate(-2deg)',
    },
    boxShadow: {
      default: shadow.card,
      [stylex.when.ancestor(':hover')]: shadow.raised,
      [stylex.when.ancestor(':focus-visible')]: shadow.raised,
    },
  },
  /* Pending and expired: the file is not here to open, so its sheet recedes. */
  muted: { opacity: 0.55 },

  /* Every art fills the page below the fold, spread over its whole height so the
     page is full at every Appearance size. */
  rows: { display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'space-between' },
  trace: {
    height: '2px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: INK,
  },
  line: (width: string, indent: string) => ({ width, marginInlineStart: indent }),

  /* A spreadsheet: a header row a step stronger than the cells under it. */
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gridTemplateRows: 'repeat(4, 1fr)',
    gap: '2px',
    flexGrow: 1,
    marginBlockStart: space[1],
  },
  cell: { borderRadius: '1px', backgroundColor: INK },
  cellHead: { backgroundColor: INK_STRONG },

  /* An archive: a zipper down the middle, teeth alternating, and its pull. */
  zip: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexGrow: 1,
    marginBlockStart: space[1],
  },
  tooth: { width: '5px', height: '2px', borderRadius: radius.full, backgroundColor: INK },
  shift: (margin: string) => ({ marginInlineStart: margin }),
  pull: { width: '6px', height: '5px', borderRadius: radius.mini, backgroundColor: INK_STRONG },

  /* Audio: a short waveform across the page. */
  wave: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexGrow: 1,
    marginBlockStart: space[1],
  },
  bar: { width: '2px', borderRadius: radius.full, backgroundColor: INK },
  tall: (height: string) => ({ height }),

  /* Image and video: a picture over two captions; video's picture has a play mark. */
  frame: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: '3px',
    flexGrow: 1,
    marginBlockStart: space[1],
  },
  picture: {
    flexGrow: 1,
    display: 'grid',
    placeItems: 'center',
    borderRadius: '2px',
    backgroundColor: INK,
  },
  play: {
    width: 0,
    height: 0,
    borderStyle: 'solid',
    borderTopWidth: '3px',
    borderBottomWidth: '3px',
    borderLeftWidth: '5px',
    borderRightWidth: 0,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: INK_STRONG,
  },
});

function SheetArt({ art }: { art: Art }) {
  switch (art) {
    case 'lines':
    case 'code':
    case 'data':
      return (
        <span {...stylex.props(sheet.rows)}>
          {LINES[art].map(([width, indent], index) => (
            <span key={index} {...stylex.props(sheet.trace, sheet.line(width, indent ?? '0%'))} />
          ))}
        </span>
      );
    case 'grid':
      return (
        <span {...stylex.props(sheet.grid)}>
          {Array.from({ length: 12 }, (_, index) => (
            <span key={index} {...stylex.props(sheet.cell, index < 3 && sheet.cellHead)} />
          ))}
        </span>
      );
    case 'zip':
      return (
        <span {...stylex.props(sheet.zip)}>
          {ZIP_TEETH.map((margin, index) => (
            <span key={index} {...stylex.props(sheet.tooth, sheet.shift(margin))} />
          ))}
          <span {...stylex.props(sheet.pull)} />
        </span>
      );
    case 'wave':
      return (
        <span {...stylex.props(sheet.wave)}>
          {WAVE_HEIGHTS.map((height, index) => (
            <span key={index} {...stylex.props(sheet.bar, sheet.tall(height))} />
          ))}
        </span>
      );
    case 'frame':
    case 'play':
      return (
        <span {...stylex.props(sheet.frame)}>
          <span {...stylex.props(sheet.picture)}>
            {art === 'play' ? <span {...stylex.props(sheet.play)} /> : null}
          </span>
          <span {...stylex.props(sheet.trace, sheet.line('100%', '0%'))} />
          <span {...stylex.props(sheet.trace, sheet.line('55%', '0%'))} />
        </span>
      );
    default: {
      const unreachable: never = art;
      return unreachable;
    }
  }
}

/** The decorative paper of a file card. `live` lifts it with the card's hover. */
export function FileSheet({
  kind,
  live = false,
  muted = false,
}: {
  kind: SessionFileKind;
  live?: boolean;
  muted?: boolean;
}) {
  return (
    <span
      {...stylex.props(sheet.root, live && sheet.live, muted && sheet.muted)}
      aria-hidden="true"
    >
      <SheetArt art={ART[kind]} />
    </span>
  );
}
