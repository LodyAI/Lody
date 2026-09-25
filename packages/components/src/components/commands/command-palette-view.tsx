import { useEffect, useState, type ComponentType, type CSSProperties } from 'react';
import { Command as Cmdk } from 'cmdk';
import * as stylex from '@stylexjs/stylex';
import { MessageSquare, Search } from 'lucide-react';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, radius, space } from '@lody/ui/tokens/scales.stylex';
import { Dialog } from '@/ui/dialog';
import { formatKeyParts } from '@/lib/commands';

export type PaletteIcon = ComponentType<{ className?: string; strokeWidth?: number }>;

export type PaletteResult = {
  kind: 'command' | 'session';
  /** cmdk item value — must be unique + stable. */
  key: string;
  title: string;
  subtitle: string | null;
  /** Command keybinding (registry syntax) to show on the right, if any. */
  shortcut: string | null;
  /** Right-aligned trailing text (e.g. a session's compact last-activity time). */
  trailing?: string | null;
  /**
   * What the command does, drawn as a glyph. A command without one gets an
   * empty column rather than a stand-in: a glyph every row shares says nothing.
   */
  icon?: PaletteIcon;
  /** The heading this row sits under. Consecutive rows with one heading form a group. */
  group?: string;
  run: () => void;
};

export type CommandPaletteLabels = {
  placeholder: string;
  empty: string;
  navigate: string;
  select: string;
  close: string;
};

export type CommandPaletteViewProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  results: PaletteResult[];
  labels: CommandPaletteLabels;
};

/**
 * The panel hangs from a fixed top edge instead of being centred, so the input
 * stays put while the list below it grows and shrinks with the query — the
 * reason the old panel had a fixed height and a mostly empty body.
 */
const PANEL_STYLE: CSSProperties = {
  insetBlockStart: '14vh',
  transform: 'translate(-50%, 0)',
  width: 'min(640px, calc(100vw - 32px))',
  maxHeight: 'min(560px, 76vh)',
  padding: 0,
  gap: 0,
  overflow: 'hidden',
  zIndex: 'var(--z-command-palette, 85)',
};

const WASH = (percent: number) => `color-mix(in oklab, transparent, ${colors.label} ${percent}%)`;

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', minHeight: 0, color: colors.label },
  field: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    flexShrink: 0,
    height: '52px',
    paddingInline: space[4],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  fieldIcon: { flexShrink: 0, width: '16px', height: '16px', color: colors.tertiaryLabel },
  input: {
    flexGrow: 1,
    minWidth: 0,
    height: '100%',
    padding: 0,
    borderWidth: 0,
    outlineStyle: 'none',
    // The whole panel is the field; a ring around the input inside it would be a second edge.
    boxShadow: 'none',
    backgroundColor: 'transparent',
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: '15px',
    '::placeholder': { color: colors.tertiaryLabel },
  },
  list: {
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    padding: space[1.5],
    scrollPaddingBlock: space[1.5],
  },
  group: { paddingBlockEnd: space[1] },
  heading: {
    margin: 0,
    paddingInline: space[2],
    paddingBlockStart: space[2],
    paddingBlockEnd: space[1],
    fontSize: '11px',
    fontWeight: 500,
    lineHeight: '16px',
    color: colors.tertiaryLabel,
    userSelect: 'none',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    minWidth: 0,
    height: '36px',
    paddingInline: space[2],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    fontSize: '13.5px',
    color: colors.label,
    cursor: 'default',
    userSelect: 'none',
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
  },
  rowActive: { backgroundColor: WASH(7) },
  glyphSlot: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '18px',
    height: '18px',
    color: colors.secondaryLabel,
  },
  glyphSlotActive: { color: colors.label },
  glyph: { width: '16px', height: '16px' },
  title: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  trailing: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[2],
    maxWidth: '45%',
    fontSize: '12px',
    color: colors.tertiaryLabel,
  },
  subtitle: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  time: { flexShrink: 0, fontVariantNumeric: 'tabular-nums' },
  /** A shortcut is trailing metadata, as in a menu: the keys in text, spaced like caps. */
  keys: {
    display: 'inline-flex',
    gap: '3px',
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '0.02em',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space[2],
    paddingBlock: '36px',
    paddingInline: space[4],
    fontSize: '13px',
    color: colors.secondaryLabel,
  },
  emptyIcon: { width: '20px', height: '20px', color: colors.tertiaryLabel },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: space[4],
    flexShrink: 0,
    height: '34px',
    paddingInline: space[4],
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
    fontSize: '11.5px',
    color: colors.tertiaryLabel,
    userSelect: 'none',
  },
  footerHint: { display: 'inline-flex', alignItems: 'center', gap: '5px' },
  footerKey: { color: colors.secondaryLabel },
  footerEnd: { marginInlineStart: 'auto' },
});

/**
 * Presentational shell for the ⌘K palette. Pure (no atoms/router), so it
 * renders in Storybook with mock results; the container (`command-palette.tsx`)
 * wires the data. With no query the commands are grouped under their category;
 * with one the results are a single list ordered by relevance.
 */
export function CommandPaletteView({
  open,
  onOpenChange,
  query,
  onQueryChange,
  results,
  labels,
}: CommandPaletteViewProps) {
  // cmdk marks the row under the keyboard with a data attribute StyleX cannot
  // select, so the palette holds that value itself and styles the row from it.
  const [active, setActive] = useState(results[0]?.key ?? '');
  useEffect(() => {
    if (!results.some((result) => result.key === active)) setActive(results[0]?.key ?? '');
  }, [results, active]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        closeButton={false}
        noAnimation
        style={PANEL_STYLE}
        backdropClassName="z-[var(--z-command-palette,85)] bg-black/30"
      >
        <Cmdk
          shouldFilter={false}
          loop
          value={active}
          onValueChange={setActive}
          {...stylex.props(styles.root)}
        >
          <div {...stylex.props(styles.field)}>
            <Search {...stylex.props(styles.fieldIcon)} aria-hidden="true" />
            <Cmdk.Input
              value={query}
              onValueChange={onQueryChange}
              placeholder={labels.placeholder}
              {...stylex.props(styles.input)}
            />
          </div>

          <Cmdk.List {...stylex.props(styles.list)}>
            {results.length === 0 ? (
              <div {...stylex.props(styles.empty)}>
                <Search {...stylex.props(styles.emptyIcon)} aria-hidden="true" />
                {labels.empty}
              </div>
            ) : (
              groupRuns(results).map((run) => (
                <div key={run.key} {...stylex.props(run.heading ? styles.group : null)}>
                  {run.heading ? (
                    <p {...stylex.props(styles.heading)} aria-hidden="true">
                      {run.heading}
                    </p>
                  ) : null}
                  {run.results.map((result) => (
                    <ResultRow key={result.key} result={result} active={result.key === active} />
                  ))}
                </div>
              ))
            )}
          </Cmdk.List>

          <footer {...stylex.props(styles.footer)}>
            <span {...stylex.props(styles.footerHint)}>
              <span {...stylex.props(styles.footerKey)}>↑↓</span>
              {labels.navigate}
            </span>
            <span {...stylex.props(styles.footerHint)}>
              <span {...stylex.props(styles.footerKey)}>↵</span>
              {labels.select}
            </span>
            <span {...stylex.props(styles.footerHint, styles.footerEnd)}>
              <span {...stylex.props(styles.footerKey)}>esc</span>
              {labels.close}
            </span>
          </footer>
        </Cmdk>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function ResultRow({ result, active }: { result: PaletteResult; active: boolean }) {
  const Icon = result.kind === 'session' ? MessageSquare : result.icon;
  return (
    <Cmdk.Item
      value={result.key}
      onSelect={result.run}
      {...stylex.props(styles.row, active && styles.rowActive)}
    >
      <span {...stylex.props(styles.glyphSlot, active && styles.glyphSlotActive)}>
        {Icon ? <Icon {...stylex.props(styles.glyph)} strokeWidth={1.75} /> : null}
      </span>
      <span {...stylex.props(styles.title)}>{result.title}</span>
      {result.shortcut ? (
        <span {...stylex.props(styles.trailing)}>
          <span {...stylex.props(styles.keys)}>
            {formatKeyParts(result.shortcut).map((key, index) => (
              <span key={`${key}-${index}`}>{key}</span>
            ))}
          </span>
        </span>
      ) : result.subtitle || result.trailing ? (
        <span {...stylex.props(styles.trailing)}>
          {result.subtitle ? (
            <span {...stylex.props(styles.subtitle)}>{result.subtitle}</span>
          ) : null}
          {result.trailing ? <span {...stylex.props(styles.time)}>{result.trailing}</span> : null}
        </span>
      ) : null}
    </Cmdk.Item>
  );
}

type Run = { key: string; heading: string | undefined; results: PaletteResult[] };

/** Consecutive results that share a heading, in order. */
function groupRuns(results: PaletteResult[]): Run[] {
  const runs: Run[] = [];
  for (const result of results) {
    const last = runs[runs.length - 1];
    if (last && last.heading === result.group) last.results.push(result);
    else runs.push({ key: result.key, heading: result.group, results: [result] });
  }
  return runs;
}
