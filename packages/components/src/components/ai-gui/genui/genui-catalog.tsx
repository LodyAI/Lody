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
import { createElement, useId, type ReactNode, type SVGProps } from 'react';

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

/* `Mock`: nested JSX layout → this flex pass computes coordinates → greyscale svg. */
const G = '#64748b';
const FILL: Record<string, { fill: string; op: number; dash?: boolean; stroke?: string }> = {
  deep: { fill: G, op: 0.5 },
  mid: { fill: G, op: 0.3 },
  band: { fill: G, op: 0.16 },
  soft: { fill: G, op: 0.09 },
  faint: { fill: G, op: 0.05, dash: true, stroke: G },
};

type MockDir = 'col' | 'row' | 'cell' | 'box' | 'lines';
const mockTag = (dir: MockDir) => {
  const c = (props: GenuiProps) => createElement(`m:${dir}` as 'div', props);
  (c as { genuiMock?: MockDir }).genuiMock = dir;
  return c;
};

function GenuiMock({ children, w, h, pad, 'aria-label': ariaLabel }: GenuiProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const W = num(w, 160);
  const H = num(h, 132);
  const P = num(pad, 4);
  type Node = { dir: MockDir; props: Record<string, unknown>; kids: Node[] };
  const read = (el: unknown): Node | undefined => {
    if (!el || typeof el !== 'object' || Array.isArray(el)) return undefined;
    const e = el as { type?: unknown; props?: Record<string, unknown> };
    const t = e.type;
    const dir =
      typeof t === 'function'
        ? (t as { genuiMock?: MockDir }).genuiMock
        : t === 'm:col'
          ? 'col'
          : t === 'm:row'
            ? 'row'
            : t === 'm:cell'
              ? 'cell'
              : t === 'm:box'
                ? 'box'
                : t === 'm:lines'
                  ? 'lines'
                  : undefined;
    if (!dir) return undefined;
    const kids = (Array.isArray(e.props?.children) ? e.props.children : [e.props?.children])
      .map(read)
      .filter((n): n is Node => n !== undefined);
    return { dir, props: e.props ?? {}, kids };
  };
  const roots = (Array.isArray(children) ? children : [children])
    .map(read)
    .filter((n): n is Node => n !== undefined);

  const q = (n: number) => Math.round(n * 2) / 2;
  const rects: { x: number; y: number; w: number; h: number; tone: string; rx: number }[] = [];
  const texts: { x: number; y: number; s: number; w: number; t: string; clip: number }[] = [];

  const layout = (node: Node, x: number, y: number, w: number, h: number): void => {
    const p = node.props;
    const gap = num(p.gap, 1);
    const inset = num(p.pad, 1);
    const kids = node.kids;
    if (node.dir === 'col' || node.dir === 'row') {
      const main = node.dir === 'col' ? 'h' : 'w';
      const ix = x + inset,
        iy = y + inset,
        iw = w - inset * 2,
        ih = h - inset * 2;
      const inner = node.dir === 'col' ? ih : iw;
      const total = kids.reduce((s, k) => s + num(k.props[main], 0), 0);
      const flexSum = kids.reduce(
        (s, k) => s + Math.max(0, num(k.props.flex, num(k.props[main], 0) > 0 ? 0 : 1)),
        0
      );
      const free = Math.max(0, inner - total - gap * Math.max(0, kids.length - 1));
      let cur = node.dir === 'col' ? iy : ix;
      for (const k of kids) {
        const fixed = num(k.props[main], 0);
        const share =
          fixed > 0 ? fixed : free * (Math.max(0, num(k.props.flex, 1)) / Math.max(1, flexSum));
        if (node.dir === 'col') {
          layout(k, ix, cur, iw, share);
          cur += share + gap;
        } else {
          layout(k, cur, iy, share, ih);
          cur += share + gap;
        }
      }
      return;
    }
    if (node.dir === 'lines') {
      const count = Math.max(1, num(p.count, Math.floor((h + 6) / 16)));
      const lp = num(p.pad, 6);
      const bar = num(p.size, 7);
      const gap = count > 1 ? Math.min(10, (h - lp * 2 - bar) / (count - 1) - bar) : 0;
      let ly = y + lp;
      for (let i = 0; i < count; i++) {
        const bw = i === count - 1 && p.lastShort !== false ? w * 0.62 : w;
        rects.push({
          x: q(x + lp),
          y: q(ly),
          w: q(Math.max(8, w - lp * 2) * (bw === w ? 1 : 0.62)),
          h: bar,
          tone: 'soft',
          rx: Math.min(3, bar / 2),
        });
        ly += bar + gap;
      }
      return;
    }
    rects.push({
      x: q(x),
      y: q(y),
      w: q(w),
      h: q(h),
      tone: str(p.tone, 'mid'),
      rx: Math.min(4, w / 2, h / 2),
    });
    const cellLabel = node.dir === 'cell' ? str(p.label) : '';
    if (node.dir === 'cell' && cellLabel) {
      const fs = h >= 26 ? 10 : 8;
      texts.push({
        x: x + w / 2,
        y: y + h / 2 + fs * 0.35,
        s: fs,
        w: 500,
        t: cellLabel,
        clip: rects.length - 1,
      });
    }
    if (node.dir === 'box') {
      const clip = rects.length - 1;
      const cx = x + w / 2;
      const cy = y + h / 2;
      const label = str(p.label),
        sub = str(p.sub),
        hint = str(p.hint);
      // Keep a line only when it still fits: a 12/9/8px slot needs ~1.7·s of box.
      const room = Math.max(0, h - 6);
      const fs = room >= 30 ? 12 : room >= 18 ? 10 : 8;
      const want = [
        label && { t: label, s: fs, b: 600, need: fs * 1.7 },
        sub && { t: sub, s: 9, need: 15 },
        hint && { t: hint, s: 8, need: 13 },
      ].filter(Boolean) as { t: string; s: number; b?: number; need: number }[];
      let used = 0;
      const lines = want.filter((l) => {
        used += l.need;
        return used <= room;
      });
      const slots = lines.map((l) => l.s * 1.4);
      const blockH = slots.reduce((a, b) => a + b, 0);
      let ty = cy - blockH / 2;
      lines.forEach((l, i) => {
        texts.push({
          x: cx,
          y: Math.round((ty + slots[i] / 2 + l.s * 0.35) * 10) / 10,
          s: l.s,
          w: l.b ?? 400,
          t: l.t,
          clip,
        });
        ty += slots[i];
      });
    }
  };
  for (const r of roots) layout(r, P, P, W - P * 2, H - P * 2);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      fill="currentColor"
      fontFamily="-apple-system, system-ui, sans-serif"
      {...stylex.props(styles.svg)}
      role="img"
      aria-label={str(ariaLabel, 'wireframe')}
    >
      <rect
        x={P}
        y={P}
        width={W - P * 2}
        height={H - P * 2}
        rx={5}
        stroke={G}
        strokeOpacity={0.5}
        fill="none"
      />
      <defs>
        {rects.map((r, i) => (
          <clipPath key={i} id={`${uid}c${i}`}>
            <rect x={r.x} y={r.y} width={Math.max(0, r.w)} height={Math.max(0, r.h)} rx={r.rx} />
          </clipPath>
        ))}
      </defs>
      {rects.map((r, i) => {
        const t = FILL[r.tone] ?? FILL.mid;
        return (
          <rect
            key={i}
            x={r.x}
            y={r.y}
            width={Math.max(0, r.w)}
            height={Math.max(0, r.h)}
            rx={r.rx}
            fill={t.fill}
            fillOpacity={t.op}
            stroke={t.stroke}
            strokeDasharray={t.dash ? '4 3' : undefined}
          />
        );
      })}
      {texts.map((t, i) => (
        <text
          key={i}
          x={t.x}
          y={t.y}
          textAnchor="middle"
          fontSize={t.s}
          fontWeight={t.w}
          fill="currentColor"
          clipPath={`url(#${uid}c${t.clip})`}
        >
          {t.t}
        </text>
      ))}
    </svg>
  );
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
  name.startsWith('aria-') ? name : name.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());

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
    createElement(tag as 'svg', pickSvgProps(rest, allowed) as SVGProps<SVGSVGElement>, children);
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
  Text: ({ children, muted, size }) => (
    <p
      {...stylex.props(styles.text, bool(muted) && styles.textMuted)}
      style={{ fontSize: size === undefined ? undefined : num(size) }}
    >
      {children}
    </p>
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
  Mock: (props) => <GenuiMock {...props} />,
  'Mock:Col': mockTag('col'),
  'Mock:Row': mockTag('row'),
  'Mock:Cell': mockTag('cell'),
  'Mock:Box': mockTag('box'),
  'Mock:Lines': mockTag('lines'),
  svg: ({ children, ...rest }) => (
    <svg
      fill="currentColor"
      fontFamily="-apple-system, system-ui, sans-serif"
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
