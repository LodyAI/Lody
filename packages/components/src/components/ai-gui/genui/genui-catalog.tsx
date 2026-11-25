/**
 * The GenUI component catalog: every tag an agent may emit maps to a host
 * renderer built from @lody/ui primitives and design tokens. Anything not
 * registered here does not exist for the model — the catalog is the contract.
 */
import stylex from '@stylexjs/stylex';
import { Badge, Button, Card, Checkbox, Input, Select, Separator, Switch } from '@lody/ui';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { icons } from 'lucide-react';
import { createElement, type ReactNode, type SVGProps } from 'react';

export type GenuiProps = Record<string, unknown> & { children?: ReactNode };
export type GenuiRenderer = (props: GenuiProps) => ReactNode;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);
const bool = (v: unknown, fallback = false): boolean => (typeof v === 'boolean' ? v : fallback);
const fn =
  (v: unknown) =>
  (...args: unknown[]) =>
    typeof v === 'function' ? (v as (...a: unknown[]) => unknown)(...args) : undefined;

const styles = stylex.create({
  column: { display: 'flex', flexDirection: 'column', gap: space[2] },
  row: {
    display: 'flex',
    flexDirection: 'row',
    gap: space[2],
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  text: { color: colors.label, margin: 0, whiteSpace: 'pre-wrap', lineHeight: text.bodyLeading },
  textMuted: { color: colors.secondaryLabel },
  iconDanger: { color: colors.destructive },
  iconSuccess: { color: colors.success },
  iconWarning: { color: colors.warning },
  iconAccent: { color: colors.accent },
  heading: { color: colors.label, margin: 0, fontWeight: 600, lineHeight: text.headlineLeading },
  badgeRow: { display: 'inline-flex', alignItems: 'center' },
  sliderRow: { display: 'flex', alignItems: 'center', gap: space[2], flex: 1 },
  range: { accentColor: colors.accent, flex: 1, margin: 0 },
  rangeValue: { color: colors.secondaryLabel, fontVariantNumeric: 'tabular-nums' },
  icon: {
    display: 'inline-flex',
    color: colors.secondaryLabel,
    flexShrink: 0,
    verticalAlign: '-0.125em',
  },
  svg: { display: 'block', maxWidth: '100%' },
});

type IconName = keyof typeof icons;
const pascal = (name: string) =>
  name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

/* --------------------------------------------------------------------------
 * Diagram: a declarative layered/flow diagram. The model supplies structure
 * (`layers` and `edges` data); the renderer computes all geometry at render
 * time so the output stays aligned — the model never writes coordinates.
 * ------------------------------------------------------------------------ */

const ACCENT = '#8b5cf6';
const DIAGRAM = {
  width: 560,
  padX: 20,
  padTop: 18,
  padBottom: 18,
  layerGap: 46,
  itemGap: 12,
  layerPadX: 14,
  layerPadTop: 18,
  layerPadBottom: 12,
  itemH: 44,
  edgeStub: 10,
  fontTitle: 10,
  fontItem: 9,
  fontSub: 8,
  fontLabel: 8,
} as const;

interface DiagramItem {
  id: string;
  title: string;
  subtitle?: string;
  tone?: string;
}
interface DiagramLayer {
  label?: string;
  tone?: string;
  items: DiagramItem[];
}
interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  tone?: string;
  dashed?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readItem(v: unknown, index: number): DiagramItem | undefined {
  if (!isRecord(v)) return undefined;
  const title = str(v.title);
  if (!title) return undefined;
  return {
    id: str(v.id) || `item-${index}`,
    title,
    subtitle: v.subtitle === undefined ? undefined : str(v.subtitle),
    tone: v.tone === undefined ? undefined : str(v.tone),
  };
}

function readLayers(v: unknown): DiagramLayer[] {
  if (!Array.isArray(v)) return [];
  const layers: DiagramLayer[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    const items = Array.isArray(raw.items)
      ? raw.items.map(readItem).filter((i): i is DiagramItem => i !== undefined)
      : [];
    layers.push({
      label: raw.label === undefined ? undefined : str(raw.label),
      tone: raw.tone === undefined ? undefined : str(raw.tone),
      items,
    });
  }
  return layers;
}

function readEdges(v: unknown): DiagramEdge[] {
  if (!Array.isArray(v)) return [];
  const edges: DiagramEdge[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    const from = str(raw.from);
    const to = str(raw.to);
    if (!from || !to) continue;
    edges.push({
      from,
      to,
      label: raw.label === undefined ? undefined : str(raw.label),
      tone: raw.tone === undefined ? undefined : str(raw.tone),
      dashed: bool(raw.dashed),
    });
  }
  return edges;
}

const toneStroke = (tone?: string) => (tone === 'accent' ? ACCENT : 'currentColor');
const toneOpacity = (tone?: string, base = 0.05) => (tone === 'accent' ? 0.12 : base);

/**
 * Compute a top-down layered layout. Each layer is a band; items inside a
 * layer share the band width equally. Edges run from the bottom-centre of a
 * source item to the top-centre of its target. Returns the svg children.
 */
function GenuiDiagram({ layers, edges, ariaLabel }: GenuiProps) {
  const ls = readLayers(layers);
  const es = readEdges(edges);
  const D = DIAGRAM;
  const innerW = D.width - D.padX * 2;

  // Pre-compute each layer's band height (taller when it has a label).
  const bandH = (layer: DiagramLayer) =>
    (layer.label ? D.layerPadTop : 8) + D.itemH + D.layerPadBottom;

  const totalH =
    D.padTop +
    ls.reduce((h, l) => h + bandH(l), 0) +
    Math.max(0, ls.length - 1) * D.layerGap +
    D.padBottom;

  // Place every item: record its box and layer index for edge routing.
  const boxes = new Map<string, { x: number; y: number; w: number; h: number; layer: number }>();
  const layerRects: { x: number; y: number; w: number; h: number; label?: string; tone?: string }[] =
    [];
  let cursorY = D.padTop;
  ls.forEach((layer, layerIndex) => {
    const h = bandH(layer);
    layerRects.push({ x: D.padX, y: cursorY, w: innerW, h, label: layer.label, tone: layer.tone });
    const n = Math.max(1, layer.items.length);
    const itemW = (innerW - D.layerPadX * 2 - (n - 1) * D.itemGap) / n;
    const itemY = cursorY + (layer.label ? D.layerPadTop : 8);
    layer.items.forEach((item, i) => {
      const x = D.padX + D.layerPadX + i * (itemW + D.itemGap);
      boxes.set(item.id, { x, y: itemY, w: itemW, h: D.itemH, layer: layerIndex });
    });
    cursorY += h + D.layerGap;
  });

  const cx = (b: { x: number; w: number }) => b.x + b.w / 2;
  // Cross-layer edges route through a right-hand gutter so the stroke never
  // crosses an intermediate band.
  const gutterX = D.width - 8;

  return (
    <svg
      viewBox={`0 0 ${D.width} ${totalH}`}
      width="100%"
      role="img"
      aria-label={str(ariaLabel, 'diagram')}
      {...stylex.props(styles.svg)}
    >
      {/* edges first so boxes paint over their endpoints */}
      {es.map((edge, i) => {
        const a = boxes.get(edge.from);
        const b = boxes.get(edge.to);
        if (!a || !b) return null;
        const stroke = toneStroke(edge.tone);
        const accent = edge.tone === 'accent';
        const strokeProps = {
          stroke,
          strokeOpacity: accent ? 0.95 : 0.4,
          strokeWidth: accent ? 1.8 : 1,
          strokeDasharray: edge.dashed ? '4 3' : undefined,
        };
        const adjacent = Math.abs(a.layer - b.layer) === 1;
        if (adjacent) {
          // Straight line between vertically neighbouring layers.
          const [top, bot] = a.layer < b.layer ? [a, b] : [b, a];
          const x1 = cx(top);
          const y1 = top.y + top.h;
          const x2 = cx(bot);
          const y2 = bot.y;
          return (
            <g key={`e${i}`}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} {...strokeProps} />
              {edge.label ? (
                <text
                  x={(x1 + x2) / 2 + 4}
                  y={(y1 + y2) / 2}
                  fontSize={D.fontLabel}
                  fill="currentColor"
                  opacity={0.6}
                >
                  {edge.label}
                </text>
              ) : null}
            </g>
          );
        }
        // Same-layer or multi-layer edge: exit the source's right edge into
        // the gutter, descend to just above the target's layer, then enter
        // the target's top edge — the stroke never crosses a band and the
        // flow still lands from above like the adjacent-layer strokes.
        const midY = a.y + a.h / 2;
        const topY = b.y - D.layerGap / 2;
        const d = [
          `M ${a.x + a.w} ${midY}`,
          `L ${gutterX} ${midY}`,
          `L ${gutterX} ${topY}`,
          `L ${cx(b)} ${topY}`,
          `L ${cx(b)} ${b.y}`,
        ].join(' ');
        return (
          <g key={`e${i}`}>
            <path d={d} fill="none" {...strokeProps} />
            {edge.label ? (
              <text
                x={(gutterX + cx(b)) / 2}
                y={topY - 3 - (i % 3) * 9}
                fontSize={D.fontLabel}
                fill="currentColor"
                opacity={0.6}
                textAnchor="middle"
              >
                {edge.label}
              </text>
            ) : null}
          </g>
        );
      })}
      {/* layer bands */}
      {layerRects.map((r, i) => (
        <g key={`l${i}`}>
          <rect
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            rx={8}
            fill="currentColor"
            opacity={toneOpacity(r.tone, 0.04)}
            stroke="currentColor"
            strokeOpacity={0.25}
          />
          {r.label ? (
            <text
              x={r.x + 12}
              y={r.y + 14}
              fontSize={D.fontLabel}
              letterSpacing={1}
              fill="currentColor"
              opacity={0.55}
            >
              {r.label.toUpperCase()}
            </text>
          ) : null}
        </g>
      ))}
      {/* items */}
      {ls.flatMap((layer) =>
        layer.items.map((item) => {
          const b = boxes.get(item.id);
          if (!b) return null;
          const accent = item.tone === 'accent';
          const hasSub = Boolean(item.subtitle);
          return (
            <g key={item.id}>
              <rect
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                rx={6}
                fill={accent ? ACCENT : 'currentColor'}
                opacity={toneOpacity(item.tone)}
                stroke={toneStroke(item.tone)}
                strokeOpacity={accent ? 0.9 : 0.35}
              />
              <text
                x={b.x + 10}
                y={hasSub ? b.y + 18 : b.y + b.h / 2 + 3}
                fontSize={D.fontItem}
                fontWeight={600}
                fill="currentColor"
              >
                {item.title}
              </text>
              {hasSub ? (
                <text x={b.x + 10} y={b.y + 32} fontSize={D.fontSub} fill="currentColor" opacity={0.6}>
                  {item.subtitle}
                </text>
              ) : null}
            </g>
          );
        })
      )}
    </svg>
  );
}

// lucide-react 1.x dropped deprecated aliases like `x-circle` (now `circle-x`);
// models still write the old kebab names, so retry with rotated segments.
export function resolveIcon(name: string) {
  const direct = icons[pascal(name) as IconName];
  if (direct) return direct;
  const parts = name.split('-');
  if (parts.length < 2) return undefined;
  const candidates = [
    [...parts.slice(1), parts[0]],
    [parts[parts.length - 1], ...parts.slice(0, -1)],
  ];
  for (const candidate of candidates) {
    const icon = icons[pascal(candidate.join('-')) as IconName];
    if (icon) return icon;
  }
  return undefined;
}

function GenuiSlider({ value, onChange, min, max, step, disabled }: GenuiProps) {
  return (
    <span {...stylex.props(styles.sliderRow)}>
      <input
        type="range"
        {...stylex.props(styles.range)}
        min={num(min)}
        max={num(max, 100)}
        step={num(step, 1)}
        value={num(value)}
        disabled={bool(disabled)}
        aria-valuetext={str(value)}
        onChange={(e) => fn(onChange)(e.target.valueAsNumber)}
      />
      <span {...stylex.props(styles.rangeValue)}>{String(num(value))}</span>
    </span>
  );
}

function GenuiSelect({ items, value, onValueChange, placeholder, disabled }: GenuiProps) {
  const options = Array.isArray(items)
    ? items.map((item) =>
        typeof item === 'object' && item !== null
          ? {
              value: String((item as { value?: unknown }).value ?? ''),
              label: String(
                (item as { label?: unknown }).label ?? (item as { value?: unknown }).value ?? ''
              ),
            }
          : { value: String(item), label: String(item) }
      )
    : [];
  return (
    <Select.Root
      items={options}
      value={str(value)}
      onValueChange={(v: string | null) => fn(onValueChange)(v)}
      disabled={bool(disabled)}
    >
      <Select.Trigger size="small" aria-label={str(placeholder, 'select')}>
        <Select.Value placeholder={str(placeholder)} />
      </Select.Trigger>
      <Select.Content>
        {options.map((option) => (
          <Select.Item key={option.value} value={option.value}>
            {option.label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

/**
 * The SVG family: a fixed element set behind a paint/geometry attribute
 * whitelist. An unlisted attribute is dropped, never forwarded — so `href`,
 * `style`, event handlers, embedded HTML (`foreignObject`) and animation
 * elements have no path to the DOM.
 */
const SVG_PAINT: ReadonlySet<string> = new Set([
  'color',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'opacity',
  'transform',
  'vector-effect',
]);
const SVG_ROOT: ReadonlySet<string> = new Set([
  ...SVG_PAINT,
  'viewBox',
  'view-box',
  'preserveAspectRatio',
  'preserve-aspect-ratio',
  'width',
  'height',
  'role',
  'aria-label',
  'aria-hidden',
]);
const SVG_TEXT: ReadonlySet<string> = new Set([
  ...SVG_PAINT,
  'x',
  'y',
  'dx',
  'dy',
  'rotate',
  'text-anchor',
  'font-size',
  'font-weight',
  'font-style',
  'font-family',
  'letter-spacing',
]);

/** `aria-*` keeps kebab case; other attributes camelize for React. */
const camelAttr = (name: string) =>
  name.startsWith('aria-')
    ? name
    : name.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());

function pickSvgProps(
  props: Record<string, unknown>,
  allowed: ReadonlySet<string>
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(props)) {
    if (!allowed.has(name)) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
      continue;
    picked[camelAttr(name)] = value;
  }
  return picked;
}

type SvgTag =
  | 'svg'
  | 'g'
  | 'rect'
  | 'circle'
  | 'ellipse'
  | 'line'
  | 'polyline'
  | 'polygon'
  | 'path'
  | 'text'
  | 'tspan';

function svgElement(tag: SvgTag, allowed: ReadonlySet<string>): GenuiRenderer {
  return ({ children, ...rest }) =>
    createElement(
      tag as 'svg',
      pickSvgProps(rest, allowed) as SVGProps<SVGSVGElement>,
      children
    );
}

const svgRect = new Set([...SVG_PAINT, 'x', 'y', 'width', 'height', 'rx', 'ry']);
const svgCircle = new Set([...SVG_PAINT, 'cx', 'cy', 'r']);
const svgEllipse = new Set([...SVG_PAINT, 'cx', 'cy', 'rx', 'ry']);
const svgLine = new Set([...SVG_PAINT, 'x1', 'y1', 'x2', 'y2']);
const svgPoints = new Set([...SVG_PAINT, 'points']);
const svgPath = new Set([...SVG_PAINT, 'd']);

export const GENUI_CATALOG: Record<string, GenuiRenderer> = {
  Card: ({ children }) => <Card.Root>{children}</Card.Root>,
  Row: ({ children, gap }) => (
    <div {...stylex.props(styles.row)} style={{ gap: typeof gap === 'number' ? gap : undefined }}>
      {children}
    </div>
  ),
  Column: ({ children, gap }) => (
    <div
      {...stylex.props(styles.column)}
      style={{ gap: typeof gap === 'number' ? gap : undefined }}
    >
      {children}
    </div>
  ),
  Divider: () => <Separator />,
  Spacer: ({ size }) => <span style={{ flex: 1, minWidth: num(size), minHeight: num(size) }} />,
  Text: ({ children, muted }) => (
    <p {...stylex.props(styles.text, bool(muted) && styles.textMuted)}>{children}</p>
  ),
  Heading: ({ children, level }) => {
    const Tag = `h${Math.min(Math.max(num(level, 3), 1), 6)}` as 'h3';
    return <Tag {...stylex.props(styles.heading)}>{children}</Tag>;
  },
  Badge: ({ children, tone }) => (
    <Badge tone={str(tone, 'neutral') as 'neutral' | 'success' | 'warning' | 'danger' | 'running'}>
      {children}
    </Badge>
  ),
  Icon: ({ name, size, color }) => {
    const Icon = resolveIcon(str(name));
    const px = num(size, 14);
    const tone = str(color);
    return Icon ? (
      <span
        {...stylex.props(
          styles.icon,
          (tone === 'danger' || tone === 'destructive') && styles.iconDanger,
          tone === 'success' && styles.iconSuccess,
          tone === 'warning' && styles.iconWarning,
          (tone === 'accent' || tone === 'running') && styles.iconAccent
        )}
      >
        <Icon size={px} aria-hidden />
      </span>
    ) : null;
  },
  Button: ({ children, onClick, variant, size, disabled }) => (
    <Button
      variant={
        str(variant, 'secondary') as 'primary' | 'secondary' | 'ghost' | 'destructive' | 'link'
      }
      size={str(size, 'medium') as 'mini' | 'small' | 'medium' | 'large'}
      disabled={bool(disabled)}
      onClick={() => fn(onClick)()}
    >
      {children}
    </Button>
  ),
  Input: ({ value, onValueChange, placeholder, disabled }) => (
    <Input
      value={str(value)}
      placeholder={str(placeholder)}
      disabled={bool(disabled)}
      onValueChange={(v: string) => fn(onValueChange)(v)}
    />
  ),
  Checkbox: ({ checked, onCheckedChange, disabled }) => (
    <Checkbox
      checked={bool(checked)}
      disabled={bool(disabled)}
      onCheckedChange={(v: boolean) => fn(onCheckedChange)(v)}
    />
  ),
  Switch: ({ checked, onCheckedChange, disabled }) => (
    <Switch
      checked={bool(checked)}
      disabled={bool(disabled)}
      onCheckedChange={(v: boolean) => fn(onCheckedChange)(v)}
    />
  ),
  Select: (props) => <GenuiSelect {...props} />,
  Slider: (props) => <GenuiSlider {...props} />,
  Diagram: GenuiDiagram,
  svg: ({ children, ...rest }) => (
    <svg
      {...(pickSvgProps(rest, SVG_ROOT) as SVGProps<SVGSVGElement>)}
      {...stylex.props(styles.svg)}
    >
      {children}
    </svg>
  ),
  g: svgElement('g', SVG_PAINT),
  rect: svgElement('rect', svgRect),
  circle: svgElement('circle', svgCircle),
  ellipse: svgElement('ellipse', svgEllipse),
  line: svgElement('line', svgLine),
  polyline: svgElement('polyline', svgPoints),
  polygon: svgElement('polygon', svgPoints),
  path: svgElement('path', svgPath),
  'svg:text': svgElement('text', SVG_TEXT),
  'svg:tspan': svgElement('tspan', SVG_TEXT),
};

/**
 * Tags allowed outside a `genui` fence as inline markdown elements. They are
 * leaf, presentational, and take literal props only — no state, no events.
 */
export const GENUI_INLINE_TAGS: ReadonlySet<string> = new Set(['Icon', 'Badge']);
