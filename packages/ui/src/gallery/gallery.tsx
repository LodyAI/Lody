import * as stylex from '@stylexjs/stylex';
import { Fragment, type ComponentProps, type ReactNode, type Ref, type RefObject } from 'react';
import { Button } from '../button/button';
import { button } from '../button/button.tokens.stylex';
import { Checkbox } from '../field/checkbox';
import { Combobox } from '../field/combobox';
import { Field } from '../field/field';
import { field } from '../field/field.tokens.stylex';
import { ChevronDownGlyph, ChevronRightGlyph, DotGlyph, TickGlyph } from '../internal/glyphs';
import { ContextMenu } from '../menu/context-menu';
import { Menu } from '../menu/menu';
import { Menubar } from '../menu/menubar';
import { Input } from '../field/input';
import { Radio, RadioGroup } from '../field/radio';
import { Select } from '../field/select';
import { Switch } from '../field/switch';
import { Textarea } from '../field/textarea';
import { popup } from '../popup/popup.tokens.stylex';
import { surface } from '../popup/surface';
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
  { name: 'overlay', value: colors.overlay, note: 'dialog and sheet backdrop' },
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
  { name: 'modal', style: styles.modal, use: 'dialog, sheet' },
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
    note: 'dialogs and sheets',
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
  { name: 'title', size: text.titleSize, leading: text.titleLeading, note: 'sheet, full page' },
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
        rule="Press translates 1px and drops the ink edge at duration.fast. Popups rise from 4px below at duration.regular. One easing. Hover a chip to see its duration."
      >
        <PaletteSplit palettes={palettes}>
          <Cluster>
            <div {...stylex.props(styles.motionChip, dyn.transition(duration.fast))}>
              duration.fast · press, cross-fade
            </div>
            <div {...stylex.props(styles.motionChip, dyn.transition(duration.regular))}>
              duration.regular · rise
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
    </Board>
  );
}
