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
import type { ReactNode } from 'react';

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
});

type IconName = keyof typeof icons;
const pascal = (name: string) =>
  name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

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

export const GENU_CATALOG: Record<string, GenuiRenderer> = {
  card: ({ children }) => <Card.Root>{children}</Card.Root>,
  row: ({ children, gap }) => (
    <div {...stylex.props(styles.row)} style={{ gap: typeof gap === 'number' ? gap : undefined }}>
      {children}
    </div>
  ),
  column: ({ children, gap }) => (
    <div
      {...stylex.props(styles.column)}
      style={{ gap: typeof gap === 'number' ? gap : undefined }}
    >
      {children}
    </div>
  ),
  divider: () => <Separator />,
  spacer: ({ size }) => <span style={{ flex: 1, minWidth: num(size), minHeight: num(size) }} />,
  text: ({ children, muted }) => (
    <p {...stylex.props(styles.text, bool(muted) && styles.textMuted)}>{children}</p>
  ),
  heading: ({ children, level }) => {
    const Tag = `h${Math.min(Math.max(num(level, 3), 1), 6)}` as 'h3';
    return <Tag {...stylex.props(styles.heading)}>{children}</Tag>;
  },
  badge: ({ children, tone }) => (
    <Badge tone={str(tone, 'neutral') as 'neutral' | 'success' | 'warning' | 'danger' | 'running'}>
      {children}
    </Badge>
  ),
  icon: ({ name, size, color }) => {
    const Icon = icons[pascal(str(name)) as IconName];
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
  button: ({ children, onClick, variant, size, disabled }) => (
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
  input: ({ value, onValueChange, placeholder, disabled }) => (
    <Input
      value={str(value)}
      placeholder={str(placeholder)}
      disabled={bool(disabled)}
      onValueChange={(v: string) => fn(onValueChange)(v)}
    />
  ),
  checkbox: ({ checked, onCheckedChange, disabled }) => (
    <Checkbox
      checked={bool(checked)}
      disabled={bool(disabled)}
      onCheckedChange={(v: boolean) => fn(onCheckedChange)(v)}
    />
  ),
  switch: ({ checked, onCheckedChange, disabled }) => (
    <Switch
      checked={bool(checked)}
      disabled={bool(disabled)}
      onCheckedChange={(v: boolean) => fn(onCheckedChange)(v)}
    />
  ),
  select: (props) => <GenuiSelect {...props} />,
  slider: (props) => <GenuiSlider {...props} />,
};

/**
 * Tags allowed outside a `genui` fence as inline markdown elements. They are
 * leaf, presentational, and take literal props only — no state, no events.
 */
export const GENUI_INLINE_TAGS: ReadonlySet<string> = new Set(['icon', 'badge']);
