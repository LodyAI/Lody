import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { colors, shadow } from '../tokens/colors.stylex';
import { corner, radius, space, text } from '../tokens/scales.stylex';
import { ThemeRoot, type ThemeMode } from '../theme/theme';

/** Which palettes a board renders each sample in. */
export type GalleryPalettes = 'both' | 'light' | 'dark' | 'ambient';

const PALETTE_NAMES: Record<Exclude<ThemeMode, 'system'> | 'system', string> = {
  light: 'Lody Light',
  dark: 'Vesper',
  system: 'Ambient',
};

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/**
 * Reads a resolved value off a rendered node so the board reports what the
 * token actually produces in this palette instead of a copied literal. The
 * read happens once per mount; every sample is mounted under a fixed theme.
 */
export function useMeasured<T extends HTMLElement>(property: string) {
  const ref = useRef<T>(null);
  const [value, setValue] = useState('');
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    setValue(window.getComputedStyle(node).getPropertyValue(property).trim());
  }, [property]);
  return { ref, value };
}

const styles = stylex.create({
  board: {
    boxSizing: 'border-box',
    maxHeight: '100%',
    overflowY: 'auto',
    backgroundColor: colors.background,
    color: colors.label,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    paddingBlock: space[8],
    paddingInline: space[6],
  },
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[8],
    marginInline: 'auto',
    maxWidth: '1120px',
  },
  header: { display: 'flex', flexDirection: 'column', gap: space[2] },
  headerTitle: {
    margin: 0,
    fontSize: text.titleSize,
    lineHeight: text.titleLeading,
    fontWeight: 600,
    letterSpacing: text.controlTracking,
  },
  headerLead: {
    margin: 0,
    maxWidth: '68ch',
    color: colors.secondaryLabel,
  },
  section: { display: 'flex', flexDirection: 'column', gap: space[3] },
  sectionHead: { display: 'flex', flexDirection: 'column', gap: space[1] },
  sectionTitle: {
    margin: 0,
    fontSize: text.headlineSize,
    lineHeight: text.headlineLeading,
    fontWeight: 600,
    letterSpacing: text.controlTracking,
  },
  sectionRule: {
    margin: 0,
    maxWidth: '72ch',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  split: {
    display: 'grid',
    gap: space[3],
    gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    boxSizing: 'border-box',
    padding: space[4],
    backgroundColor: colors.elevatedBackground,
    color: colors.label,
    borderRadius: radius.large,
    cornerShape: corner.shape,
    boxShadow: shadow.card,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
  },
  panelName: {
    margin: 0,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    fontWeight: 500,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: colors.tertiaryLabel,
  },
  grid: {
    display: 'grid',
    gap: space[3],
    gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))',
  },
  rows: { display: 'flex', flexDirection: 'column', gap: space[3] },
  row: { display: 'flex', alignItems: 'center', gap: space[3], flexWrap: 'wrap' },
  cluster: { display: 'flex', alignItems: 'center', gap: space[2], flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: space[1.5], minWidth: 0 },
  fieldName: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    overflowWrap: 'anywhere',
  },
  fieldNote: {
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.secondaryLabel,
  },
  measured: {
    fontFamily: MONO,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.tertiaryLabel,
    overflowWrap: 'anywhere',
  },
  legendKey: {
    flexBasis: '168px',
    flexGrow: 0,
    flexShrink: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    color: colors.secondaryLabel,
  },
  swatchChip: {
    height: '46px',
    borderRadius: radius.small,
    cornerShape: corner.shape,
    boxShadow: shadow.raised,
  },
});

export function Board({ children }: { children: ReactNode }) {
  return (
    <div {...stylex.props(styles.board)}>
      <div {...stylex.props(styles.page)}>{children}</div>
    </div>
  );
}

export function BoardHeader({ title, lead }: { title: string; lead: string }) {
  return (
    <header {...stylex.props(styles.header)}>
      <h1 {...stylex.props(styles.headerTitle)}>{title}</h1>
      <p {...stylex.props(styles.headerLead)}>{lead}</p>
    </header>
  );
}

export function Section({
  title,
  rule,
  children,
}: {
  title: string;
  rule: string;
  children: ReactNode;
}) {
  return (
    <section {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h2 {...stylex.props(styles.sectionTitle)}>{title}</h2>
        <p {...stylex.props(styles.sectionRule)}>{rule}</p>
      </div>
      {children}
    </section>
  );
}

function modesFor(palettes: GalleryPalettes): ThemeMode[] {
  if (palettes === 'both') return ['light', 'dark'];
  if (palettes === 'ambient') return ['system'];
  return [palettes];
}

/**
 * Renders the same sample once per selected palette, each under its own forced
 * theme, so a token's two values sit next to each other.
 */
export function PaletteSplit({
  palettes,
  children,
}: {
  palettes: GalleryPalettes;
  children: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.split)}>
      {modesFor(palettes).map((mode) => (
        <ThemeRoot key={mode} mode={mode}>
          <div {...stylex.props(styles.panel)}>
            <p {...stylex.props(styles.panelName)}>{PALETTE_NAMES[mode]}</p>
            {children}
          </div>
        </ThemeRoot>
      ))}
    </div>
  );
}

export function Grid({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.grid)}>{children}</div>;
}

export function Rows({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.rows)}>{children}</div>;
}

export function Row({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.row)}>{children}</div>;
}

export function Cluster({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.cluster)}>{children}</div>;
}

export function LegendKey({ children }: { children: ReactNode }) {
  return <span {...stylex.props(styles.legendKey)}>{children}</span>;
}

export function Field({
  name,
  note,
  measured,
  children,
}: {
  name: string;
  note?: string;
  measured?: string;
  children?: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.field)}>
      {children}
      <span {...stylex.props(styles.fieldName)}>{name}</span>
      {measured ? <span {...stylex.props(styles.measured)}>{measured}</span> : null}
      {note ? <span {...stylex.props(styles.fieldNote)}>{note}</span> : null}
    </div>
  );
}

export const dyn = stylex.create({
  fill: (value: string) => ({ backgroundColor: value }),
  ink: (background: string, foreground: string) => ({
    backgroundColor: background,
    color: foreground,
  }),
  raised: (background: string, box: string) => ({
    backgroundColor: background,
    boxShadow: box,
  }),
  text: (value: string) => ({ color: value }),
  radius: (value: string) => ({ borderRadius: value, cornerShape: corner.shape }),
  height: (value: string) => ({ height: value }),
  width: (value: string) => ({ width: value }),
  type: (size: string, leading: string) => ({ fontSize: size, lineHeight: leading }),
  transition: (value: string) => ({ transitionDuration: value }),
});

/** A colour chip that reports the value the palette resolved it to. */
export function Swatch({ name, value, note }: { name: string; value: string; note: string }) {
  const { ref, value: measured } = useMeasured<HTMLDivElement>('background-color');
  return (
    <Field name={name} note={note} measured={measured}>
      <div ref={ref} {...stylex.props(styles.swatchChip, dyn.fill(value))} />
    </Field>
  );
}
