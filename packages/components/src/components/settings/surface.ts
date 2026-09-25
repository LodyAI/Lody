import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space } from '@lody/ui/tokens/scales.stylex';

/**
 * The materials every settings surface shares, in `@lody/ui`'s own tokens: a
 * settings card is the card rung, a row is a line of it, a form is one surface
 * whose groups are set apart by space. It lives here, as `@lody/ui` keeps a
 * family's shared look in its `surface.ts`, so the section, the catalog lists,
 * the editors and their dialogs cannot each grow their own card.
 *
 * Settings copy is sized in `em`, not in the package's px steps: the settings
 * chrome is `1em` of `--ui-font-size`, the person's font-size tier, and a
 * fixed step here would ignore it.
 */

/** Wider than this, a row lays its label and control side by side. */
const WIDE = '@media (min-width: 640px)';

export const settingsSurface = stylex.create({
  /** A titled group: the heading above, the card of rows below. */
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1.5],
    minWidth: 0,
    fontSize: '1em',
  },
  /**
   * The heading names the group from outside it, so the card holds rows only:
   * a band with a rule under it is a second edge inside the first.
   */
  sectionHeader: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: space[2],
    minHeight: space[6],
    paddingInline: space[4],
  },
  sectionHeading: { flexGrow: 1, minWidth: 0, lineHeight: 1.25 },
  sectionTitle: { margin: 0, fontSize: '0.75em', fontWeight: 400, color: colors.secondaryLabel },
  sectionDescription: { margin: 0, fontSize: '0.8em', color: colors.secondaryLabel },
  sectionAside: {
    minWidth: 0,
    flexShrink: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'end',
    fontSize: '0.8em',
    color: colors.secondaryLabel,
  },
  sectionActions: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: space[1.5] },

  /**
   * The card rung, made a settings card: `@lody/ui`'s Card material without its
   * padding, because its children are rows that run edge to edge.
   */
  card: {
    boxSizing: 'border-box',
    minWidth: 0,
    overflow: 'hidden',
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    borderRadius: radius.large,
    cornerShape: corner.shape,
  },
  /** A group that destroys something marks its card with a destructive hairline. */
  cardDanger: {
    boxShadow: `0 0 0 0.5px color-mix(in oklab, ${colors.destructive} 45%, transparent), ${shadow.card}`,
  },
  /** One line of a card. Every line but the first is ruled from the one above. */
  line: { minWidth: 0 },
  lineRuled: { boxShadow: `inset 0 1px 0 ${colors.separator}` },

  /**
   * A setting: its name and what it does, and the control that sets it. The
   * control column hugs its content and the label column takes the rest —
   * settings render in a panel narrower than the window, so a column sized from
   * a breakpoint would eat the row and push the control past the clipped edge.
   */
  row: {
    display: { default: 'flex', [WIDE]: 'grid' },
    flexDirection: 'column',
    gridTemplateColumns: { default: null, [WIDE]: 'minmax(0, 1fr) auto' },
    alignItems: { default: 'stretch', [WIDE]: 'center' },
    gap: { default: space[2], [WIDE]: space[4] },
    paddingInline: space[4],
    paddingBlock: '10px',
  },
  rowTop: { alignItems: { default: 'stretch', [WIDE]: 'start' } },
  /** Helper copy is capped so it stays readable on a wide panel. */
  rowText: { minWidth: 0 },
  rowTextCapped: { maxWidth: { default: null, [WIDE]: '520px' } },
  rowLabel: { margin: 0, lineHeight: 1.25, color: colors.label },
  rowHelper: { margin: 0, fontSize: '0.8em', lineHeight: 1.25, color: colors.secondaryLabel },
  rowControl: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: { default: 'flex-start', [WIDE]: 'flex-end' },
    gap: space[2],
    minWidth: 0,
    paddingInlineStart: { default: 0, [WIDE]: space[4] },
    fontSize: '1em',
  },
  rowControlTop: { alignSelf: { default: 'auto', [WIDE]: 'start' } },

  /** A row a person can open: the whole line answers the pointer. */
  pressableLine: {
    backgroundColor: {
      default: 'transparent',
      ':hover': `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.label} 4%)`,
    },
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },

  /**
   * A group of an editor: a form is one surface, so a group is set apart by the
   * space above it and its heading, never by a bordered box inside the box.
   */
  formGroup: { display: 'flex', flexDirection: 'column', gap: space[3], paddingTop: space[2] },
  formGroupTitle: { margin: 0, fontSize: '12px', fontWeight: 400, color: colors.secondaryLabel },
  formGroupHint: {
    margin: 0,
    marginTop: '2px',
    fontSize: '11px',
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
  /** A note or a switch inside a form: the region rung, a fill with no edge. */
  formBlock: {
    boxSizing: 'border-box',
    paddingInline: space[3],
    paddingBlock: '10px',
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 3%)`,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },

  /**
   * A row of a list a person moves through — the settings nav, the Projects
   * sources and folders: a sidebar row. No edge; the pointer's fill and the
   * current row's fill are the palette's own `hoverFill` and `selectedFill`.
   * Spread on a `<button>` or a link; it resets what a button brings.
   */
  listRow: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    width: '100%',
    minWidth: 0,
    minHeight: '32px',
    paddingInline: space[2],
    paddingBlock: space[1],
    margin: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: '1em',
    fontWeight: 400,
    lineHeight: 1.25,
    textAlign: 'start',
    textDecoration: 'none',
    cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  listRowSelected: {
    backgroundColor: { default: colors.selectedFill, ':hover': colors.selectedFill },
  },
  /** A list row's glyph: icons at rest are a hint. */
  listRowIcon: {
    display: 'inline-flex',
    flexShrink: 0,
    width: '16px',
    height: '16px',
    color: colors.tertiaryLabel,
  },
  listRowIconSelected: { color: colors.label },
  listRowLabel: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  listRowMeta: {
    flexShrink: 0,
    fontSize: '0.85em',
    color: colors.tertiaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },

  /** Copy standing in for a card's rows: an empty list, a loading line. */
  cardNote: {
    margin: 0,
    paddingInline: space[4],
    paddingBlock: '10px',
    fontSize: '0.8em',
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
  /**
   * The column a settings page lays out in: sections stacked and set apart by
   * space, centred at a reading width once the panel is wide.
   * `settingContainerClass` in `./index.tsx` is this, as a class string.
   */
  container: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    minWidth: 0,
    overflowX: 'hidden',
    paddingInline: { default: space[4], '@media (min-width: 768px)': space[2] },
    paddingBlock: space[2],
    marginInline: { default: null, '@media (min-width: 768px)': 'auto' },
    maxWidth: { default: null, '@media (min-width: 768px)': '896px' },
  },
  /** A settings page: its sections stacked, set apart by space. */
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
    minWidth: 0,
  },
});

const RING = `inset 0 0 0 2px ${colors.accent}`;

/**
 * The catalogs (Agent Roles, MCP servers, providers, shares, prompt shortcuts)
 * and their editors. A catalog is one card per group with its records as ruled
 * rows, the group named from outside the card; an editor is one surface whose
 * groups are set apart by space, with its answers at the end and no rule above
 * them.
 */
export const settingsCatalog = stylex.create({
  /** A catalog page's lead sentence, above its sections. */
  intro: { margin: 0, fontSize: '0.75em', lineHeight: 1.375, color: colors.secondaryLabel },
  /** The heading's name, its count and what is still syncing, on one line. */
  heading: { display: 'flex', flexGrow: 1, alignItems: 'center', gap: space[2], minWidth: 0 },
  count: { fontSize: '0.75em', color: colors.tertiaryLabel, fontVariantNumeric: 'tabular-nums' },
  syncing: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    fontSize: '0.7em',
    color: colors.tertiaryLabel,
  },
  /** Groups of one catalog, stacked and set apart by space. */
  groups: { display: 'flex', flexDirection: 'column', gap: space[4], minWidth: 0 },
  group: { display: 'flex', flexDirection: 'column', gap: space[1.5], minWidth: 0 },
  /** A group's name, above its card: a label, never a bordered pill. */
  groupHeading: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
    margin: 0,
    paddingInline: space[4],
    fontSize: '0.75em',
    fontWeight: 400,
    lineHeight: 1.25,
    color: colors.secondaryLabel,
  },
  groupHeadingLabel: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  statusDot: {
    flexShrink: 0,
    width: '6px',
    height: '6px',
    borderRadius: '9999px',
    backgroundColor: colors.tertiaryLabel,
  },
  statusDotOnline: { backgroundColor: colors.success },
  /** Said to a screen reader and to nobody else. */
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    margin: '-1px',
    padding: 0,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },

  /** One record: the body opens it, the trailing cluster holds its quick actions. */
  row: { display: 'flex', alignItems: 'center', width: '100%', minWidth: 0 },
  /** The record's body as a button: it resets what a button brings. */
  rowMain: {
    boxSizing: 'border-box',
    display: 'flex',
    flexGrow: 1,
    alignItems: 'center',
    gap: '10px',
    minWidth: 0,
    margin: 0,
    paddingInline: space[4],
    paddingBlock: space[2],
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    outline: 'none',
    boxShadow: { default: 'none', ':focus-visible': RING },
    borderRadius: radius.medium,
  },
  /** The record's glyph, on a film of ink rather than a tile with an edge. */
  glyph: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    borderRadius: '6px',
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 5%)`,
    color: colors.secondaryLabel,
    fontSize: '14px',
    lineHeight: 1,
  },
  body: { display: 'flex', flexDirection: 'column', flexGrow: 1, gap: '2px', minWidth: 0 },
  titleLine: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[2],
    rowGap: '2px',
    minWidth: 0,
  },
  name: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.875em',
    lineHeight: 1.25,
    color: colors.label,
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
    fontSize: '0.7em',
    lineHeight: 1.25,
    color: colors.secondaryLabel,
  },
  metaHint: { color: colors.tertiaryLabel },
  metaWarning: { color: colors.warning },
  truncate: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  mono: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
  actions: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[1],
    paddingInlineEnd: space[3],
  },
  /** An empty catalog: a quiet region, no edge and no dashed box. */
  empty: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[3],
    paddingInline: space[6],
    paddingBlock: space[8],
    borderRadius: radius.large,
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 3%)`,
    textAlign: 'center',
  },
  emptyIcon: { width: '24px', height: '24px', color: colors.tertiaryLabel },
  emptyText: { margin: 0, fontSize: '0.875em', color: colors.secondaryLabel },
  icon: { flexShrink: 0, width: '14px', height: '14px' },
  iconSmall: { flexShrink: 0, width: '12px', height: '12px' },

  /** An editor's body and its answers, filling the dialog under its header. */
  editorForm: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    gap: space[4],
    minHeight: 0,
    minWidth: 0,
  },
  /**
   * The scrolling stack of groups. It reaches a little past the panel's padding
   * and gives it back, so a field's focus ring at the edge is not clipped.
   */
  editorBody: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    gap: space[3],
    minHeight: 0,
    overflowY: 'auto',
    marginInline: `calc(-1 * ${space[1]})`,
    marginBlock: `calc(-1 * ${space[1]})`,
    paddingInline: space[1],
    paddingBlock: space[1],
  },
  /** A label and the message under it: one block. */
  stack: { display: 'flex', flexDirection: 'column', gap: space[1.5], minWidth: 0 },
  /** Two fields side by side once the panel is wide enough. */
  fieldPair: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      '@media (min-width: 640px)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: space[3],
  },
  /** A switch in a `formBlock`: what it does on the left, the switch on the right. */
  blockRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[4],
  },
  blockText: { minWidth: 0 },
  blockTitle: { margin: 0, fontSize: '14px', lineHeight: 1.375, color: colors.label },
  blockHint: {
    margin: 0,
    marginTop: '2px',
    fontSize: '11px',
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
});

/**
 * The size of a settings editor dialog (MCP server, Agent Role, Prompt
 * Shortcut). Layout only, and a Tailwind class on purpose: the panel states its
 * own width in StyleX, and a second StyleX width on the same element is ordered
 * by the stylesheet, while utilities sit in a later layer and win.
 */
export const SETTINGS_EDITOR_DIALOG_LAYOUT = 'w-[620px] max-h-[min(680px,88dvh)]';
