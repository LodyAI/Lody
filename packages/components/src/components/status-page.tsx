import { createContext, useContext, useId, type ReactNode } from 'react';
import { ChevronRight, CircleAlert } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { WindowDragStrip } from '@/ui/window-drag-region';
import {
  STATUS_ILLUSTRATION_CSS,
  STATUS_ILLUSTRATIONS,
  type StatusIllustration,
} from '@/lib/status-illustrations';

/**
 * Where a status page stands:
 * - `window`: it is the whole window — the page ground, a drag strip on the
 *   desktop, and its own scroll, since the shell clips `#root`.
 * - `pane`: it fills a panel that already has a ground (a session pane).
 * - `region`: a block inside a surface that is otherwise still working, so it
 *   takes the region rung and the smaller type.
 */
export type StatusPageLayout = 'window' | 'pane' | 'region';

/**
 * `danger` is a failure; `neutral` is a place that is not there. On a page the
 * illustration says which; only a `region`, too small for one, wears the mark.
 */
export type StatusPageTone = 'neutral' | 'danger';

export type { StatusIllustration };

const MONO = 'var(--font-mono, ui-monospace, monospace)';
/** A block inside a surface is the region rung: a fill with no edge. */
const REGION = `color-mix(in oklab, transparent, ${colors.label} 3%)`;

const styles = stylex.create({
  window: {
    boxSizing: 'border-box',
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100dvh',
    overflowY: 'auto',
    // The eye's centre is above the geometric one; a column hung at 50% reads low.
    paddingTop: space[8],
    paddingBottom: '12vh',
    paddingInline: space[6],
    backgroundColor: colors.background,
    color: colors.label,
  },
  pane: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    minHeight: 0,
    overflowY: 'auto',
    padding: space[6],
    color: colors.label,
  },
  region: {
    boxSizing: 'border-box',
    width: '100%',
    padding: space[4],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: REGION,
    color: colors.label,
  },
  /**
   * A page is centred: the drawing, what happened and the answers on one axis,
   * which reads as a pause rather than an alarm. What is verbatim — the error,
   * the details — keeps its start edge inside its own block.
   */
  column: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space[4],
    width: '100%',
    maxWidth: '440px',
    minWidth: 0,
    marginBlock: 'auto',
    textAlign: 'center',
  },
  columnRegion: {
    alignItems: 'stretch',
    maxWidth: 'none',
    gap: space[3],
    marginBlock: 0,
    textAlign: 'start',
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'inherit',
    gap: space[1.5],
    minWidth: 0,
  },
  art: {
    display: 'block',
    marginBottom: space[2],
    lineHeight: 0,
    // The drawing's palette, from the rungs it depicts: a window on the
    // floating rung, its sidebar the region, its bars and marks the grays.
    '--si-surface': colors.raisedBackground,
    '--si-edge': `color-mix(in oklab, transparent, ${colors.label} 10%)`,
    // A shadow on the page ground: the ground itself, a step darker. In the
    // dark palette that step is small, which is how shadows read there.
    '--si-shadow': `color-mix(in oklab, ${colors.background}, black 8%)`,
    '--si-region': colors.secondaryBackground,
    '--si-line': colors.gray4,
    '--si-dot': colors.gray3,
    '--si-accent': colors.accent,
    '--si-on-accent': colors.onAccent,
    '--si-ink': colors.gray2,
  },
  mark: {
    flexShrink: 0,
    width: '16px',
    height: '16px',
    marginBottom: space[1],
    color: colors.destructive,
  },
  title: {
    margin: 0,
    fontSize: text.titleSize,
    lineHeight: text.titleLeading,
    fontWeight: 600,
    letterSpacing: '-0.01em',
    color: colors.label,
    overflowWrap: 'anywhere',
  },
  titleRegion: {
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    letterSpacing: 'normal',
  },
  description: {
    margin: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    color: colors.secondaryLabel,
    overflowWrap: 'anywhere',
  },
  descriptionRegion: { fontSize: text.footnoteSize, lineHeight: text.footnoteLeading },

  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
  },
  actionsRegion: { justifyContent: 'flex-start' },

  code: {
    boxSizing: 'border-box',
    alignSelf: 'stretch',
    minWidth: 0,
    margin: 0,
    paddingInline: space[3],
    paddingBlock: '10px',
    overflow: 'auto',
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: REGION,
    fontFamily: MONO,
    fontSize: text.footnoteSize,
    lineHeight: '18px',
    color: colors.secondaryLabel,
    textAlign: 'start',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    userSelect: 'text',
  },
  codeHeadline: { maxHeight: '144px' },
  /** A short value — an address — sits on the axis as a chip rather than a slab. */
  codeFit: { alignSelf: 'center', maxWidth: '100%', paddingBlock: space[1.5] },
  codeDetails: {
    maxHeight: '40vh',
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.secondaryLabel,
  },
  // Inside a region the block would be the same fill twice; one step darker.
  codeInRegion: { backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 5%)` },

  disclosure: {
    display: 'inline-flex',
    alignItems: 'center',
    alignSelf: 'center',
    gap: space[1],
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    boxShadow: 'none',
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    fontFamily: 'inherit',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    cursor: 'pointer',
    transitionProperty: 'color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  chevron: {
    flexShrink: 0,
    width: '14px',
    height: '14px',
    transform: 'rotate(0deg)',
    transitionProperty: 'transform',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  chevronOpen: { transform: 'rotate(90deg)' },
  disclosureRegion: { alignSelf: 'flex-start', marginInlineStart: '-2px' },
  detailsBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    alignSelf: 'stretch',
    minWidth: 0,
  },

  footnote: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
    overflowWrap: 'anywhere',
  },
});

export type StatusPageProps = {
  layout: StatusPageLayout;
  tone?: StatusPageTone;
  /** The drawing a page opens with. A `region` never draws one. */
  illustration?: StatusIllustration;
  title: ReactNode;
  description?: ReactNode;
  /** `alert` for a failure the person did not ask for; omit for a place that is missing. */
  role?: 'alert' | 'status';
  children?: ReactNode;
};

/** A region lays its parts along the start edge; a page centres them. */
const RegionContext = createContext(false);

/**
 * The one frame every error and not-found screen stands in. No card: a page
 * that has failed is the page, not a panel floating over one. A page opens
 * with a drawing of what happened, says it in words, reassures, and offers the
 * way out; the verbatim error and the details come after, quieter, for whoever
 * needs them. A region is the same statements, compact and without the drawing.
 *
 * `boot-failure.ts` draws the same column without React; keep them alike.
 */
export function StatusPage({
  layout,
  tone = 'neutral',
  illustration,
  title,
  description,
  role,
  children,
}: StatusPageProps) {
  const isRegion = layout === 'region';
  const Heading = layout === 'window' ? 'h1' : 'h2';
  return (
    <div role={role} data-status-page={layout} {...stylex.props(styles[layout])}>
      {layout === 'window' ? <WindowDragStrip position="fixed" /> : null}
      <div {...stylex.props(styles.column, isRegion && styles.columnRegion)}>
        <div {...stylex.props(styles.header)}>
          {illustration && !isRegion ? (
            <>
              <style>{STATUS_ILLUSTRATION_CSS}</style>
              <span
                {...stylex.props(styles.art)}
                // A constant from `status-illustrations.ts`, shared with the
                // pre-React boot screen; nothing here comes from input.
                dangerouslySetInnerHTML={{ __html: STATUS_ILLUSTRATIONS[illustration] }}
              />
            </>
          ) : null}
          {isRegion && tone === 'danger' ? (
            <CircleAlert {...stylex.props(styles.mark)} aria-hidden="true" />
          ) : null}
          <Heading {...stylex.props(styles.title, isRegion && styles.titleRegion)}>{title}</Heading>
          {description ? (
            <p {...stylex.props(styles.description, isRegion && styles.descriptionRegion)}>
              {description}
            </p>
          ) : null}
        </div>
        <RegionContext.Provider value={isRegion}>{children}</RegionContext.Provider>
      </div>
    </div>
  );
}

/** The answers. The first is the one most likely to get the person out. */
export function StatusPageActions({ children }: { children: ReactNode }) {
  const isRegion = useContext(RegionContext);
  return <div {...stylex.props(styles.actions, isRegion && styles.actionsRegion)}>{children}</div>;
}

/**
 * Verbatim text a person may need to read, select or send: the error itself
 * (`headline`), or the diagnostics under it (`details`).
 */
export function StatusPageCode({
  children,
  size = 'headline',
}: {
  children: ReactNode;
  size?: 'headline' | 'details' | 'fit';
}) {
  const isRegion = useContext(RegionContext);
  return (
    <pre
      {...stylex.props(
        styles.code,
        size === 'details' ? styles.codeDetails : styles.codeHeadline,
        size === 'fit' && !isRegion && styles.codeFit,
        isRegion && styles.codeInRegion
      )}
    >
      {children}
    </pre>
  );
}

/** A disclosure for what most people never need to see; the caller owns `open`. */
export function StatusPageDetails({
  label,
  open,
  onOpenChange,
  children,
}: {
  label: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const isRegion = useContext(RegionContext);
  const panelId = useId();
  return (
    <div {...stylex.props(styles.detailsBlock)}>
      <button
        type="button"
        {...stylex.props(styles.disclosure, isRegion && styles.disclosureRegion)}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <ChevronRight
          {...stylex.props(styles.chevron, open && styles.chevronOpen)}
          aria-hidden="true"
        />
        {label}
      </button>
      {open ? <div id={panelId}>{children}</div> : null}
    </div>
  );
}

/** A quiet last line: a hint, a way out, the build a person is on. */
export function StatusPageFootnote({ children }: { children: ReactNode }) {
  return <p {...stylex.props(styles.footnote)}>{children}</p>;
}
