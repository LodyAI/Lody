import * as stylex from '@stylexjs/stylex';
import { Fragment } from 'react';
import { Button } from '../button/button';
import { colors, shadow } from '../tokens/colors.stylex';
import { control, corner, duration, ease, radius, space, text, z } from '../tokens/scales.stylex';
import {
  Board,
  BoardHeader,
  Cluster,
  Field,
  Grid,
  LegendKey,
  PaletteSplit,
  Row,
  Rows,
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
  { name: 'radius.mini', value: radius.mini, note: '16px things' },
  { name: 'radius.small', value: radius.small, note: '28px controls, tooltips' },
  { name: 'radius.medium', value: radius.medium, note: '32 and 36px controls' },
  { name: 'radius.large', value: radius.large, note: 'surfaces' },
  { name: 'radius.full', value: radius.full, note: 'pills' },
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
    <Field name={name} note={note} measured={value}>
      <div
        ref={ref}
        {...stylex.props(
          styles.shadowChip,
          dyn.raised(fill, box),
          ink && dyn.ink(fill, colors.background)
        )}
      />
    </Field>
  );
}

function RadiusChip({ name, value, note }: { name: string; value: string; note: string }) {
  const { ref, value: measured } = useMeasured<HTMLDivElement>('border-radius');
  return (
    <Field name={name} note={note} measured={measured}>
      <div ref={ref} {...stylex.props(styles.radiusChip, dyn.radius(value))} />
    </Field>
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
        rule="corner.shape (squircle) rides along with every radius; round corners outside Chromium are the accepted fallback. Nested radius is outer minus inset."
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
        rule="Disabled is 45% opacity on the whole control, not a colour. Destructive tone tints a quiet variant; the destructive variant fills."
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
    </Board>
  );
}
