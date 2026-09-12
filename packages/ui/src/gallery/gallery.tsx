import * as stylex from '@stylexjs/stylex';
import { Fragment, type ComponentProps, type ReactNode, type Ref, type RefObject } from 'react';
import { Button } from '../button/button';
import { button } from '../button/button.tokens.stylex';
import { Accordion } from '../disclosure/accordion';
import { Collapsible } from '../disclosure/collapsible';
import { disclosure as disclosureTokens } from '../disclosure/disclosure.tokens.stylex';
import { Tabs, type TabsSize } from '../disclosure/tabs';
import { Checkbox } from '../field/checkbox';
import { AlertDialog } from '../dialog/alert-dialog';
import { Dialog } from '../dialog/dialog';
import { dialog as dialogTokens } from '../dialog/dialog.tokens.stylex';
import { Drawer, type DrawerSide } from '../drawer/drawer';
import { modal } from '../dialog/surface';
import { Combobox } from '../field/combobox';
import { Field } from '../field/field';
import { field } from '../field/field.tokens.stylex';
import {
  ChevronDownGlyph,
  ChevronRightGlyph,
  CrossGlyph as CloseGlyph,
  DotGlyph,
  TickGlyph,
} from '../internal/glyphs';
import { ContextMenu } from '../menu/context-menu';
import { Menu } from '../menu/menu';
import { Menubar } from '../menu/menubar';
import { Input } from '../field/input';
import { Radio, RadioGroup } from '../field/radio';
import { Select } from '../field/select';
import { Switch } from '../field/switch';
import { Textarea } from '../field/textarea';
import { Popover } from '../popover/popover';
import { popup } from '../popup/popup.tokens.stylex';
import { surface } from '../popup/surface';
import { chip } from '../tooltip/chip';
import { Tooltip } from '../tooltip/tooltip';
import { tooltip as tooltipTokens } from '../tooltip/tooltip.tokens.stylex';
import { colors, shadow } from '../tokens/colors.stylex';
import { control, corner, duration, ease, radius, space, text, z } from '../tokens/scales.stylex';
import {
  Board,
  BoardHeader,
  Cluster,
  Grid,
  LegendKey,
  PaletteSplit,
  Row,
  Rows,
  Sample,
  Section,
  Swatch,
  dyn,
  useMeasured,
  type GalleryPalettes,
} from './parts';

export type { GalleryPalettes };

export interface UiGalleryProps {
  /** Which palettes every sample is rendered in. Defaults to both. */
  palettes?: GalleryPalettes;
}

const styles = stylex.create({
  stage: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: space[3],
    boxSizing: 'border-box',
    padding: space[4],
    backgroundColor: colors.secondaryBackground,
    borderRadius: radius.large,
    cornerShape: corner.shape,
  },
  rung: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
    justifyContent: 'center',
    boxSizing: 'border-box',
    minWidth: '148px',
    padding: space[3],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },
  rungName: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
  },
  rungUse: {
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.secondaryLabel,
  },
  well: { backgroundColor: colors.wellBackground, boxShadow: shadow.inset },
  page: { backgroundColor: colors.background },
  region: { backgroundColor: colors.secondaryBackground },
  card: { backgroundColor: colors.elevatedBackground, boxShadow: shadow.card },
  floating: { backgroundColor: colors.raisedBackground, boxShadow: shadow.popover },
  modal: { backgroundColor: colors.elevatedBackground, boxShadow: shadow.large },
  textSample: { display: 'flex', flexDirection: 'column', gap: space[1] },
  separatorRow: { display: 'flex', flexDirection: 'column', gap: 0 },
  separatorLine: { height: '1px', backgroundColor: colors.separator },
  separatorText: {
    paddingBlock: space[2],
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
  },
  hoverRow: {
    paddingBlock: space[2],
    paddingInline: space[3],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
  },
  hoverFill: { backgroundColor: colors.hoverFill },
  selectedFill: { backgroundColor: colors.selectedFill },
  overlaySample: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '72px',
    backgroundColor: colors.overlay,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    // The scrim is dark in both palettes, so its own label is not a token.
    color: 'hsl(0 0% 100% / 0.92)',
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
  },
  ring: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: control.medium,
    paddingInline: space[3],
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    outlineStyle: 'solid',
    outlineWidth: '2px',
    outlineOffset: 0,
    fontSize: text.subheadlineSize,
    lineHeight: 1,
  },
  ringAccent: { outlineColor: colors.accent },
  ringDestructive: { outlineColor: colors.destructive },
  shadowChip: {
    height: '64px',
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },
  radiusChip: {
    height: '64px',
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
  },
  controlBar: {
    display: 'flex',
    alignItems: 'center',
    boxSizing: 'border-box',
    minWidth: '96px',
    paddingInline: space[3],
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  spaceBar: {
    height: '24px',
    backgroundColor: colors.gray4,
    borderRadius: radius.mini,
    cornerShape: corner.shape,
  },
  typeSample: {
    margin: 0,
    letterSpacing: text.controlTracking,
  },
  motionChip: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '56px',
    backgroundColor: colors.raisedBackground,
    boxShadow: shadow.raised,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    fontSize: text.captionSize,
    color: colors.secondaryLabel,
    transitionProperty: 'transform, background-color',
    transitionTimingFunction: ease.standard,
    transform: { default: 'none', ':hover': 'translateY(-4px)' },
  },
  constList: {
    display: 'grid',
    gap: space[2],
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    margin: 0,
  },
  constRow: { display: 'flex', gap: space[2], alignItems: 'baseline' },
  constName: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
  },
  constValue: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.tertiaryLabel,
  },
  matrix: {
    display: 'grid',
    gap: space[3],
    gridTemplateColumns: 'auto 1fr',
    alignItems: 'center',
  },
  fieldSlot: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: '200px',
    maxWidth: '340px',
  },
  readout: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.tertiaryLabel,
    overflowWrap: 'anywhere',
  },
  // A board cannot show an open popup without covering the samples under it, so
  // the list is drawn once on a non-interactive stand-in. It composes the very
  // rules Select and Combobox apply — `popup/surface.ts` — rather than copying
  // them, so the board cannot report a list this package no longer draws.
  popupReplica: {
    position: 'static',
    width: '260px',
    maxHeight: 'none',
    minWidth: 0,
    zIndex: 'auto',
  },
  popupList: { overflowY: 'visible' },
  // The menu stand-in keeps `popup.menuWidth` rather than neutralising it the
  // way the list stand-in does: the width floor is the one declaration a menu
  // states for itself, so the board has to be able to read it back.
  menuReplica: { position: 'static', maxHeight: 'none', zIndex: 'auto' },
  // The far end of the rise is invisible by definition, so it is a probe rather
  // than a sample: it carries the real class and reports its transform into the
  // metrics list instead of leaving a blank gap on the board.
  riseProbe: { position: 'absolute', width: '1px', height: '1px', minWidth: 0, padding: 0 },
  replicaCaption: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    flexGrow: 1,
    flexShrink: 1,
    minWidth: '220px',
  },
  scrollArrowGlyph: { display: 'block', width: popup.indicatorSize, height: popup.indicatorSize },
  /** Something to right-click: a context menu attaches to what is already there. */
  contextArea: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    minWidth: '220px',
    height: control.large,
    paddingInline: space[3],
    backgroundColor: colors.secondaryBackground,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    userSelect: 'none',
  },
  // A row is picked, not pressed, so the board shows the two fills side by side
  // rather than asking the reader to hover one.
  replicaRow: { cursor: 'default' },
  // A popover stand-in, for the same reason the list has one: the real popover
  // above it covers whatever the reader was comparing it against. It keeps every
  // declaration the popover states for itself — the panel padding and gap are
  // the two it replaces on the shared surface — and only stops floating.
  popoverReplica: { position: 'static', width: '260px', maxHeight: 'none', zIndex: 'auto' },
  // The dialog stand-in drops what makes the panel own the window — the fixed
  // position, the centring transform and the 512px width, which would overflow
  // this board — and keeps the padding, the radius, the gap and the type, which
  // are what a reader is here to see. `dialog.width`, `dialog.drawerSize` and
  // `dialog.inset` are reported by probes instead, because a panel scaled to fit
  // a board can no longer report its own width.
  dialogReplica: {
    // `relative` rather than `static`: the cross is pinned to the panel's own
    // padding box, so the stand-in has to stay the containing block for it.
    // A positioned box also starts honouring the panel's own insets, and the
    // panel centres itself with `inset-inline-start: 50%`, so all four are
    // cleared here or the stand-in sits half a column to the right of itself.
    position: 'relative',
    insetInlineStart: 'auto',
    insetInlineEnd: 'auto',
    insetBlockStart: 'auto',
    insetBlockEnd: 'auto',
    // Not `width: 100%`: the stand-in is a flex item beside a legend and a
    // caption, and a percentage width resolves against the whole row rather
    // than the room left in it, so the panel ran off the end of the board. A
    // `100%` flex-basis in a wrapping row means "a line of your own", which is
    // what a 512px panel needs in a 340px column.
    width: 'auto',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '100%',
    minWidth: 0,
    maxWidth: 'none',
    maxHeight: 'none',
    transform: 'none',
    zIndex: 'auto',
  },
  // The overlay, at its real colour, over something to see it against.
  overlaySwatch: {
    position: 'relative',
    boxSizing: 'border-box',
    height: '46px',
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: colors.background,
    overflow: 'hidden',
  },
  overlayFill: { position: 'absolute', inset: 0, backgroundColor: dialogTokens.overlay },
  // A dimension a stand-in cannot state — the panel is 512px and this board's
  // columns are 340 — is reported by a probe carrying the token, the way the
  // rise is. It is out of flow and hidden: a probe laid out inside the metrics
  // row is a flex item, so it reports the width the row let it have rather than
  // the width the token declares. Measured in flow, `dialog.width` read back as
  // 167.5px.
  /** A disclosure takes the width of what it is in; the board gives it one. */
  disclosureBlock: { flexGrow: 1, flexShrink: 1, minWidth: '260px' },
  collapsibleBody: {
    margin: 0,
    paddingBlockStart: space[2],
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    color: colors.secondaryLabel,
  },
  widthProbe: {
    position: 'absolute',
    visibility: 'hidden',
    height: '1px',
    pointerEvents: 'none',
  },
  // The tooltip stand-in: the chip alone, with nothing to hover.
  tooltipReplica: { position: 'static', zIndex: 'auto', pointerEvents: 'auto' },
  // Something to point at, so the real tooltips above have an anchor that is not
  // a control with opinions of its own.
  tooltipAnchor: {
    display: 'inline-flex',
    alignItems: 'center',
    boxSizing: 'border-box',
    height: control.small,
    paddingInline: space[2],
    backgroundColor: colors.secondaryBackground,
    borderRadius: radius.small,
    cornerShape: corner.shape,
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    userSelect: 'none',
  },
  // A dialog's body, so the stand-in shows what the panel's gap separates.
  dialogBody: {
    margin: 0,
    color: colors.secondaryLabel,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
  },
  // The cross, as the real panel draws it: a ghost icon button in the corner.
  replicaCloseGlyph: { display: 'block', width: '16px', height: '16px' },
  // A board cannot hold focus while it is read, so each focus ring is drawn once
  // on a non-interactive stand-in built from the same tokens the control uses.
  buttonFocusReplica: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    height: control.medium,
    paddingInline: '12px',
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: button.secondaryBackground,
    boxShadow: `${button.secondaryShadow}, 0 0 0 ${button.ringWidth} ${button.ring}`,
    color: colors.label,
    fontSize: text.subheadlineSize,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
  },
  focusReplica: {
    display: 'flex',
    alignItems: 'center',
    boxSizing: 'border-box',
    height: field.heightMedium,
    paddingInline: field.paddingXMedium,
    backgroundColor: field.background,
    boxShadow: `${field.well}, 0 0 0 ${field.ringWidth} ${field.ring}`,
    borderRadius: field.radiusMedium,
    cornerShape: corner.shape,
    color: field.value,
    fontSize: field.text,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
  },
});

const SURFACES = [
  { name: 'background', value: colors.background, note: 'app ground' },
  { name: 'elevatedBackground', value: colors.elevatedBackground, note: 'card, panel, dialog' },
  { name: 'raisedBackground', value: colors.raisedBackground, note: 'secondary button, menu' },
  { name: 'secondaryBackground', value: colors.secondaryBackground, note: 'sidebar, footer band' },
  { name: 'wellBackground', value: colors.wellBackground, note: 'input, track, switch off' },
];

const CONTENT_COLORS = [
  { name: 'label', value: colors.label, note: 'the thing' },
  { name: 'secondaryLabel', value: colors.secondaryLabel, note: 'about the thing' },
  { name: 'tertiaryLabel', value: colors.tertiaryLabel, note: 'placeholder, hint, icon at rest' },
];

const FILLS = [
  { name: 'hoverFill', value: colors.hoverFill, note: 'pointer over a row' },
  { name: 'selectedFill', value: colors.selectedFill, note: 'current row' },
  { name: 'separator', value: colors.separator, note: 'between rows only' },
  { name: 'overlay', value: colors.overlay, note: 'dialog and drawer backdrop' },
];

const ROLE_COLORS = [
  { name: 'accent', value: colors.accent, note: 'focus, link, live state' },
  { name: 'onAccent', value: colors.onAccent, note: 'content on accent' },
  { name: 'destructive', value: colors.destructive, note: 'destructive fill, invalid ring' },
  { name: 'onDestructive', value: colors.onDestructive, note: 'content on destructive' },
];

const GRAYS = [
  { name: 'gray', value: colors.gray },
  { name: 'gray2', value: colors.gray2 },
  { name: 'gray3', value: colors.gray3 },
  { name: 'gray4', value: colors.gray4 },
  { name: 'gray5', value: colors.gray5 },
  { name: 'gray6', value: colors.gray6 },
];

const RUNGS = [
  { name: 'well', style: styles.well, use: 'input, track, selected item' },
  { name: 'page', style: styles.page, use: 'app ground' },
  { name: 'region', style: styles.region, use: 'sidebar, footer band' },
  { name: 'card', style: styles.card, use: 'card, panel, composer' },
  { name: 'floating', style: styles.floating, use: 'menu, popover, select list' },
  { name: 'modal', style: styles.modal, use: 'dialog, alert dialog, drawer' },
];

const SHADOWS = [
  {
    name: 'shadow.inset',
    box: shadow.inset,
    fill: colors.wellBackground,
    ink: false,
    note: 'wells',
  },
  {
    name: 'shadow.raised',
    box: shadow.raised,
    fill: colors.raisedBackground,
    ink: false,
    note: 'pressable',
  },
  {
    name: 'shadow.inkEdge',
    box: shadow.inkEdge,
    fill: colors.label,
    ink: true,
    note: 'top highlight on ink fills',
  },
  {
    name: 'shadow.card',
    box: shadow.card,
    fill: colors.elevatedBackground,
    ink: false,
    note: 'cards',
  },
  {
    name: 'shadow.medium',
    box: shadow.medium,
    fill: colors.elevatedBackground,
    ink: false,
    note: 'tooltip',
  },
  {
    name: 'shadow.popover',
    box: shadow.popover,
    fill: colors.raisedBackground,
    ink: false,
    note: 'menus and popovers',
  },
  {
    name: 'shadow.large',
    box: shadow.large,
    fill: colors.elevatedBackground,
    ink: false,
    note: 'dialogs and drawers',
  },
];

const RADII = [
  { name: 'radius.mini', value: radius.mini, shape: corner.shape, note: '16px things' },
  {
    name: 'radius.small',
    value: radius.small,
    shape: corner.shape,
    note: '28px controls, tooltips',
  },
  {
    name: 'radius.medium',
    value: radius.medium,
    shape: corner.shape,
    note: '32 and 36px controls',
  },
  { name: 'radius.large', value: radius.large, shape: corner.shape, note: 'surfaces' },
  // A squircle at this radius is a rounded rectangle, so a pill takes the round
  // shape and the board shows the two side by side rather than claiming one.
  {
    name: 'radius.full',
    value: radius.full,
    shape: corner.round,
    note: 'pills; the one round shape',
  },
];

const CONTROL_SIZES = [
  { name: 'control.small', value: control.small, size: 'small' as const },
  { name: 'control.medium', value: control.medium, size: 'medium' as const },
  { name: 'control.large', value: control.large, size: 'large' as const },
];

const TYPE_SCALE = [
  { name: 'caption', size: text.captionSize, leading: text.captionLeading, note: 'measured value' },
  { name: 'footnote', size: text.footnoteSize, leading: text.footnoteLeading, note: 'field label' },
  {
    name: 'subheadline',
    size: text.subheadlineSize,
    leading: text.subheadlineLeading,
    note: 'controls, weight 500',
  },
  { name: 'body', size: text.bodySize, leading: text.bodyLeading, note: 'prose' },
  {
    name: 'headline',
    size: text.headlineSize,
    leading: text.headlineLeading,
    note: 'dialog title',
  },
  { name: 'title', size: text.titleSize, leading: text.titleLeading, note: 'a full page' },
];

const SPACES = [
  { name: 'space.1', value: space[1] },
  { name: 'space.1.5', value: space[1.5] },
  { name: 'space.2', value: space[2] },
  { name: 'space.3', value: space[3] },
  { name: 'space.4', value: space[4] },
  { name: 'space.6', value: space[6] },
  { name: 'space.8', value: space[8] },
];

const CONSTS = [
  { name: 'corner.shape', value: corner.shape },
  { name: 'ease.standard', value: ease.standard },
  { name: 'z.dialogBackdrop', value: z.dialogBackdrop },
  { name: 'z.dialog', value: z.dialog },
  { name: 'z.popover', value: z.popover },
  { name: 'z.tooltip', value: z.tooltip },
  { name: 'z.toast', value: z.toast },
];

const FIELD_COLORS = [
  { name: 'field.background', value: field.background, note: 'the control is a well' },
  { name: 'field.value', value: field.value, note: 'what the person typed' },
  { name: 'field.label', value: field.label, note: 'the field label' },
  { name: 'field.placeholder', value: field.placeholder, note: 'the empty prompt' },
  { name: 'field.hint', value: field.hint, note: 'help under the control' },
  { name: 'field.icon', value: field.icon, note: 'the chevron on a trigger' },
  { name: 'field.error', value: field.error, note: 'the error message' },
  { name: 'field.ring', value: field.ring, note: 'focus' },
  { name: 'field.invalidRing', value: field.invalidRing, note: 'invalid' },
];

const POPUP_COLORS = [
  { name: 'popup.background', value: popup.background, note: 'the floating rung' },
  { name: 'popup.label', value: popup.label, note: 'a row' },
  { name: 'popup.indicator', value: popup.indicator, note: 'the tick on the current row' },
  { name: 'popup.highlight', value: popup.highlight, note: 'where the keyboard or pointer is' },
  { name: 'popup.selected', value: popup.selected, note: 'the row that holds the value' },
  { name: 'popup.groupLabel', value: popup.groupLabel, note: 'a group heading' },
  { name: 'popup.separator', value: popup.separator, note: 'between groups' },
  { name: 'popup.hint', value: popup.hint, note: 'no matches, scroll arrows, a row icon' },
  { name: 'popup.destructive', value: popup.destructive, note: 'a command that destroys' },
  {
    name: 'popup.destructiveHighlight',
    value: popup.destructiveHighlight,
    note: 'the keyboard on one',
  },
];

const DIALOG_COLORS = [
  { name: 'dialog.background', value: dialogTokens.background, note: 'the modal rung' },
  { name: 'dialog.title', value: dialogTokens.title, note: 'the heading, and the panel text' },
  { name: 'dialog.description', value: dialogTokens.description, note: 'the sentence under it' },
];

const TOOLTIP_COLORS = [
  { name: 'tooltip.background', value: tooltipTokens.background, note: 'inverted: the label ink' },
  { name: 'tooltip.label', value: tooltipTokens.label, note: 'the page background, as ink' },
];

const DRAWER_SIDES: DrawerSide[] = ['top', 'end', 'bottom', 'start'];

const STRIP_COLORS = [
  {
    name: 'disclosure.trackBackground',
    value: disclosureTokens.trackBackground,
    note: 'the well the strip sits in',
  },
  {
    name: 'disclosure.indicator',
    value: disclosureTokens.indicator,
    note: 'the one tab raised out of it',
  },
  { name: 'disclosure.tabLabel', value: disclosureTokens.tabLabel, note: 'a tab you are not on' },
  {
    name: 'disclosure.tabActiveLabel',
    value: disclosureTokens.tabActiveLabel,
    note: 'the one you are, and every hover',
  },
  { name: 'disclosure.ring', value: disclosureTokens.ring, note: 'where the keyboard is' },
];

const STACK_COLORS = [
  { name: 'disclosure.label', value: disclosureTokens.label, note: "a row's own text" },
  {
    name: 'disclosure.chevron',
    value: disclosureTokens.chevron,
    note: 'the hint that there is more under it',
  },
  {
    name: 'disclosure.separator',
    value: disclosureTokens.separator,
    note: 'the line to the next row, and nothing else',
  },
];

const STRIP_SIZES: { name: string; size: TabsSize }[] = [
  { name: 'small · 28', size: 'small' },
  { name: 'medium · 32', size: 'medium' },
  { name: 'large · 36', size: 'large' },
];

const SELECT_SIZES = [
  { name: 'small · 28', size: 'small' as const },
  { name: 'medium · 32', size: 'medium' as const },
  { name: 'large · 36', size: 'large' as const },
];

const FRUIT = [
  { value: 'gala', label: 'Gala' },
  { value: 'fuji', label: 'Fuji' },
  { value: 'pink', label: 'Pink Lady' },
];

const LANGUAGES = ['TypeScript', 'Rust', 'Python', 'Ruby'];

const CHOICE_COLORS = [
  { name: 'field.checkedFill', value: field.checkedFill, note: 'a control that holds a value' },
  { name: 'field.checkedMark', value: field.checkedMark, note: 'the tick and the dot on it' },
  { name: 'field.thumb', value: field.thumb, note: 'the switch thumb, on both tracks' },
];

const FIELD_SIZES = [
  { name: 'small · 28', size: 'small' as const },
  { name: 'medium · 32', size: 'medium' as const },
  { name: 'large · 36', size: 'large' as const },
];

const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'destructive', 'link'] as const;
const BUTTON_SIZES = ['mini', 'small', 'medium', 'large'] as const;

/** A stand-in for a caller's glyph on a row that removes something. */
function CrossGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

function ShadowChip({
  name,
  box,
  fill,
  ink,
  note,
}: {
  name: string;
  box: string;
  fill: string;
  ink: boolean;
  note: string;
}) {
  const { ref, value } = useMeasured<HTMLDivElement>('box-shadow');
  return (
    <Sample name={name} note={note} measured={value}>
      <div
        ref={ref}
        {...stylex.props(
          styles.shadowChip,
          dyn.raised(fill, box),
          ink && dyn.ink(fill, colors.background)
        )}
      />
    </Sample>
  );
}

function RadiusChip({
  name,
  value,
  shape,
  note,
}: {
  name: string;
  value: string;
  shape: string;
  note: string;
}) {
  const { ref, value: measured } = useMeasured<HTMLDivElement>('border-radius');
  return (
    <Sample name={name} note={note} measured={measured}>
      <div ref={ref} {...stylex.props(styles.radiusChip, dyn.radius(value, shape))} />
    </Sample>
  );
}

function ControlRow({
  name,
  value,
  size,
}: {
  name: string;
  value: string;
  size: 'small' | 'medium' | 'large';
}) {
  const { ref, value: measured } = useMeasured<HTMLDivElement>('height');
  return (
    <Row>
      <LegendKey>{name}</LegendKey>
      <div ref={ref} {...stylex.props(styles.controlBar, dyn.height(value))}>
        {measured}
      </div>
      <Button size={size} variant="secondary">
        Secondary
      </Button>
      <Button size={size} icon aria-label={`Add at ${size}`}>
        <PlusGlyph />
      </Button>
    </Row>
  );
}

function TypeRow({
  name,
  size,
  leading,
  note,
}: {
  name: string;
  size: string;
  leading: string;
  note: string;
}) {
  const { ref, value } = useMeasured<HTMLParagraphElement>('font-size');
  return (
    <Row>
      <LegendKey>
        {name} · {note}
      </LegendKey>
      <p ref={ref} {...stylex.props(styles.typeSample, dyn.type(size, leading))}>
        Ship the visual system {value ? `· ${value}` : ''}
      </p>
    </Row>
  );
}

function SpaceRow({ name, value }: { name: string; value: string }) {
  const { ref, value: measured } = useMeasured<HTMLDivElement>('width');
  return (
    <Row>
      <LegendKey>{name}</LegendKey>
      <div ref={ref} {...stylex.props(styles.spaceBar, dyn.width(value))} />
      <span {...stylex.props(styles.rungUse)}>{measured}</span>
    </Row>
  );
}

function FieldRow({
  legend,
  readout,
  children,
}: {
  legend: string;
  readout?: string;
  children: ReactNode;
}) {
  return (
    <Row>
      <LegendKey>{legend}</LegendKey>
      <div {...stylex.props(styles.fieldSlot)}>
        {children}
        {readout ? <span {...stylex.props(styles.readout)}>{readout}</span> : null}
      </div>
    </Row>
  );
}

function FieldSizeRow({ name, size }: { name: string; size: 'small' | 'medium' | 'large' }) {
  const { ref, value } = useMeasured<HTMLInputElement>('height');
  return (
    <FieldRow legend={name} readout={value}>
      <Field.Root>
        <Field.Label>Session title</Field.Label>
        <Input ref={ref} size={size} placeholder="Describe the task" />
      </Field.Root>
    </FieldRow>
  );
}

function InvalidFieldRow() {
  const { ref, value } = useMeasured<HTMLInputElement>('box-shadow');
  return (
    <FieldRow legend="invalid" readout={value}>
      <Field.Root invalid>
        <Field.Label>Session title</Field.Label>
        <Input ref={ref} placeholder="Describe the task" />
        <Field.Error match>Enter a title before starting the session.</Field.Error>
      </Field.Root>
    </FieldRow>
  );
}

/** A choice control with the label it belongs to, the way a surface writes it. */
function ChoiceRow({
  legend,
  readout,
  children,
}: {
  legend: string;
  readout?: string;
  children: ReactNode;
}) {
  return (
    <Row>
      <LegendKey>{legend}</LegendKey>
      <Cluster>{children}</Cluster>
      {readout ? <span {...stylex.props(styles.readout)}>{readout}</span> : null}
    </Row>
  );
}

function CheckedInkRow() {
  const { ref, value } = useMeasured<HTMLButtonElement>('box-shadow');
  return (
    <ChoiceRow legend={'checked \u00b7 ink edge'} readout={value}>
      <Field.Label>
        <Checkbox ref={ref} defaultChecked />
        Include diffs
      </Field.Label>
    </ChoiceRow>
  );
}

function SwitchTrackRow() {
  const { ref, value } = useMeasured<HTMLButtonElement>('width');
  return (
    <ChoiceRow legend="switch" readout={value}>
      <Field.Label>
        <Switch ref={ref} />
        Auto review
      </Field.Label>
      <Field.Label>
        <Switch defaultChecked />
        Auto review
      </Field.Label>
    </ChoiceRow>
  );
}

/**
 * A Select, the way a surface writes one. Every state below is the real
 * control; only the open list is a stand-in, because a board cannot show a
 * popup without covering what is under it.
 */
function FruitSelect({
  size = 'medium',
  triggerRef,
  ...rest
}: {
  size?: 'small' | 'medium' | 'large';
  triggerRef?: Ref<HTMLButtonElement>;
} & ComponentProps<typeof Select.Root<string>>) {
  return (
    <Select.Root items={FRUIT} {...rest}>
      <Select.Trigger ref={triggerRef} size={size}>
        <Select.Value placeholder="Pick a fruit" />
      </Select.Trigger>
      <Select.Content>
        {FRUIT.map((item) => (
          <Select.Item key={item.value} value={item.value}>
            {item.label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

function SelectSizeRow({ name, size }: { name: string; size: 'small' | 'medium' | 'large' }) {
  const { ref, value } = useMeasured<HTMLButtonElement>('height');
  return (
    <FieldRow legend={name} readout={value}>
      <Field.Root>
        <Field.Label>Fruit</Field.Label>
        <FruitSelect triggerRef={ref} size={size} />
      </Field.Root>
    </FieldRow>
  );
}

/** One row of the stand-in list, in whichever state the board is showing. */
function ReplicaRow({
  label,
  selected,
  highlighted,
  disabled,
  ticked,
  rowRef,
  tickRef,
}: {
  label: string;
  selected?: boolean;
  highlighted?: boolean;
  disabled?: boolean;
  ticked?: boolean;
  rowRef?: Ref<HTMLDivElement>;
  tickRef?: RefObject<HTMLSpanElement | null>;
}) {
  return (
    <div
      ref={rowRef}
      {...stylex.props(
        surface.item,
        styles.replicaRow,
        selected && surface.itemSelected,
        highlighted && surface.itemHighlighted,
        disabled && surface.itemDisabled
      )}
    >
      <span {...stylex.props(surface.itemText)}>{label}</span>
      <span ref={tickRef} {...stylex.props(surface.indicator)}>
        {ticked ? (
          <span {...stylex.props(surface.indicatorGlyph)}>
            <TickGlyph />
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * The list every Select and Combobox opens, drawn from `popup/surface.ts` on a
 * stand-in so all four row states can be read at once, with the metrics that
 * shape it taken off the rendered parts rather than written down beside them.
 */
function PopupReplica() {
  const surfaceShadow = useMeasured<HTMLDivElement>('box-shadow');
  const surfaceRadius = useMeasured<HTMLDivElement>('border-radius');
  const surfaceInset = useMeasured<HTMLDivElement>('padding-top');
  const surfaceText = useMeasured<HTMLDivElement>('font-size');
  const rowHeight = useMeasured<HTMLDivElement>('min-height');
  const rowRadius = useMeasured<HTMLDivElement>('border-radius');
  const rowPadding = useMeasured<HTMLDivElement>('padding-left');
  const rowGap = useMeasured<HTMLDivElement>('column-gap');
  const tickSize = useMeasured<HTMLSpanElement>('width');
  const headingSize = useMeasured<HTMLDivElement>('font-size');
  const headingLeading = useMeasured<HTMLDivElement>('line-height');
  const arrowHeight = useMeasured<HTMLDivElement>('height');
  const rise = useMeasured<HTMLDivElement>('transform');

  const metrics = [
    { name: 'popup.shadow', value: surfaceShadow.value },
    { name: 'popup.radius', value: surfaceRadius.value },
    { name: 'popup.inset', value: surfaceInset.value },
    { name: 'popup.text', value: surfaceText.value },
    { name: 'popup.itemHeight', value: rowHeight.value },
    { name: 'popup.itemRadius', value: rowRadius.value },
    { name: 'popup.itemPaddingX', value: rowPadding.value },
    { name: 'popup.itemGap', value: rowGap.value },
    { name: 'popup.indicatorSize', value: tickSize.value },
    { name: 'popup.groupLabelSize', value: headingSize.value },
    { name: 'popup.groupLabelLeading', value: headingLeading.value },
    { name: 'popup.scrollArrowHeight', value: arrowHeight.value },
    { name: 'popup.rise', value: rise.value },
  ];

  return (
    <Row>
      <LegendKey>{'list \u00b7 stand-in'}</LegendKey>
      <div
        ref={(node) => {
          surfaceShadow.ref.current = node;
          surfaceRadius.ref.current = node;
          surfaceInset.ref.current = node;
          surfaceText.ref.current = node;
        }}
        {...stylex.props(surface.popup, styles.popupReplica)}
      >
        <div
          ref={(node) => {
            headingSize.ref.current = node;
            headingLeading.ref.current = node;
          }}
          {...stylex.props(surface.groupLabel)}
        >
          Apples
        </div>
        <div {...stylex.props(surface.list, styles.popupList)}>
          <ReplicaRow
            label="Gala"
            selected
            ticked
            rowRef={(node) => {
              rowHeight.ref.current = node;
              rowRadius.ref.current = node;
              rowPadding.ref.current = node;
              rowGap.ref.current = node;
            }}
            tickRef={tickSize.ref}
          />
          <ReplicaRow label="Fuji" highlighted />
          <ReplicaRow label="Pink Lady" />
          <ReplicaRow label="Sold out" disabled />
        </div>
        <div {...stylex.props(surface.separator)} />
        <div {...stylex.props(surface.empty)}>No fruit matches.</div>
        <div ref={arrowHeight.ref} {...stylex.props(surface.scrollArrow)}>
          <span {...stylex.props(styles.scrollArrowGlyph)}>
            <ChevronDownGlyph />
          </span>
        </div>
      </div>
      {/*
        A popup starts and ends 4px below at opacity 0. StyleX cannot express
        `[data-starting-style]`, so the primitives read Base UI's transition
        status in JS and apply this class; the board applies the same class here
        and reports what it resolves to as `popup.rise`.
      */}
      <div
        ref={rise.ref}
        aria-hidden="true"
        {...stylex.props(surface.popup, styles.popupReplica, styles.riseProbe, surface.popupHidden)}
      />
      <div {...stylex.props(styles.replicaCaption)}>
        <span {...stylex.props(styles.rungUse)}>
          Every row state at once, from the rules the real list applies. Open a trigger above and
          the list that appears is this one, in this palette.
        </span>
        <dl {...stylex.props(styles.constList)}>
          {metrics.map((entry) => (
            <div key={entry.name} {...stylex.props(styles.constRow)}>
              <dt {...stylex.props(styles.constName)}>{entry.name}</dt>
              <dd {...stylex.props(styles.constValue)}>{entry.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Row>
  );
}

/** A Combobox with the chevron beside its input, the shape a picker takes. */
function LanguageCombobox({ children, ...rest }: ComponentProps<typeof Combobox.Root<string>>) {
  return (
    <Combobox.Root items={LANGUAGES} {...rest}>
      {children}
      <Combobox.Content empty={<Combobox.Empty>No language matches.</Combobox.Empty>}>
        {(item: string) => (
          <Combobox.Item key={item} value={item}>
            {item}
          </Combobox.Item>
        )}
      </Combobox.Content>
    </Combobox.Root>
  );
}

/** One row of the stand-in menu, in whichever state the board is showing. */
function MenuReplicaRow({
  label,
  icon,
  inset,
  shortcut,
  leading,
  trailing,
  tone,
  highlighted,
  open,
  disabled,
  rowRef,
}: {
  label: string;
  icon?: ReactNode;
  inset?: boolean;
  shortcut?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  tone?: 'destructive';
  highlighted?: boolean;
  open?: boolean;
  disabled?: boolean;
  rowRef?: Ref<HTMLDivElement>;
}) {
  const destructive = tone === 'destructive';
  return (
    <div
      ref={rowRef}
      {...stylex.props(
        surface.item,
        destructive && surface.itemDestructive,
        open && surface.itemOpen,
        highlighted && surface.itemHighlighted,
        highlighted && destructive && surface.itemDestructiveHighlighted,
        disabled && surface.itemDisabled
      )}
    >
      {leading}
      {icon ? (
        <span {...stylex.props(surface.itemIcon, destructive && surface.itemIconInherit)}>
          {icon}
        </span>
      ) : null}
      {inset ? <span aria-hidden="true" {...stylex.props(surface.itemIcon)} /> : null}
      <span {...stylex.props(surface.itemText)}>{label}</span>
      {shortcut ? <span {...stylex.props(surface.itemShortcut)}>{shortcut}</span> : null}
      {trailing}
    </div>
  );
}

/**
 * The menu surface, drawn from `popup/surface.ts` on a stand-in so every row
 * state can be read at once, with the metrics that shape it taken off the
 * rendered parts rather than written down beside them. The real menus above it
 * open over whatever is under them, which a board cannot hold still.
 */
function MenuReplica() {
  const menuWidth = useMeasured<HTMLDivElement>('min-width');
  const shortcutSize = useMeasured<HTMLSpanElement>('font-size');
  const iconBox = useMeasured<HTMLSpanElement>('width');

  const metrics = [
    { name: 'popup.menuWidth', value: menuWidth.value },
    { name: 'the row icon box', value: iconBox.value },
    { name: 'a shortcut', value: shortcutSize.value },
  ];

  return (
    <Row>
      <LegendKey>{'menu \u00b7 stand-in'}</LegendKey>
      <div
        ref={menuWidth.ref}
        {...stylex.props(surface.popup, surface.popupMenu, styles.menuReplica)}
      >
        <div {...stylex.props(surface.groupLabel)}>Session</div>
        <MenuReplicaRow label="New task" icon={<PlusGlyph />} shortcut={'\u2318N'} />
        <MenuReplicaRow
          label="Rename"
          inset
          trailing={
            <span ref={shortcutSize.ref} {...stylex.props(surface.itemShortcut)}>
              {'\u2318\u21a9'}
            </span>
          }
          highlighted
        />
        <MenuReplicaRow
          label="Copy link"
          leading={
            <span ref={iconBox.ref} {...stylex.props(surface.indicator)}>
              <span {...stylex.props(surface.indicatorGlyph)}>
                <TickGlyph />
              </span>
            </span>
          }
        />
        <MenuReplicaRow
          label="Sort by name"
          leading={
            <span {...stylex.props(surface.indicator)}>
              <span {...stylex.props(surface.indicatorGlyph)}>
                <DotGlyph />
              </span>
            </span>
          }
        />
        <MenuReplicaRow
          label="Export"
          inset
          open
          trailing={
            <span {...stylex.props(surface.itemIcon, surface.itemSubmenuGlyph)}>
              <ChevronRightGlyph />
            </span>
          }
        />
        <div {...stylex.props(surface.separator)} />
        <MenuReplicaRow label="Delete" icon={<CrossGlyph />} tone="destructive" />
        <MenuReplicaRow label="Delete" icon={<CrossGlyph />} tone="destructive" highlighted />
        <MenuReplicaRow label="Archive" inset disabled />
      </div>
      <div {...stylex.props(styles.replicaCaption)}>
        <span {...stylex.props(styles.rungUse)}>
          Every row state at once: an icon row, the highlight, a tick, a dot, the row holding an
          open submenu, a destructive command at rest and under the keyboard, and a disabled one.
        </span>
        <dl {...stylex.props(styles.constList)}>
          {metrics.map((entry) => (
            <div key={entry.name} {...stylex.props(styles.constRow)}>
              <dt {...stylex.props(styles.constName)}>{entry.name}</dt>
              <dd {...stylex.props(styles.constValue)}>{entry.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Row>
  );
}

/** A menu a reader can actually open, written the way a surface writes one. */
function SessionMenu() {
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button variant="secondary" />}>Session</Menu.Trigger>
      <Menu.Content>
        <Menu.Group>
          <Menu.GroupLabel>Session</Menu.GroupLabel>
          <Menu.Item icon={<PlusGlyph />} shortcut={'\u2318N'}>
            New task
          </Menu.Item>
          <Menu.Item inset>Rename</Menu.Item>
        </Menu.Group>
        <Menu.CheckboxItem defaultChecked>Notify me when it finishes</Menu.CheckboxItem>
        <Menu.RadioGroup defaultValue="recent">
          <Menu.GroupLabel>Sort by</Menu.GroupLabel>
          <Menu.RadioItem value="recent">Recent</Menu.RadioItem>
          <Menu.RadioItem value="name">Name</Menu.RadioItem>
        </Menu.RadioGroup>
        <Menu.Submenu>
          <Menu.SubmenuTrigger inset>Export</Menu.SubmenuTrigger>
          <Menu.Content>
            <Menu.Item>PDF</Menu.Item>
            <Menu.Item>PNG</Menu.Item>
          </Menu.Content>
        </Menu.Submenu>
        <Menu.Separator />
        <Menu.Item inset disabled>
          Archive
        </Menu.Item>
        <Menu.Item icon={<CrossGlyph />} tone="destructive">
          Delete
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}

/**
 * The popover surface, drawn from `popup/surface.ts` on a stand-in. The real
 * popover above it opens over whatever is under it, which a board cannot hold
 * still, so the two declarations a popover replaces on the shared surface —
 * its padding and its gap — are read back off this one.
 */
function PopoverReplica() {
  const padding = useMeasured<HTMLDivElement>('padding-top');
  const gap = useMeasured<HTMLDivElement>('row-gap');
  const titleSize = useMeasured<HTMLHeadingElement>('font-size');
  const descriptionSize = useMeasured<HTMLParagraphElement>('font-size');

  const metrics = [
    { name: 'popup.panelPadding', value: padding.value },
    { name: 'popup.panelGap', value: gap.value },
    { name: 'the panel title', value: titleSize.value },
    { name: 'popup.description', value: descriptionSize.value },
  ];

  return (
    <Row>
      <LegendKey>{'popover · stand-in'}</LegendKey>
      <div
        ref={(node) => {
          padding.ref.current = node;
          gap.ref.current = node;
        }}
        {...stylex.props(surface.popup, surface.popupPanel, styles.popoverReplica)}
      >
        <div {...stylex.props(surface.panelHeader)}>
          <h3 ref={titleSize.ref} {...stylex.props(surface.panelTitle)}>
            Filter sessions
          </h3>
          <p ref={descriptionSize.ref} {...stylex.props(surface.panelDescription)}>
            Applies to the list under it.
          </p>
        </div>
        <Field.Root>
          <Field.Label>Name contains</Field.Label>
          <Input size="small" placeholder="Search" />
        </Field.Root>
        <Cluster>
          <Button size="small" variant="ghost">
            Reset
          </Button>
          <Button size="small">Apply</Button>
        </Cluster>
      </div>
      <div {...stylex.props(styles.replicaCaption)}>
        <span {...stylex.props(styles.rungUse)}>
          The same surface a Select list and a Menu open, holding content instead of rows. It
          replaces five of a list&apos;s declarations: the width it takes from its control, the 4px
          inset that lets a row reach the surface&apos;s edge, and the three that make its type a
          control&apos;s rather than prose.
        </span>
        <dl {...stylex.props(styles.constList)}>
          {metrics.map((entry) => (
            <div key={entry.name} {...stylex.props(styles.constRow)}>
              <dt {...stylex.props(styles.constName)}>{entry.name}</dt>
              <dd {...stylex.props(styles.constValue)}>{entry.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Row>
  );
}

/** A popover a reader can actually open, written the way a surface writes one. */
function FilterPopover() {
  return (
    <Popover.Root>
      <Popover.Trigger render={<Button variant="secondary" />}>Filter</Popover.Trigger>
      <Popover.Content>
        <Popover.Header>
          <Popover.Title>Filter sessions</Popover.Title>
          <Popover.Description>Applies to the list under it.</Popover.Description>
        </Popover.Header>
        <Field.Root>
          <Field.Label>Name contains</Field.Label>
          <Input size="small" placeholder="Search" />
        </Field.Root>
        <Cluster>
          <Popover.Close render={<Button size="small" variant="ghost" />}>Reset</Popover.Close>
          <Popover.Close render={<Button size="small" />}>Apply</Popover.Close>
        </Cluster>
      </Popover.Content>
    </Popover.Root>
  );
}

/**
 * The modal panel, drawn from `dialog/surface.ts` on a stand-in: a dialog is
 * portalled and unmounted while it is closed, and opening one would cover the
 * board it is meant to be compared against.
 *
 * The stand-in keeps the padding, the radius, the gap and the type — what a
 * reader is here to see — and drops what makes the panel own a window: the
 * fixed position, the centring transform and the 512px width. Those are
 * reported by probes below instead, by a bar as wide as the token, because a
 * panel shrunk to fit a board can no longer state its own width.
 */
function DialogReplica() {
  const padding = useMeasured<HTMLDivElement>('padding-top');
  const gap = useMeasured<HTMLDivElement>('row-gap');
  const panelRadius = useMeasured<HTMLDivElement>('border-radius');
  const panelShadow = useMeasured<HTMLDivElement>('box-shadow');
  const headerGap = useMeasured<HTMLDivElement>('row-gap');
  const titleSize = useMeasured<HTMLHeadingElement>('font-size');
  const titleLeading = useMeasured<HTMLHeadingElement>('line-height');
  const descriptionSize = useMeasured<HTMLParagraphElement>('font-size');
  const descriptionLeading = useMeasured<HTMLParagraphElement>('line-height');
  const footerGap = useMeasured<HTMLDivElement>('column-gap');

  const metrics = [
    { name: 'dialog.shadow', value: panelShadow.value },
    { name: 'dialog.radius', value: panelRadius.value },
    { name: 'dialog.padding', value: padding.value },
    { name: 'dialog.gap', value: gap.value },
    { name: 'dialog.headerGap', value: headerGap.value },
    { name: 'dialog.footerGap', value: footerGap.value },
    { name: 'dialog.titleSize', value: titleSize.value },
    { name: 'dialog.titleLeading', value: titleLeading.value },
    { name: 'dialog.descriptionSize', value: descriptionSize.value },
    { name: 'dialog.descriptionLeading', value: descriptionLeading.value },
  ];

  return (
    <Row>
      <LegendKey>{'dialog · stand-in'}</LegendKey>
      <div
        ref={(node) => {
          padding.ref.current = node;
          gap.ref.current = node;
          panelRadius.ref.current = node;
          panelShadow.ref.current = node;
        }}
        {...stylex.props(modal.popup, styles.dialogReplica)}
      >
        <div ref={headerGap.ref} {...stylex.props(modal.header)}>
          <h3
            ref={(node) => {
              titleSize.ref.current = node;
              titleLeading.ref.current = node;
            }}
            {...stylex.props(modal.title)}
          >
            Delete this session?
          </h3>
          <p
            ref={(node) => {
              descriptionSize.ref.current = node;
              descriptionLeading.ref.current = node;
            }}
            {...stylex.props(modal.description)}
          >
            Its transcript and every file it wrote go with it.
          </p>
        </div>
        <p {...stylex.props(styles.dialogBody)}>
          The body is whatever the surface writes; the panel states only the room around it.
        </p>
        <div ref={footerGap.ref} {...stylex.props(modal.footer)}>
          <Button variant="secondary" size="small">
            Keep
          </Button>
          <Button variant="destructive" size="small">
            Delete
          </Button>
        </div>
        <Button variant="ghost" size="small" icon aria-label="Close" {...stylex.props(modal.close)}>
          <span {...stylex.props(styles.replicaCloseGlyph)}>
            <CloseGlyph />
          </span>
        </Button>
      </div>
      <div {...stylex.props(styles.replicaCaption)}>
        <span {...stylex.props(styles.rungUse)}>
          The modal rung states three things at once: the elevated background, the large shadow, and
          an overlay over the page. A Dialog, an AlertDialog and a Drawer are this one panel — they
          differ in how they arrive and in what may dismiss them, not in what they are made of.
        </span>
        <dl {...stylex.props(styles.constList)}>
          {metrics.map((entry) => (
            <div key={entry.name} {...stylex.props(styles.constRow)}>
              <dt {...stylex.props(styles.constName)}>{entry.name}</dt>
              <dd {...stylex.props(styles.constValue)}>{entry.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Row>
  );
}

/** A dimension has no appearance, so a bar as wide as it reports what it is. */
function WidthProbeRow({ name, value }: { name: string; value: string }) {
  const { ref, value: measured } = useMeasured<HTMLDivElement>('width');
  return (
    <div {...stylex.props(styles.constRow)}>
      <dt {...stylex.props(styles.constName)}>{name}</dt>
      <dd {...stylex.props(styles.constValue)}>{measured}</dd>
      <div ref={ref} aria-hidden="true" {...stylex.props(styles.widthProbe, dyn.width(value))} />
    </div>
  );
}

/** The dimensions a stand-in cannot state, because stating them hides the board. */
function ModalDimensions() {
  const dimensions = [
    { name: 'dialog.width', value: dialogTokens.width },
    { name: 'dialog.drawerSize', value: dialogTokens.drawerSize },
    { name: 'dialog.drawerInset', value: dialogTokens.drawerInset },
    { name: 'dialog.inset', value: dialogTokens.inset },
    { name: 'dialog.rise', value: dialogTokens.rise },
  ];
  return (
    <Row>
      <LegendKey>dimensions</LegendKey>
      <div {...stylex.props(styles.replicaCaption)}>
        <dl {...stylex.props(styles.constList)}>
          {dimensions.map((entry) => (
            <WidthProbeRow key={entry.name} {...entry} />
          ))}
        </dl>
      </div>
    </Row>
  );
}

/**
 * A drawer on one edge, flush or inset.
 *
 * A drawer arrives from somewhere, so the edge it came in on is one axis and
 * all four belong on the board: each is laid out against a different side and
 * swiped away in a different direction. Whether it meets that edge or floats
 * off it is the second axis, and it changes the corners as well as the gap.
 */
function FilterDrawer({ side, inset }: { side: DrawerSide; inset?: boolean }) {
  return (
    <Drawer.Root side={side}>
      <Drawer.Trigger render={<Button variant="secondary" size="small" />}>
        {inset ? `${side} · inset` : side}
      </Drawer.Trigger>
      <Drawer.Content side={side} inset={inset}>
        <Drawer.Header>
          <Drawer.Title>Filters</Drawer.Title>
          <Drawer.Description>They apply to the session list.</Drawer.Description>
        </Drawer.Header>
        <Field.Label>
          <Checkbox name="running" defaultChecked />
          Running only
        </Field.Label>
        <Drawer.Footer>
          <Drawer.Close render={<Button variant="secondary" size="small" />}>Reset</Drawer.Close>
          <Drawer.Close render={<Button size="small" />}>Apply</Drawer.Close>
        </Drawer.Footer>
      </Drawer.Content>
    </Drawer.Root>
  );
}

/** The three ways onto the modal rung, each one a reader can actually open. */
function ModalTriggers() {
  return (
    <Rows>
      <Row>
        <LegendKey>dialog</LegendKey>
        <Cluster>
          <Dialog.Root>
            <Dialog.Trigger render={<Button variant="secondary" />}>Rename session</Dialog.Trigger>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Rename session</Dialog.Title>
                <Dialog.Description>The name shows in the sidebar.</Dialog.Description>
              </Dialog.Header>
              <Field.Root>
                <Field.Label>Name</Field.Label>
                <Input placeholder="Describe the task" />
              </Field.Root>
              <Dialog.Footer>
                <Dialog.Close render={<Button variant="secondary" />}>Cancel</Dialog.Close>
                <Dialog.Close render={<Button />}>Save</Dialog.Close>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Root>
        </Cluster>
      </Row>
      <Row>
        <LegendKey>alert dialog</LegendKey>
        <Cluster>
          <AlertDialog.Root>
            <AlertDialog.Trigger render={<Button variant="secondary" tone="destructive" />}>
              Delete session
            </AlertDialog.Trigger>
            <AlertDialog.Content>
              <AlertDialog.Header>
                <AlertDialog.Title>Delete this session?</AlertDialog.Title>
                <AlertDialog.Description>
                  Its transcript and every file it wrote go with it.
                </AlertDialog.Description>
              </AlertDialog.Header>
              <AlertDialog.Footer>
                <AlertDialog.Close render={<Button variant="secondary" />}>Keep</AlertDialog.Close>
                <AlertDialog.Close render={<Button variant="destructive" />}>
                  Delete
                </AlertDialog.Close>
              </AlertDialog.Footer>
            </AlertDialog.Content>
          </AlertDialog.Root>
        </Cluster>
      </Row>
      <Row>
        <LegendKey>drawer · flush</LegendKey>
        <Cluster>
          {DRAWER_SIDES.map((side) => (
            <FilterDrawer key={side} side={side} />
          ))}
        </Cluster>
      </Row>
      <Row>
        <LegendKey>drawer · inset</LegendKey>
        <Cluster>
          {DRAWER_SIDES.map((side) => (
            <FilterDrawer key={side} side={side} inset />
          ))}
        </Cluster>
      </Row>
    </Rows>
  );
}

/**
 * The tooltip chip, drawn on a stand-in. A tooltip is portalled, unmounted
 * while it is closed and opens on a delay, so the board shows the chip itself
 * beside triggers a reader can point at.
 */
function TooltipReplica() {
  const chipRadius = useMeasured<HTMLDivElement>('border-radius');
  const chipPaddingX = useMeasured<HTMLDivElement>('padding-left');
  const chipPaddingY = useMeasured<HTMLDivElement>('padding-top');
  const chipText = useMeasured<HTMLDivElement>('font-size');
  const chipLeading = useMeasured<HTMLDivElement>('line-height');
  const chipShadow = useMeasured<HTMLDivElement>('box-shadow');

  const metrics = [
    { name: 'tooltip.shadow', value: chipShadow.value },
    { name: 'tooltip.radius', value: chipRadius.value },
    { name: 'tooltip.paddingX', value: chipPaddingX.value },
    { name: 'tooltip.paddingY', value: chipPaddingY.value },
    { name: 'tooltip.text', value: chipText.value },
    { name: 'tooltip.leading', value: chipLeading.value },
  ];

  const dimensions = [
    { name: 'tooltip.maxWidth', value: tooltipTokens.maxWidth },
    { name: 'tooltip.rise', value: tooltipTokens.rise },
  ];

  return (
    <Row>
      <LegendKey>{'tooltip · stand-in'}</LegendKey>
      <Cluster>
        <div
          ref={(node) => {
            chipRadius.ref.current = node;
            chipPaddingX.ref.current = node;
            chipPaddingY.ref.current = node;
            chipText.ref.current = node;
            chipLeading.ref.current = node;
            chipShadow.ref.current = node;
          }}
          {...stylex.props(chip.popup, styles.tooltipReplica)}
        >
          Rerun this turn
        </div>
      </Cluster>
      <div {...stylex.props(styles.replicaCaption)}>
        <span {...stylex.props(styles.rungUse)}>
          The one floating thing that inverts rather than rising off the page: the ladder puts a
          menu, a popover and a list on the raised background under the popover shadow, and names
          the tooltip apart as label with shadow.medium. It is a label over a control rather than a
          place to act, so it never takes the pointer.
        </span>
        <dl {...stylex.props(styles.constList)}>
          {metrics.map((entry) => (
            <div key={entry.name} {...stylex.props(styles.constRow)}>
              <dt {...stylex.props(styles.constName)}>{entry.name}</dt>
              <dd {...stylex.props(styles.constValue)}>{entry.value}</dd>
            </div>
          ))}
          {dimensions.map((entry) => (
            <WidthProbeRow key={entry.name} {...entry} />
          ))}
        </dl>
      </div>
    </Row>
  );
}

/** Tooltips a reader can point at; one provider, so the second opens instantly. */
function TooltipRow() {
  return (
    <Row>
      <LegendKey>tooltips</LegendKey>
      <Tooltip.Provider>
        <Cluster>
          <Tooltip.Root>
            <Tooltip.Trigger render={<Button variant="ghost" icon aria-label="Rerun" />}>
              <ChevronRightGlyph />
            </Tooltip.Trigger>
            <Tooltip.Content>Rerun this turn</Tooltip.Content>
          </Tooltip.Root>
          <Tooltip.Root>
            <Tooltip.Trigger render={<span {...stylex.props(styles.tooltipAnchor)} />}>
              Point at this
            </Tooltip.Trigger>
            <Tooltip.Content side="right">
              A tooltip names what is under the pointer, and wraps at its own width rather than
              trailing off into an ellipsis nobody can open.
            </Tooltip.Content>
          </Tooltip.Root>
        </Cluster>
      </Tooltip.Provider>
    </Row>
  );
}

function StripRow({ name, size }: { name: string; size: TabsSize }) {
  const { ref, value } = useMeasured<HTMLDivElement>('height');
  return (
    <Row>
      <LegendKey>{name}</LegendKey>
      <Cluster>
        <Tabs.Root defaultValue="rendered">
          <Tabs.List ref={ref} size={size}>
            <Tabs.Tab value="rendered">Rendered</Tabs.Tab>
            <Tabs.Tab value="raw">Raw</Tabs.Tab>
            <Tabs.Tab value="diff">Diff</Tabs.Tab>
          </Tabs.List>
        </Tabs.Root>
      </Cluster>
      <span {...stylex.props(styles.readout)}>{value}</span>
    </Row>
  );
}

/** A tab nobody can take, reporting the one opacity the family dims with. */
function StripDisabledRow() {
  const { ref, value } = useMeasured<HTMLButtonElement>('opacity');
  return (
    <Row>
      <LegendKey>disabled</LegendKey>
      <Cluster>
        <Tabs.Root defaultValue="rendered">
          <Tabs.List>
            <Tabs.Tab value="rendered">Rendered</Tabs.Tab>
            <Tabs.Tab ref={ref} value="raw" disabled>
              Raw
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.Root>
      </Cluster>
      <span {...stylex.props(styles.readout)}>disclosure.disabledOpacity {value}</span>
    </Row>
  );
}

/** The strip taking the width it is given, with the tabs splitting it. */
function StripStretchRow() {
  return (
    <Row>
      <LegendKey>stretch</LegendKey>
      <div {...stylex.props(styles.disclosureBlock)}>
        <Tabs.Root defaultValue="local">
          <Tabs.List stretch>
            <Tabs.Tab value="local">Local</Tabs.Tab>
            <Tabs.Tab value="github">GitHub</Tabs.Tab>
            <Tabs.Tab value="chat">Chat</Tabs.Tab>
          </Tabs.List>
        </Tabs.Root>
      </div>
    </Row>
  );
}

/** The strip with what it swaps, so the gap between the two is on the board. */
function StripPanelRow() {
  return (
    <Row>
      <LegendKey>panel</LegendKey>
      <div {...stylex.props(styles.disclosureBlock)}>
        <Tabs.Root defaultValue="sync">
          <Tabs.List size="small">
            <Tabs.Tab value="sync">Conversation sync</Tabs.Tab>
            <Tabs.Tab value="worktree">Worktree setup</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="sync">Sessions on this project sync their history.</Tabs.Panel>
          <Tabs.Panel value="worktree">Each session gets a worktree of its own.</Tabs.Panel>
        </Tabs.Root>
      </div>
    </Row>
  );
}

function StripDimensions() {
  const dimensions = [
    { name: 'disclosure.trackInset', value: disclosureTokens.trackInset },
    { name: 'disclosure.trackRadiusSmall', value: disclosureTokens.trackRadiusSmall },
    { name: 'disclosure.trackRadiusMedium', value: disclosureTokens.trackRadiusMedium },
    { name: 'disclosure.tabPaddingX', value: disclosureTokens.tabPaddingX },
    { name: 'disclosure.tabGap', value: disclosureTokens.tabGap },
    { name: 'disclosure.tabText', value: disclosureTokens.tabText },
    { name: 'disclosure.panelGap', value: disclosureTokens.panelGap },
    { name: 'disclosure.ringWidth', value: disclosureTokens.ringWidth },
  ];
  return (
    <Row>
      <LegendKey>dimensions</LegendKey>
      <div {...stylex.props(styles.replicaCaption)}>
        <dl {...stylex.props(styles.constList)}>
          {dimensions.map((entry) => (
            <WidthProbeRow key={entry.name} {...entry} />
          ))}
        </dl>
      </div>
    </Row>
  );
}

/** The stack, with its first row already open so both states are on the board. */
function StackRow() {
  return (
    <Row>
      <LegendKey>accordion</LegendKey>
      <div {...stylex.props(styles.disclosureBlock)}>
        <Accordion.Root defaultValue={['session']}>
          <Accordion.Item value="session">
            <Accordion.Trigger>What a session is</Accordion.Trigger>
            <Accordion.Panel>One agent, one worktree, and every turn between them.</Accordion.Panel>
          </Accordion.Item>
          <Accordion.Item value="machine">
            <Accordion.Trigger>What a machine is</Accordion.Trigger>
            <Accordion.Panel>The computer a session runs its work on.</Accordion.Panel>
          </Accordion.Item>
          <Accordion.Item value="project">
            <Accordion.Trigger>What a project is</Accordion.Trigger>
            <Accordion.Panel>A repository, and the sessions opened against it.</Accordion.Panel>
          </Accordion.Item>
        </Accordion.Root>
      </div>
    </Row>
  );
}

/** A lone disclosure, opened by a control the surface already had. */
function CollapsibleRow() {
  return (
    <Row>
      <LegendKey>collapsible</LegendKey>
      <div {...stylex.props(styles.disclosureBlock)}>
        <Collapsible.Root defaultOpen>
          <Collapsible.Trigger render={<Button variant="secondary" size="small" />}>
            3 files changed
          </Collapsible.Trigger>
          <Collapsible.Panel>
            <p {...stylex.props(styles.collapsibleBody)}>
              The panel is all this primitive owns: the height Base UI measured, the transition
              between that and nothing, and the overflow that hides what is arriving.
            </p>
          </Collapsible.Panel>
        </Collapsible.Root>
      </div>
    </Row>
  );
}

function StackDimensions() {
  const dimensions = [
    { name: 'disclosure.rowPaddingY', value: disclosureTokens.rowPaddingY },
    { name: 'disclosure.rowGap', value: disclosureTokens.rowGap },
    { name: 'disclosure.rowText', value: disclosureTokens.rowText },
    { name: 'disclosure.chevronSize', value: disclosureTokens.chevronSize },
    { name: 'disclosure.panelText', value: disclosureTokens.panelText },
    { name: 'disclosure.panelLeading', value: disclosureTokens.panelLeading },
    { name: 'disclosure.panelPaddingBottom', value: disclosureTokens.panelPaddingBottom },
  ];
  return (
    <Row>
      <LegendKey>dimensions</LegendKey>
      <div {...stylex.props(styles.replicaCaption)}>
        <dl {...stylex.props(styles.constList)}>
          {dimensions.map((entry) => (
            <WidthProbeRow key={entry.name} {...entry} />
          ))}
        </dl>
      </div>
    </Row>
  );
}

function ButtonFocusRow() {
  const { ref, value } = useMeasured<HTMLDivElement>('box-shadow');
  return (
    <Row>
      <LegendKey>focus</LegendKey>
      <Cluster>
        <div ref={ref} {...stylex.props(styles.buttonFocusReplica)}>
          Keyboard focus
        </div>
      </Cluster>
      <span {...stylex.props(styles.readout)}>{value}</span>
    </Row>
  );
}

function FocusRingRow() {
  const { ref, value } = useMeasured<HTMLDivElement>('box-shadow');
  return (
    <FieldRow legend="focus" readout={value}>
      <div ref={ref} {...stylex.props(styles.focusReplica)}>
        Describe the task
      </div>
    </FieldRow>
  );
}

/**
 * The `@lody/ui` token board: every semantic token and every Button state,
 * rendered from the tokens themselves so the board cannot drift from them.
 */
export function UiGallery({ palettes = 'both' }: UiGalleryProps) {
  return (
    <Board>
      <BoardHeader
        title="Lody UI"
        lead="Token board and primitive gallery for @lody/ui. Every colour, elevation rung, shadow, radius, control size, type step and Button state, rendered from the tokens in both palettes. Values under each sample are read back from the rendered node, so this board reports what the tokens produce rather than a copy of them."
      />

      <Section
        title="Surfaces"
        rule="Depth without lines. No border token exists: surfaces separate by luminance step and shadow."
      >
        <PaletteSplit palettes={palettes}>
          <Grid>
            {SURFACES.map((token) => (
              <Swatch key={token.name} {...token} />
            ))}
          </Grid>
        </PaletteSplit>
      </Section>

      <Section
        title="Elevation ladder"
        rule="One rung per component. The rung fixes background and shadow together."
      >
        <PaletteSplit palettes={palettes}>
          <div {...stylex.props(styles.stage)}>
            {RUNGS.map((rung) => (
              <div key={rung.name} {...stylex.props(styles.rung, rung.style)}>
                <span {...stylex.props(styles.rungName)}>{rung.name}</span>
                <span {...stylex.props(styles.rungUse)}>{rung.use}</span>
              </div>
            ))}
          </div>
        </PaletteSplit>
      </Section>

      <Section
        title="Content"
        rule="label is the thing, secondaryLabel is about the thing, tertiaryLabel is a hint."
      >
        <PaletteSplit palettes={palettes}>
          <div {...stylex.props(styles.textSample)}>
            <span {...stylex.props(dyn.text(colors.label))}>label — Session started</span>
            <span {...stylex.props(dyn.text(colors.secondaryLabel))}>
              secondaryLabel — 4 files changed
            </span>
            <span {...stylex.props(dyn.text(colors.tertiaryLabel))}>
              tertiaryLabel — Describe the task
            </span>
          </div>
          <Grid>
            {CONTENT_COLORS.map((token) => (
              <Swatch key={token.name} {...token} />
            ))}
          </Grid>
        </PaletteSplit>
      </Section>

      <Section
        title="Fills and edges"
        rule="separator divides list and table rows only, never around a surface. The ring is 2px, tight to the control, no glow."
      >
        <PaletteSplit palettes={palettes}>
          <Rows>
            <div {...stylex.props(styles.hoverRow, styles.hoverFill)}>hoverFill</div>
            <div {...stylex.props(styles.hoverRow, styles.selectedFill)}>selectedFill</div>
            <div {...stylex.props(styles.separatorRow)}>
              <span {...stylex.props(styles.separatorText)}>separator — first row</span>
              <div {...stylex.props(styles.separatorLine)} />
              <span {...stylex.props(styles.separatorText)}>separator — next row</span>
            </div>
            <div {...stylex.props(styles.overlaySample)}>overlay</div>
            <Cluster>
              <div {...stylex.props(styles.ring, styles.ringAccent)}>focus ring · accent</div>
              <div {...stylex.props(styles.ring, styles.ringDestructive)}>
                invalid · destructive
              </div>
            </Cluster>
          </Rows>
          <Grid>
            {FILLS.map((token) => (
              <Swatch key={token.name} {...token} />
            ))}
          </Grid>
        </PaletteSplit>
      </Section>

      <Section
        title="Roles"
        rule="accent marks live state only — focus, link, running — and is never a button fill. Ink carries stored state instead."
      >
        <PaletteSplit palettes={palettes}>
          <Grid>
            {ROLE_COLORS.map((token) => (
              <Swatch key={token.name} {...token} />
            ))}
          </Grid>
        </PaletteSplit>
      </Section>

      <Section
        title="Gray ramp"
        rule="Semantic first, gray second. These are for things with no role: scrollbar, track, kbd, skeleton."
      >
        <PaletteSplit palettes={palettes}>
          <Grid>
            {GRAYS.map((token) => (
              <Swatch key={token.name} {...token} note="no role" />
            ))}
          </Grid>
        </PaletteSplit>
      </Section>

      <Section title="Shadows" rule="Strength by rung. Dark palettes add an inset top highlight.">
        <PaletteSplit palettes={palettes}>
          <Grid>
            {SHADOWS.map((token) => (
              <ShadowChip key={token.name} {...token} />
            ))}
          </Grid>
        </PaletteSplit>
      </Section>

      <Section
        title="Corners"
        rule="corner.shape (squircle) rides along with every radius except radius.full, which is a pill or a circle and takes corner.round: a squircle at that radius is a superellipse, not a stadium, so it would turn a switch track into a rounded rectangle and a radio into a squircle. Round corners outside Chromium are the accepted fallback. Nested radius is outer minus inset."
      >
        <PaletteSplit palettes={palettes}>
          <Grid>
            {RADII.map((token) => (
              <RadiusChip key={token.name} {...token} />
            ))}
          </Grid>
        </PaletteSplit>
      </Section>

      <Section
        title="Control sizes"
        rule="28 / 32 / 36. Default 32; 36 only for empty states and onboarding. Icon-only buttons are square at the size's height."
      >
        <PaletteSplit palettes={palettes}>
          <Rows>
            {CONTROL_SIZES.map((token) => (
              <ControlRow key={token.name} {...token} />
            ))}
          </Rows>
        </PaletteSplit>
      </Section>

      <Section
        title="Type"
        rule="Controls at 13 with weight 500 and controlTracking. Prose at 14. Field labels and help at 12."
      >
        <PaletteSplit palettes={palettes}>
          <Rows>
            {TYPE_SCALE.map((token) => (
              <TypeRow key={token.name} {...token} />
            ))}
          </Rows>
        </PaletteSplit>
      </Section>

      <Section title="Space" rule="The spacing step used for gaps, padding and stack rhythm.">
        <PaletteSplit palettes={palettes}>
          <Rows>
            {SPACES.map((token) => (
              <SpaceRow key={token.name} {...token} />
            ))}
          </Rows>
        </PaletteSplit>
      </Section>

      <Section
        title="Motion"
        rule="The distance a thing travels picks its step. Press translates 1px and drops the ink edge at duration.fast. A popup rises 4px at duration.regular. A drawer crosses the window at duration.slow, because 180ms over 600px reads as a snap rather than a slide. One easing throughout. Hover a chip to see its duration."
      >
        <PaletteSplit palettes={palettes}>
          <Cluster>
            <div {...stylex.props(styles.motionChip, dyn.transition(duration.fast))}>
              duration.fast · press, cross-fade
            </div>
            <div {...stylex.props(styles.motionChip, dyn.transition(duration.regular))}>
              duration.regular · rise
            </div>
            <div {...stylex.props(styles.motionChip, dyn.transition(duration.slow))}>
              duration.slow · a drawer crossing the window
            </div>
          </Cluster>
        </PaletteSplit>
      </Section>

      <Section title="Constants" rule="Compile-time values; they are the same in both palettes.">
        <PaletteSplit palettes={palettes}>
          <dl {...stylex.props(styles.constList)}>
            {CONSTS.map((entry) => (
              <div key={entry.name} {...stylex.props(styles.constRow)}>
                <dt {...stylex.props(styles.constName)}>{entry.name}</dt>
                <dd {...stylex.props(styles.constValue)}>{entry.value}</dd>
              </div>
            ))}
          </dl>
        </PaletteSplit>
      </Section>

      <Section
        title="Button · variants and sizes"
        rule="Variant carries the role, size carries the density. Visual choices are props; callers never restyle a button."
      >
        <PaletteSplit palettes={palettes}>
          <div {...stylex.props(styles.matrix)}>
            {BUTTON_VARIANTS.map((variant) => (
              <Fragment key={variant}>
                <LegendKey>{variant}</LegendKey>
                <Cluster>
                  {BUTTON_SIZES.map((size) => (
                    <Button key={size} variant={variant} size={size}>
                      {size}
                    </Button>
                  ))}
                </Cluster>
              </Fragment>
            ))}
          </div>
        </PaletteSplit>
      </Section>

      <Section
        title="Button · states, tone, shape, icons"
        rule="Disabled is 45% opacity on the whole control, not a colour. Destructive tone tints a quiet variant; the destructive variant fills. The focus ring is a box-shadow composed with the variant's own edge, never an outline."
      >
        <PaletteSplit palettes={palettes}>
          <Rows>
            <Row>
              <LegendKey>disabled</LegendKey>
              <Cluster>
                <Button disabled>Primary</Button>
                <Button variant="secondary" disabled>
                  Secondary
                </Button>
                <Button variant="ghost" disabled>
                  Ghost
                </Button>
                <Button variant="destructive" disabled>
                  Delete
                </Button>
              </Cluster>
            </Row>
            <Row>
              <LegendKey>tone=&quot;destructive&quot;</LegendKey>
              <Cluster>
                <Button variant="secondary" tone="destructive">
                  Remove
                </Button>
                <Button variant="ghost" tone="destructive">
                  Remove
                </Button>
                <Button variant="link" tone="destructive">
                  Remove
                </Button>
                <Button variant="destructive">Delete session</Button>
              </Cluster>
            </Row>
            <Row>
              <LegendKey>shape=&quot;pill&quot;</LegendKey>
              <Cluster>
                <Button shape="pill">Send</Button>
                <Button variant="secondary" shape="pill">
                  Draft
                </Button>
                <Button shape="pill" icon aria-label="Add attachment">
                  <PlusGlyph />
                </Button>
              </Cluster>
            </Row>
            <Row>
              <LegendKey>icon</LegendKey>
              <Cluster>
                {BUTTON_SIZES.map((size) => (
                  <Button
                    key={size}
                    size={size}
                    variant="secondary"
                    icon
                    aria-label={`Add ${size}`}
                  >
                    <PlusGlyph />
                  </Button>
                ))}
                <Button>
                  <PlusGlyph />
                  With label
                </Button>
              </Cluster>
            </Row>
            <ButtonFocusRow />
            <Row>
              <LegendKey>render</LegendKey>
              <Cluster>
                <Button variant="link" render={<a href="#gallery" />}>
                  Anchor as a button
                </Button>
              </Cluster>
            </Row>
          </Rows>
        </PaletteSplit>
      </Section>

      <Section
        title="Field · label, control, help, error"
        rule="One token group serves the whole family, so a state has one colour in one place. Field.Root owns name, disabled and validity; the label, control, help and error read that state instead of taking their own copies. Field.Root renders its validity as aria-invalid, and the ring follows that attribute, so a surface holding its own validation reaches the same state on a bare control."
      >
        <PaletteSplit palettes={palettes}>
          <Rows>
            <FieldRow legend="anatomy">
              <Field.Root name="title">
                <Field.Label>Session title</Field.Label>
                <Input placeholder="Describe the task" />
                <Field.Description>Shown in the sidebar and on the session card.</Field.Description>
              </Field.Root>
            </FieldRow>
            <FieldRow legend="filled">
              <Field.Root name="title">
                <Field.Label>Session title</Field.Label>
                <Input defaultValue="Rebuild the composer" />
              </Field.Root>
            </FieldRow>
            <InvalidFieldRow />
            <FieldRow legend={'invalid \u00b7 aria-invalid'}>
              <Field.Label htmlFor="gallery-aria-invalid">Session title</Field.Label>
              <Input id="gallery-aria-invalid" aria-invalid placeholder="Describe the task" />
            </FieldRow>
            <FieldRow legend="disabled">
              <Field.Root name="title" disabled>
                <Field.Label>Session title</Field.Label>
                <Input defaultValue="Rebuild the composer" />
                <Field.Description>Locked while the session runs.</Field.Description>
              </Field.Root>
            </FieldRow>
            <FocusRingRow />
          </Rows>
          <Grid>
            {FIELD_COLORS.map((token) => (
              <Swatch key={token.name} {...token} />
            ))}
            <ShadowChip
              name="field.well"
              box={field.well}
              fill={field.background}
              ink={false}
              note="the control is sunken, not outlined"
            />
          </Grid>
        </PaletteSplit>
      </Section>

      <Section
        title="Field · sizes and Textarea"
        rule="28 / 32 / 36, the same ladder as Button, with radius small at 28 and medium at 32 and 36. Textarea is the same well at the medium radius and grows downward."
      >
        <PaletteSplit palettes={palettes}>
          <Rows>
            {FIELD_SIZES.map((entry) => (
              <FieldSizeRow key={entry.size} {...entry} />
            ))}
            <FieldRow legend="textarea">
              <Field.Root name="summary">
                <Field.Label>What should the agent do?</Field.Label>
                <Textarea placeholder="Describe the task" rows={3} />
                <Field.Description>Enter sends; Shift+Enter adds a line.</Field.Description>
              </Field.Root>
            </FieldRow>
            <FieldRow legend="textarea · invalid">
              <Field.Root name="summary" invalid>
                <Field.Label>What should the agent do?</Field.Label>
                <Textarea defaultValue="" placeholder="Describe the task" rows={3} />
                <Field.Error match>Describe the task before starting.</Field.Error>
              </Field.Root>
            </FieldRow>
            <FieldRow legend="textarea · disabled">
              <Field.Root name="summary" disabled>
                <Field.Label>What should the agent do?</Field.Label>
                <Textarea defaultValue="Rebuild the composer" resize="none" rows={3} />
              </Field.Root>
            </FieldRow>
          </Rows>
        </PaletteSplit>
      </Section>

      <Section
        title="Field · Checkbox, Radio, Switch"
        rule="The same well, ring and disabled treatment as the text controls, drawn as a 16px box and a 28px track. Stored state is ink: the label fill with the background mark and the primary button's own top highlight, because accent stays on live state and is never a fill. A mixed box announces mixed and draws the dash rather than falling back to a tick it does not hold."
      >
        <PaletteSplit palettes={palettes}>
          <Rows>
            <ChoiceRow legend="checkbox">
              <Field.Label>
                <Checkbox />
                Include diffs
              </Field.Label>
              <Field.Label>
                <Checkbox indeterminate />
                Some files
              </Field.Label>
            </ChoiceRow>
            <CheckedInkRow />
            <ChoiceRow legend={'checkbox \u00b7 invalid'}>
              <Field.Root invalid>
                <Field.Label>
                  <Checkbox />
                  Accept the terms
                </Field.Label>
                <Field.Error match>Tick this to continue.</Field.Error>
              </Field.Root>
            </ChoiceRow>
            <ChoiceRow legend={'checkbox \u00b7 disabled'}>
              <Field.Root disabled>
                <Field.Label>
                  <Checkbox defaultChecked />
                  Include diffs
                </Field.Label>
              </Field.Root>
            </ChoiceRow>
            <ChoiceRow legend="radio">
              <RadioGroup name="gallery-review" defaultValue="ask">
                <Field.Label>
                  <Radio value="ask" />
                  Ask before reviewing
                </Field.Label>
                <Field.Label>
                  <Radio value="auto" />
                  Review every push
                </Field.Label>
              </RadioGroup>
            </ChoiceRow>
            <SwitchTrackRow />
            <ChoiceRow legend={'switch \u00b7 disabled'}>
              <Field.Root disabled>
                <Field.Label>
                  <Switch defaultChecked />
                  Auto review
                </Field.Label>
              </Field.Root>
            </ChoiceRow>
          </Rows>
          <Grid>
            {CHOICE_COLORS.map((token) => (
              <Swatch key={token.name} {...token} />
            ))}
            <ShadowChip
              name="field.checkedEdge"
              box={field.checkedEdge}
              fill={field.checkedFill}
              ink
              note="the ink highlight a checked control carries"
            />
            <ShadowChip
              name="field.thumbShadow"
              box={field.thumbShadow}
              fill={field.thumb}
              ink={false}
              note="the thumb is raised on both tracks"
            />
          </Grid>
        </PaletteSplit>
      </Section>
      <Section
        title="Select · trigger and list"
        rule="A trigger is a control on the well rung, so it takes the field family's size ladder, ring, invalid ring and disabled opacity; the list it opens is on the floating rung and reads the popup group instead. A row states two facts: selected is the row that holds the value, highlighted is where the keyboard or the pointer is, and the highlight wins the fill because it is the one that moves. The open list below is a stand-in built from the same rules the popup applies, because a board cannot show a popup without covering what is under it."
      >
        <PaletteSplit palettes={palettes}>
          <Rows>
            {SELECT_SIZES.map((entry) => (
              <SelectSizeRow key={entry.size} {...entry} />
            ))}
            <FieldRow legend="filled">
              <Field.Root>
                <Field.Label>Fruit</Field.Label>
                <FruitSelect defaultValue="fuji" />
              </Field.Root>
            </FieldRow>
            <FieldRow legend="invalid">
              <Field.Root invalid>
                <Field.Label>Fruit</Field.Label>
                <FruitSelect />
                <Field.Error match>Pick a fruit before continuing.</Field.Error>
              </Field.Root>
            </FieldRow>
            <FieldRow legend="disabled">
              <Field.Root disabled>
                <Field.Label>Fruit</Field.Label>
                <FruitSelect defaultValue="gala" />
              </Field.Root>
            </FieldRow>
            <PopupReplica />
          </Rows>
          <Grid>
            {POPUP_COLORS.map((token) => (
              <Swatch key={token.name} {...token} />
            ))}
            <ShadowChip
              name="popup.shadow"
              box={popup.shadow}
              fill={popup.background}
              ink={false}
              note="the floating rung, above the page"
            />
          </Grid>
        </PaletteSplit>
      </Section>

      <Section
        title="Combobox · filter and list"
        rule="The same well and the same list, with a query in front of them. On its own the input is the whole control; inside an input group the group is the well and the input is bare, so a chevron beside it lands inside one control rather than beside a second one. The ring follows focus inside the group, and disabled dims it from state because :disabled cannot reach a div."
      >
        <PaletteSplit palettes={palettes}>
          <Rows>
            <FieldRow legend="input">
              <Field.Root>
                <Field.Label>Language</Field.Label>
                <LanguageCombobox>
                  <Combobox.Input placeholder="Search a language" />
                </LanguageCombobox>
              </Field.Root>
            </FieldRow>
            <FieldRow legend="input group">
              <Field.Root>
                <Field.Label>Language</Field.Label>
                <LanguageCombobox>
                  <Combobox.InputGroup>
                    <Combobox.Input placeholder="Search a language" />
                    <Combobox.Trigger aria-label="Open the language list" />
                  </Combobox.InputGroup>
                </LanguageCombobox>
              </Field.Root>
            </FieldRow>
            <FieldRow legend="filled">
              <Field.Root>
                <Field.Label>Language</Field.Label>
                <LanguageCombobox defaultValue="Rust">
                  <Combobox.InputGroup>
                    <Combobox.Input />
                    <Combobox.Trigger aria-label="Open the language list" />
                  </Combobox.InputGroup>
                </LanguageCombobox>
              </Field.Root>
            </FieldRow>
            <FieldRow legend="invalid">
              <Field.Root invalid>
                <Field.Label>Language</Field.Label>
                <LanguageCombobox>
                  <Combobox.InputGroup>
                    <Combobox.Input placeholder="Search a language" />
                    <Combobox.Trigger aria-label="Open the language list" />
                  </Combobox.InputGroup>
                </LanguageCombobox>
                <Field.Error match>Pick a language before continuing.</Field.Error>
              </Field.Root>
            </FieldRow>
            <FieldRow legend="disabled">
              <Field.Root disabled>
                <Field.Label>Language</Field.Label>
                <LanguageCombobox defaultValue="Rust">
                  <Combobox.InputGroup>
                    <Combobox.Input />
                    <Combobox.Trigger aria-label="Open the language list" />
                  </Combobox.InputGroup>
                </LanguageCombobox>
              </Field.Root>
            </FieldRow>
          </Rows>
        </PaletteSplit>
      </Section>
      <Section
        title="Menu · dropdown, context menu and menubar"
        rule="A menu is the same floating surface a Select opens, so it reads the popup group and its rows are the rows of a list. One declaration differs: a list takes the width of the control it belongs to, and a menu — opened by whatever the surface already had there — states its own. A command that destroys something is the one row that is not the label colour, and its highlight is mixed toward destructive so the fill cannot say 'an ordinary command'. ContextMenu and Menubar re-use these rows rather than restating them: only the way in differs."
      >
        <PaletteSplit palettes={palettes}>
          <Rows>
            <Row>
              <LegendKey>dropdown</LegendKey>
              <Cluster>
                <SessionMenu />
              </Cluster>
            </Row>
            <Row>
              <LegendKey>context menu</LegendKey>
              <Cluster>
                <ContextMenu.Root>
                  <ContextMenu.Trigger>
                    <div {...stylex.props(styles.contextArea)}>Right-click this area</div>
                  </ContextMenu.Trigger>
                  <ContextMenu.Content>
                    <ContextMenu.Item inset>Rename</ContextMenu.Item>
                    <ContextMenu.Item inset>Duplicate</ContextMenu.Item>
                    <ContextMenu.Separator />
                    <ContextMenu.Item inset tone="destructive">
                      Delete
                    </ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Root>
              </Cluster>
            </Row>
            <Row>
              <LegendKey>menubar</LegendKey>
              <Cluster>
                <Menubar.Root>
                  <Menubar.Menu>
                    <Menubar.Trigger>File</Menubar.Trigger>
                    <Menubar.Content>
                      <Menubar.Item shortcut={'\u2318N'}>New task</Menubar.Item>
                      <Menubar.Item shortcut={'\u2318S'}>Save</Menubar.Item>
                    </Menubar.Content>
                  </Menubar.Menu>
                  <Menubar.Menu>
                    <Menubar.Trigger>Edit</Menubar.Trigger>
                    <Menubar.Content>
                      <Menubar.Item shortcut={'\u2318Z'}>Undo</Menubar.Item>
                      <Menubar.Item tone="destructive">Delete</Menubar.Item>
                    </Menubar.Content>
                  </Menubar.Menu>
                </Menubar.Root>
              </Cluster>
            </Row>
            <MenuReplica />
          </Rows>
        </PaletteSplit>
      </Section>

      <Section
        title="Popover · a surface with content on it"
        rule="A popover is the floating rung a Select list and a Menu already open, holding content instead of rows. It replaces five of a list's declarations: the width a list takes from the control that shows its value, the 4px inset that lets a row bleed to the surface's edge, and the three that make the type a control's — size, weight and tracking — because what is in a popover is sentences at 14 and weight 400. A control placed in one brings its own step. It is opened by whatever the surface already had there, through render, the way a menu is."
      >
        <PaletteSplit palettes={palettes}>
          <Rows>
            <Row>
              <LegendKey>popover</LegendKey>
              <Cluster>
                <FilterPopover />
              </Cluster>
            </Row>
            <PopoverReplica />
          </Rows>
        </PaletteSplit>
      </Section>

      <Section
        title="Dialog · AlertDialog and Drawer"
        rule="The modal rung is the one that states three things at once: the elevated background, the large shadow, and an overlay over the page — a panel that covers what a person was doing while still showing it. The three are one family reading one token group. A Dialog is dismissable and says so with a cross; an AlertDialog is answered rather than dismissed, so it has no cross and a press beside it is not an answer — Escape still is, because it is the platform's cancel; a Drawer is that panel arriving from an edge, and unlike the other two it can be dragged back out of it — which is why this system has no Sheet. Each one names its own panel as the container every Select, Combobox and Menu inside it mounts into, so a list opened in a modal is inside the focus scope holding it."
      >
        <PaletteSplit palettes={palettes}>
          <Rows>
            <ModalTriggers />
            <DialogReplica />
            <ModalDimensions />
            <Row>
              <LegendKey>dialog.overlay</LegendKey>
              <Cluster>
                <div {...stylex.props(styles.overlaySwatch)}>
                  <div {...stylex.props(styles.overlayFill)} />
                </div>
              </Cluster>
              <span {...stylex.props(styles.rungUse)}>
                The page, receding under the panel. It is the rung's third declaration rather than a
                colour a surface picks.
              </span>
            </Row>
          </Rows>
          <Grid>
            {DIALOG_COLORS.map((token) => (
              <Swatch key={token.name} {...token} />
            ))}
            <ShadowChip
              name="dialog.shadow"
              box={dialogTokens.shadow}
              fill={dialogTokens.background}
              ink={false}
              note="the modal rung, over everything"
            />
          </Grid>
        </PaletteSplit>
      </Section>

      <Section
        title="Tooltip · the name of the thing under the pointer"
        rule="The one floating part that does not read the popup group. The ladder puts a menu, a popover and a list on the raised background under the popover shadow, and then names the tooltip apart: label with shadow.medium. That is a deliberate inversion — a popup is a place to act, a tooltip only names one — so a tooltip carries the page's text colour as its fill and the page's background as its ink, the same pair a primary button and a checked box take. It never takes the pointer, and one that names a control inside a popup still sits above it."
      >
        <PaletteSplit palettes={palettes}>
          <Rows>
            <TooltipRow />
            <TooltipReplica />
          </Rows>
          <Grid>
            {TOOLTIP_COLORS.map((token) => (
              <Swatch key={token.name} {...token} />
            ))}
            <ShadowChip
              name="tooltip.shadow"
              box={tooltipTokens.shadow}
              fill={tooltipTokens.background}
              ink={false}
              note="tight, because it sits on what it names"
            />
          </Grid>
        </PaletteSplit>
      </Section>
      <Section
        title="Tabs · the choices side by side"
        rule="A tab strip is the elevation ladder read twice over: a well-rung track with one thing raised out of it, which is the same pair a Switch takes and says the same thing — the track is where something sits, and the thing sitting in it is the one you can press. The pill is one element that slides rather than a fill on each tab, because the strip is one control. A tab carries no fill in any state; what changes when you take one is its colour, and the pill arriving under it. The size is stated once on the strip: the tabs take the track less its inset, and their corner is the track's less the same inset. Arrow keys move without taking, because a tab swaps a panel that may be expensive to build."
      >
        <PaletteSplit palettes={palettes}>
          <Rows>
            {STRIP_SIZES.map((entry) => (
              <StripRow key={entry.name} {...entry} />
            ))}
            <StripDisabledRow />
            <StripStretchRow />
            <StripPanelRow />
            <StripDimensions />
          </Rows>
          <Grid>
            {STRIP_COLORS.map((token) => (
              <Swatch key={token.name} {...token} />
            ))}
            <ShadowChip
              name="disclosure.trackWell"
              box={disclosureTokens.trackWell}
              fill={disclosureTokens.trackBackground}
              ink={false}
              note="the track, sunken"
            />
            <ShadowChip
              name="disclosure.indicatorShadow"
              box={disclosureTokens.indicatorShadow}
              fill={disclosureTokens.indicator}
              ink={false}
              note="the selected tab, raised"
            />
          </Grid>
        </PaletteSplit>
      </Section>

      <Section
        title="Accordion and Collapsible · the choices stacked"
        rule="The same family laid out down the page instead of across it: a row, and what opens under it in place. A row has no fill in any state — it is a line of a list rather than a control on a surface — so the line to the next row is the separator the rules give a list, and what moves when it opens is the chevron the part draws. One row is open at a time unless the stack says otherwise, because an accordion's point is that a long page stays short. A Collapsible is one of those rows with no list around it, so it takes no line and no row: its trigger is whatever the surface already had there, and the panel is all the primitive owns. What a panel holds is prose, and its padding rides on a child of it — the panel's own height is what the reveal animates, and Base UI measures that height with scrollHeight, which counts padding."
      >
        <PaletteSplit palettes={palettes}>
          <Rows>
            <StackRow />
            <CollapsibleRow />
            <StackDimensions />
          </Rows>
          <Grid>
            {STACK_COLORS.map((token) => (
              <Swatch key={token.name} {...token} />
            ))}
          </Grid>
        </PaletteSplit>
      </Section>
    </Board>
  );
}
