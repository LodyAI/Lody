import * as stylex from '@stylexjs/stylex';
import { Fragment, type ReactNode } from 'react';
import { Button } from '../button/button';
import { button } from '../button/button.tokens.stylex';
import { Checkbox } from '../field/checkbox';
import { Field } from '../field/field';
import { field } from '../field/field.tokens.stylex';
import { Input } from '../field/input';
import { Radio, RadioGroup } from '../field/radio';
import { Switch } from '../field/switch';
import { Textarea } from '../field/textarea';
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
  { name: 'field.error', value: field.error, note: 'the error message' },
  { name: 'field.ring', value: field.ring, note: 'focus' },
  { name: 'field.invalidRing', value: field.invalidRing, note: 'invalid' },
];

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
    </Board>
  );
}
