import * as stylex from '@stylexjs/stylex';
import { forwardRef, useId, type ComponentProps } from 'react';
import { appendClassName } from '../internal/class-name';
import { ICONS, type IconLayers, type IconMark, type IconName } from './registry';

/**
 * The four treatments of one drawing.
 *
 * `outline` is the stroke. `duotone` is the stroke over the back layer at 18%.
 * `glyph` is everything filled, with the inner marks cut out — through a mask,
 * so the cut is transparent and the icon can sit on any surface. `bulk` is no
 * stroke at all: the back layer at 35%, the front at 100%, and the depth is the
 * difference between them. Every variant reads the same paths; an icon that has
 * no layers is outline in every variant rather than a different drawing.
 */
export type IconVariant = 'outline' | 'duotone' | 'glyph' | 'bulk';

export interface IconProps extends Omit<ComponentProps<'svg'>, 'className' | 'children'> {
  name: IconName;
  variant?: IconVariant;
  /**
   * What the icon says, for a screen reader. Without one the icon is decoration
   * and hidden from assistive technology; the text beside it carries the meaning.
   */
  title?: string;
  className?: string;
}

/** The set's stroke, in user units of the 24 grid. */
export const ICON_STROKE = 1.5;

const DUOTONE_BACK = 0.18;
const BULK_BACK = 0.35;
const BULK_MID = 0.55;
/** A cut mark is heavier than the stroke, so it reads at 16px through a fill. */
const CUT = 1.75;
const DOT = 2.5;

const styles = stylex.create({
  /**
   * An icon fills the box it is given and inherits `currentColor`: the part
   * holding it owns both its size and its colour, the same contract as the
   * package's own glyphs.
   */
  icon: { display: 'block', width: '100%', height: '100%', flexShrink: 0 },
});

const STROKE_PROPS = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: ICON_STROKE,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function Mark({ mark }: { mark: IconMark }) {
  if ('path' in mark) {
    return <path d={mark.path} strokeWidth={mark.weight} />;
  }
  if ('circle' in mark) {
    const [cx, cy, r] = mark.circle;
    return <circle cx={cx} cy={cy} r={r} />;
  }
  const [x, y, width, height, rx] = mark.rect;
  return <rect x={x} y={y} width={width} height={height} rx={rx} />;
}

function Outline({ marks }: { marks: readonly IconMark[] }) {
  return (
    <g {...STROKE_PROPS}>
      {marks.map((mark, index) => (
        <Mark key={index} mark={mark} />
      ))}
    </g>
  );
}

/** The strokes outside the mass, drawn the same in every variant. */
function Outer({ layers }: { layers: IconLayers }) {
  if (!layers.outer && !layers.dots) return null;
  return (
    <g {...STROKE_PROPS}>
      {layers.outer ? <path d={layers.outer} /> : null}
      {layers.dots ? <path d={layers.dots} strokeWidth={DOT} /> : null}
    </g>
  );
}

function Duotone({ marks, layers }: { marks: readonly IconMark[]; layers: IconLayers }) {
  return (
    <>
      <path d={layers.mass} fill="currentColor" fillOpacity={DUOTONE_BACK} />
      <Outline marks={marks} />
    </>
  );
}

function Glyph({ layers, maskId }: { layers: IconLayers; maskId: string }) {
  // A glyph with nothing to cut — a play triangle — is a fill and needs no mask.
  const cuts = Boolean(layers.front || layers.detail);
  return (
    <>
      {cuts ? (
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect width="24" height="24" fill="white" />
          <g fill="none" stroke="black" strokeLinecap="round" strokeLinejoin="round">
            {layers.front ? <path d={layers.front} strokeWidth={ICON_STROKE} /> : null}
            {layers.detail ? <path d={layers.detail} strokeWidth={CUT} /> : null}
          </g>
        </mask>
      ) : null}
      <g fill="currentColor" mask={cuts ? `url(#${maskId})` : undefined}>
        <path d={layers.mass} />
        {layers.mid ? <path d={layers.mid} /> : null}
        {layers.front ? <path d={layers.front} /> : null}
      </g>
      {layers.outer ? (
        <g {...STROKE_PROPS}>
          <path d={layers.outer} />
        </g>
      ) : null}
      {layers.dots ? (
        <g {...STROKE_PROPS}>
          <path d={layers.dots} strokeWidth={DOT} stroke="currentColor" />
        </g>
      ) : null}
    </>
  );
}

function Bulk({ layers }: { layers: IconLayers }) {
  const detail = layers.bulkDetail ?? layers.detail;
  return (
    <>
      <path d={layers.mass} fill="currentColor" fillOpacity={BULK_BACK} />
      {layers.mid ? <path d={layers.mid} fill="currentColor" fillOpacity={BULK_MID} /> : null}
      {layers.front ? <path d={layers.front} fill="currentColor" /> : null}
      {detail ? (
        <g {...STROKE_PROPS}>
          <path d={detail} />
        </g>
      ) : null}
      <Outer layers={layers} />
    </>
  );
}

/**
 * One icon of the set, in one of its four treatments.
 *
 * The drawing comes from `registry.ts`; this component only decides which
 * layers to draw and how. It is an `<svg>` and nothing else — no box, no
 * colour, no size of its own — because the rules give those to whatever holds
 * the glyph, and an icon that stated a size would have to be overridden by
 * every button, row and badge that already states one.
 */
export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
  { name, variant = 'outline', title, className, ...rest },
  ref
) {
  const definition = ICONS[name];
  const { layers } = definition;
  // `useId` is unique within one React tree, and the name is in the id too, so
  // that where two trees on one page do collide — an island beside an island —
  // the mask a glyph resolves is at worst an identical one. React's punctuation
  // is stripped so the id survives `url(#…)`.
  const maskId = `lody-icon-${name}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const sx = stylex.props(styles.icon);
  const labelled = title != null && title !== '';

  let body;
  if (!layers || variant === 'outline') {
    body = <Outline marks={definition.marks} />;
  } else if (variant === 'duotone') {
    body = <Duotone marks={definition.marks} layers={layers} />;
  } else if (variant === 'glyph') {
    body = <Glyph layers={layers} maskId={maskId} />;
  } else {
    body = <Bulk layers={layers} />;
  }

  return (
    <svg
      ref={ref}
      viewBox="0 0 24 24"
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : true}
      data-icon={name}
      data-variant={layers ? variant : 'outline'}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    >
      {labelled ? <title>{title}</title> : null}
      {body}
    </svg>
  );
});

export type NamedIconProps = Omit<IconProps, 'name'>;

/** A component for one name, so a caller imports `SidebarIcon` rather than a string. */
export function createIcon(name: IconName, displayName: string) {
  const Named = forwardRef<SVGSVGElement, NamedIconProps>(function NamedIcon(props, ref) {
    return <Icon ref={ref} name={name} {...props} />;
  });
  Named.displayName = displayName;
  return Named;
}
