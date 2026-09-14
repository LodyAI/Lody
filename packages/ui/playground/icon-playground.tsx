import * as stylex from '@stylexjs/stylex';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconVariant } from '../src/icons/icon';
import { ICONS, ICON_FAMILIES, type IconFamily, type IconName } from '../src/icons/registry';
import {
  BellRingIcon,
  CheckDrawIcon,
  ChevronToggleIcon,
  EyeToggleIcon,
  FolderToggleIcon,
  PlayPauseIcon,
  RefreshTurnIcon,
  SidebarToggleIcon,
  StarToggleIcon,
} from '../src/icons/stateful';
import { ThemeRoot, type ThemeMode } from '../src/theme/theme';
import { colors, shadow } from '../src/tokens/colors.stylex';
import { radius, space, text } from '../src/tokens/scales.stylex';

/**
 * The icon playground.
 *
 * The board in `src/gallery` answers "what is this token's value" — one sample
 * each, read back off the rendered node. An icon set asks a different question,
 * and it asks it 75 times: find the drawing, put it at the size the surface
 * uses, in the colour that surface gives it, on the rung it will sit on, and
 * take it away as markup. That is a page with controls rather than a row on a
 * board, so it is here, on its own server, with no Storybook under it.
 *
 * Nothing here is exported from the package and nothing here is a component of
 * it. The playground is a *holder* of icons: every size, colour and surface it
 * applies, it applies from the outside, which is exactly the contract an icon
 * states by having neither.
 */

const VARIANTS: IconVariant[] = ['outline', 'duotone', 'glyph', 'bulk'];

const FAMILY_LABELS: Record<IconFamily, string> = {
  navigation: 'navigation',
  actions: 'actions',
  files: 'files',
  git: 'git & code',
  status: 'status',
  product: 'agent & product',
};

const FAMILIES = Object.keys(ICON_FAMILIES) as IconFamily[];

/** The registry's families as plain arrays, so a lookup is not a union of tuples. */
const MEMBERS = Object.fromEntries(
  FAMILIES.map((family) => [family, [...ICON_FAMILIES[family]] as IconName[]])
) as Record<IconFamily, IconName[]>;

/** Which family a drawing belongs to, for the search and the detail panel. */
const FAMILY_OF = new Map<IconName, IconFamily>(
  FAMILIES.flatMap((family) => MEMBERS[family].map((name) => [name, family] as const))
);

const TONES = ['label', 'secondary', 'tertiary', 'accent', 'destructive', 'success'] as const;
type Tone = (typeof TONES)[number];

/**
 * The rung the icons sit on. `accent` is here for one reason: a glyph cuts its
 * marks through a mask rather than painting them the panel's colour, and the
 * only way to see the difference is to put a glyph on something that is not
 * the panel.
 */
const SURFACES = ['page', 'raised', 'well', 'accent'] as const;
type Surface = (typeof SURFACES)[number];

const SIZES = [12, 16, 20, 24, 32, 48];

const MODES = ['light', 'dark', 'split', 'system'] as const;
type Mode = (typeof MODES)[number];

const RING = `0 0 0 2px ${colors.accent}`;

const styles = stylex.create({
  page: {
    minHeight: '100vh',
    backgroundColor: colors.background,
    color: colors.label,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
  },
  barWrap: { padding: space[4], paddingBottom: 0 },
  split: { display: 'flex', alignItems: 'stretch' },
  splitPane: { flex: '1 1 0', minWidth: 0 },
  shell: { display: 'flex', alignItems: 'flex-start', gap: space[6], padding: space[4] },
  main: { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: space[6] },

  bar: {
    position: 'sticky',
    top: space[2],
    zIndex: 2,
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[3],
    padding: space[3],
    borderRadius: radius.large,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
  },
  barTitle: {
    marginRight: 'auto',
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 600,
    letterSpacing: text.controlTracking,
  },
  count: { color: colors.tertiaryLabel, fontVariantNumeric: 'tabular-nums' },

  search: {
    width: '200px',
    height: '30px',
    paddingInline: space[3],
    borderStyle: 'none',
    outline: 'none',
    borderRadius: radius.medium,
    backgroundColor: colors.wellBackground,
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: text.bodySize,
    boxShadow: { default: shadow.inset, ':focus': `${shadow.inset}, ${RING}` },
  },

  group: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    padding: '2px',
    borderRadius: radius.medium,
    backgroundColor: colors.wellBackground,
  },
  groupLabel: {
    paddingInline: space[1.5],
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.tertiaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  chip: {
    appearance: 'none',
    borderStyle: 'none',
    cursor: 'pointer',
    height: '26px',
    paddingInline: space[2],
    borderRadius: radius.mini,
    fontFamily: 'inherit',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    letterSpacing: text.controlTracking,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.secondaryLabel,
    outline: 'none',
    boxShadow: { default: 'none', ':focus-visible': RING },
  },
  chipOn: {
    backgroundColor: colors.elevatedBackground,
    color: colors.label,
    boxShadow: { default: shadow.raised, ':focus-visible': `${shadow.raised}, ${RING}` },
  },
  slider: { width: '110px', accentColor: colors.accent },

  section: { display: 'flex', flexDirection: 'column', gap: space[2] },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  note: {
    maxWidth: '68ch',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
  },

  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))',
    gap: space[1],
    padding: space[3],
    borderRadius: radius.large,
  },
  surfacePage: { backgroundColor: colors.secondaryBackground, color: colors.label },
  surfaceRaised: {
    backgroundColor: colors.raisedBackground,
    color: colors.label,
    boxShadow: shadow.raised,
  },
  surfaceWell: {
    backgroundColor: colors.wellBackground,
    color: colors.label,
    boxShadow: shadow.inset,
  },
  surfaceAccent: { backgroundColor: colors.accent, color: colors.onAccent },

  tile: {
    appearance: 'none',
    borderStyle: 'none',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space[1.5],
    padding: space[2],
    borderRadius: radius.medium,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: 'inherit',
    fontFamily: 'inherit',
    outline: 'none',
    boxShadow: { default: 'none', ':focus-visible': '0 0 0 2px currentColor' },
  },
  tileOn: { backgroundColor: colors.selectedFill },
  tileBox: { display: 'grid', placeItems: 'center', minHeight: '48px' },
  tileName: {
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    opacity: 0.6,
    textAlign: 'center',
    wordBreak: 'break-word',
  },

  toneLabel: { color: colors.label },
  toneSecondary: { color: colors.secondaryLabel },
  toneTertiary: { color: colors.tertiaryLabel },
  toneAccent: { color: colors.accent },
  toneDestructive: { color: colors.destructive },
  toneSuccess: { color: colors.success },
  toneInherit: { color: 'inherit' },

  panel: {
    position: 'sticky',
    top: space[4],
    flex: '0 0 296px',
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
    padding: space[4],
    borderRadius: radius.large,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
  },
  panelName: {
    fontSize: text.titleSize,
    lineHeight: text.titleLeading,
    fontWeight: 600,
    letterSpacing: text.controlTracking,
  },
  panelMeta: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
  },
  panelRow: { display: 'flex', alignItems: 'flex-end', gap: space[2], flexWrap: 'wrap' },
  panelCell: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space[1],
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.tertiaryLabel,
  },

  stage: {
    position: 'relative',
    alignSelf: 'center',
    width: '168px',
    height: '168px',
    borderRadius: radius.medium,
    backgroundColor: colors.secondaryBackground,
  },
  stageGrid: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    color: colors.accent,
  },
  stageIcon: { position: 'absolute', inset: 0, display: 'block' },

  code: {
    margin: 0,
    padding: space[2],
    borderRadius: radius.small,
    backgroundColor: colors.wellBackground,
    color: colors.secondaryLabel,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  actions: { display: 'flex', gap: space[1.5], flexWrap: 'wrap' },
  beside: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    color: colors.label,
  },

  stateGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(116px, 1fr))',
    gap: space[2],
  },
  stateTile: {
    appearance: 'none',
    borderStyle: 'none',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space[2],
    padding: space[3],
    borderRadius: radius.medium,
    backgroundColor: { default: colors.secondaryBackground, ':hover': colors.hoverFill },
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    outline: 'none',
    boxShadow: { default: 'none', ':focus-visible': RING },
  },
  stateName: { color: colors.tertiaryLabel },
  stateValue: { color: colors.accent, fontVariantNumeric: 'tabular-nums' },
});

const TONE_STYLES = {
  label: styles.toneLabel,
  secondary: styles.toneSecondary,
  tertiary: styles.toneTertiary,
  accent: styles.toneAccent,
  destructive: styles.toneDestructive,
  success: styles.toneSuccess,
} satisfies Record<Tone, unknown>;

const SURFACE_STYLES = {
  page: styles.surfacePage,
  raised: styles.surfaceRaised,
  well: styles.surfaceWell,
  accent: styles.surfaceAccent,
} satisfies Record<Surface, unknown>;

/**
 * The box an icon is given.
 *
 * The size comes off a slider, so it is an inline declaration rather than a
 * StyleX one: StyleX compiles a style sheet ahead of time and a continuous
 * control value has no class waiting for it. Which is the point being shown —
 * the holder states the size, and the icon fills whatever it is given.
 */
function IconBox({ size, children }: { size: number; children: ReactNode }) {
  return (
    <span style={{ display: 'block', width: size, height: size, flexShrink: 0 }}>{children}</span>
  );
}

function Chip({
  on,
  onClick,
  children,
  title,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      onClick={onClick}
      {...stylex.props(styles.chip, on && styles.chipOn)}
    >
      {children}
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span role="group" aria-label={label} {...stylex.props(styles.group)}>
      {children}
    </span>
  );
}

/** The 24 canvas and the 20 live area, behind an enlarged drawing. */
function GridOverlay() {
  const lines = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...stylex.props(styles.stageGrid)}>
      <g stroke="currentColor" strokeWidth={0.05} opacity={0.35}>
        {lines.map((line) => (
          <path key={line} d={`M${line} 0v24M0 ${line}h24`} />
        ))}
      </g>
      <rect
        x={2}
        y={2}
        width={20}
        height={20}
        fill="none"
        stroke="currentColor"
        strokeWidth={0.1}
        opacity={0.75}
      />
    </svg>
  );
}

/**
 * The markup a caller would paste. The class and the data attributes are the
 * component's bookkeeping rather than the drawing, so they come off;
 * `currentColor` stays, because inheriting it is the contract.
 */
function svgMarkup(node: SVGSVGElement, size: number): string {
  const clone = node.cloneNode(true) as SVGSVGElement;
  for (const attribute of ['class', 'style', 'data-icon', 'data-variant', 'aria-hidden']) {
    clone.removeAttribute(attribute);
  }
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(size));
  clone.setAttribute('height', String(size));
  return clone.outerHTML;
}

function useCopy(): [string | null, (key: string, value: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const copy = useCallback((key: string, value: string) => {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    void clipboard.writeText(value).then(() => {
      setCopied(key);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1200);
    });
  }, []);
  return [copied, copy];
}

/** `file-text` is exported as `FileTextIcon`; the snippet says so. */
function pascal(name: string): string {
  return name.replace(/(^|-)([a-z0-9])/g, (_match, _dash, character: string) =>
    character.toUpperCase()
  );
}

function Detail({
  name,
  variant,
  onVariant,
  onClose,
}: {
  name: IconName;
  variant: IconVariant;
  onVariant: (variant: IconVariant) => void;
  onClose: () => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [copied, copy] = useCopy();
  const definition = ICONS[name];
  const layers = definition.layers;
  const jsx = `<Icon name="${name}"${variant === 'outline' ? '' : ` variant="${variant}"`} />`;

  return (
    <aside {...stylex.props(styles.panel)}>
      <div>
        <div {...stylex.props(styles.panelName)}>{name}</div>
        <div {...stylex.props(styles.panelMeta)}>
          {FAMILY_LABELS[FAMILY_OF.get(name) ?? 'navigation']} · layers:{' '}
          {layers ? Object.keys(layers).join(', ') : 'none'}
        </div>
      </div>

      <div {...stylex.props(styles.stage)}>
        <GridOverlay />
        <span {...stylex.props(styles.stageIcon)}>
          <Icon ref={svgRef} name={name} variant={variant} />
        </span>
      </div>

      <div {...stylex.props(styles.panelRow)}>
        {VARIANTS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => onVariant(candidate)}
            {...stylex.props(styles.tile, candidate === variant && styles.tileOn)}
          >
            <IconBox size={32}>
              <Icon name={name} variant={candidate} />
            </IconBox>
            <span {...stylex.props(styles.tileName)}>{candidate}</span>
          </button>
        ))}
      </div>
      {layers ? null : (
        <div {...stylex.props(styles.panelMeta)}>
          No layer model, so all four treatments are the outline: the drawing has no mass to fill.
        </div>
      )}

      <div {...stylex.props(styles.panelRow)}>
        {SIZES.map((size) => (
          <span key={size} {...stylex.props(styles.panelCell)}>
            <IconBox size={size}>
              <Icon name={name} variant={variant} />
            </IconBox>
            {size}
          </span>
        ))}
      </div>

      <div {...stylex.props(styles.beside)}>
        <IconBox size={16}>
          <Icon name={name} variant={variant} />
        </IconBox>
        beside 14px text
      </div>

      <pre {...stylex.props(styles.code)}>
        {`import { ${pascal(name)}Icon } from '@lody/ui/icons';\n${jsx}`}
      </pre>

      <div {...stylex.props(styles.actions)}>
        <Chip on={copied === 'jsx'} onClick={() => copy('jsx', jsx)}>
          {copied === 'jsx' ? 'copied' : 'copy jsx'}
        </Chip>
        <Chip
          on={copied === 'svg'}
          onClick={() => {
            const node = svgRef.current;
            if (node) copy('svg', svgMarkup(node, 24));
          }}
        >
          {copied === 'svg' ? 'copied' : 'copy svg'}
        </Chip>
        <Chip on={copied === 'name'} onClick={() => copy('name', name)}>
          {copied === 'name' ? 'copied' : 'copy name'}
        </Chip>
        <Chip on={false} onClick={onClose} title="escape">
          close
        </Chip>
      </div>
    </aside>
  );
}

const STATEFUL: { key: string; render: (on: boolean) => ReactNode }[] = [
  { key: 'sidebar', render: (on) => <SidebarToggleIcon collapsed={on} /> },
  { key: 'chevron', render: (on) => <ChevronToggleIcon open={on} /> },
  { key: 'check', render: (on) => <CheckDrawIcon checked={on} /> },
  { key: 'eye', render: (on) => <EyeToggleIcon hidden={on} /> },
  { key: 'play / pause', render: (on) => <PlayPauseIcon playing={on} /> },
  { key: 'star', render: (on) => <StarToggleIcon starred={on} /> },
  { key: 'bell', render: (on) => <BellRingIcon ringing={on} /> },
  { key: 'refresh', render: (on) => <RefreshTurnIcon turned={on} /> },
  { key: 'folder', render: (on) => <FolderToggleIcon open={on} /> },
];

/** The icons with two states, each flipped by pressing it. */
function StateBoard({ size }: { size: number }) {
  const [on, setOn] = useState<Record<string, boolean>>({});
  return (
    <div {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        two states
        <span {...stylex.props(styles.count)}>{STATEFUL.length}</span>
        <Chip
          on={false}
          onClick={() =>
            setOn((current) => Object.fromEntries(STATEFUL.map(({ key }) => [key, !current[key]])))
          }
        >
          flip all
        </Chip>
      </div>
      <div {...stylex.props(styles.note)}>
        Press one. Each is a single svg whose parts are functions of one number, the registered
        custom property <code>--lody-icon-t</code>, which CSS transitions: nothing is added for a
        state and no path morphs, so both ends are the static drawing. Turn on slow motion to watch
        the number move rather than infer it from the two ends. Under{' '}
        <code>prefers-reduced-motion</code> the duration is zero and a press snaps.
      </div>
      <div {...stylex.props(styles.stateGrid)}>
        {STATEFUL.map(({ key, render }) => (
          <button
            key={key}
            type="button"
            onClick={() => setOn((current) => ({ ...current, [key]: !current[key] }))}
            {...stylex.props(styles.stateTile)}
          >
            <IconBox size={Math.max(size, 24)}>{render(Boolean(on[key]))}</IconBox>
            <span {...stylex.props(styles.stateName)}>{key}</span>
            <span {...stylex.props(styles.stateValue)}>t = {on[key] ? 1 : 0}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

interface BoardProps {
  matches: IconName[];
  variant: IconVariant;
  size: number;
  tone: Tone;
  surface: Surface;
  selected: IconName | null;
  onSelect: (name: IconName | null) => void;
  onVariant: (variant: IconVariant) => void;
}

function Board({
  matches,
  variant,
  size,
  tone,
  surface,
  selected,
  onSelect,
  onVariant,
}: BoardProps) {
  const found = new Set(matches);
  // On the accent rung the icons take the colour the rung gives them, which is
  // the whole reason to stand them there; a tone would paint over it.
  const toneStyle = surface === 'accent' ? styles.toneInherit : TONE_STYLES[tone];
  return (
    <div {...stylex.props(styles.shell)}>
      <div {...stylex.props(styles.main)}>
        {FAMILIES.map((family) => {
          const members = MEMBERS[family].filter((name) => found.has(name));
          if (members.length === 0) return null;
          return (
            <div key={family} {...stylex.props(styles.section)}>
              <div {...stylex.props(styles.sectionHead)}>
                {FAMILY_LABELS[family]}
                <span {...stylex.props(styles.count)}>{members.length}</span>
              </div>
              <div {...stylex.props(styles.grid, SURFACE_STYLES[surface])}>
                {members.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => onSelect(name === selected ? null : name)}
                    {...stylex.props(styles.tile, name === selected && styles.tileOn)}
                  >
                    <span {...stylex.props(styles.tileBox, toneStyle)}>
                      <IconBox size={size}>
                        <Icon name={name} variant={variant} />
                      </IconBox>
                    </span>
                    <span {...stylex.props(styles.tileName)}>{name}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {matches.length === 0 ? (
          <div {...stylex.props(styles.note)}>Nothing is drawn under that name.</div>
        ) : null}
        <StateBoard size={size} />
      </div>
      {selected ? (
        <Detail
          name={selected}
          variant={variant}
          onVariant={onVariant}
          onClose={() => onSelect(null)}
        />
      ) : null}
    </div>
  );
}

export function IconPlayground() {
  const [query, setQuery] = useState('');
  const [variant, setVariant] = useState<IconVariant>('outline');
  const [size, setSize] = useState(24);
  const [tone, setTone] = useState<Tone>('label');
  const [surface, setSurface] = useState<Surface>('page');
  const [mode, setMode] = useState<Mode>('light');
  const [layeredOnly, setLayeredOnly] = useState(false);
  const [slowMotion, setSlowMotion] = useState(false);
  const [selected, setSelected] = useState<IconName | null>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.documentElement.dataset.slowMotion = slowMotion ? 'on' : 'off';
  }, [slowMotion]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setSelected(null);
      if (event.key === '/' && document.activeElement !== search.current) {
        event.preventDefault();
        search.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return FAMILIES.flatMap((family) =>
      MEMBERS[family].filter((name) => {
        if (layeredOnly && ICONS[name].layers == null) return false;
        if (needle === '') return true;
        return name.includes(needle) || FAMILY_LABELS[family].includes(needle);
      })
    );
  }, [query, layeredOnly]);

  const board = (
    <Board
      matches={matches}
      variant={variant}
      size={size}
      tone={tone}
      surface={surface}
      selected={selected}
      onSelect={setSelected}
      onVariant={setVariant}
    />
  );

  const bar = (
    <div {...stylex.props(styles.barWrap)}>
      <div {...stylex.props(styles.bar)}>
        <span {...stylex.props(styles.barTitle)}>
          @lody/ui icons <span {...stylex.props(styles.count)}>{matches.length}</span>
        </span>

        <input
          ref={search}
          type="search"
          value={query}
          placeholder="search  ( / )"
          aria-label="search icons"
          onChange={(event) => setQuery(event.target.value)}
          {...stylex.props(styles.search)}
        />

        <Group label="variant">
          {VARIANTS.map((candidate) => (
            <Chip key={candidate} on={candidate === variant} onClick={() => setVariant(candidate)}>
              {candidate}
            </Chip>
          ))}
        </Group>

        <Group label="size">
          <span {...stylex.props(styles.groupLabel)}>{size}px</span>
          <input
            type="range"
            min={12}
            max={64}
            step={1}
            value={size}
            aria-label="size"
            onChange={(event) => setSize(Number(event.target.value))}
            {...stylex.props(styles.slider)}
          />
        </Group>

        <Group label="tone">
          {TONES.map((candidate) => (
            <Chip key={candidate} on={candidate === tone} onClick={() => setTone(candidate)}>
              {candidate}
            </Chip>
          ))}
        </Group>

        <Group label="surface">
          {SURFACES.map((candidate) => (
            <Chip
              key={candidate}
              on={candidate === surface}
              onClick={() => setSurface(candidate)}
              title={
                candidate === 'accent'
                  ? 'a glyph cuts a hole, so whatever is under it shows through'
                  : undefined
              }
            >
              {candidate}
            </Chip>
          ))}
        </Group>

        <Group label="palette">
          {MODES.map((candidate) => (
            <Chip key={candidate} on={candidate === mode} onClick={() => setMode(candidate)}>
              {candidate}
            </Chip>
          ))}
        </Group>

        <Group label="options">
          <Chip
            on={layeredOnly}
            onClick={() => setLayeredOnly((current) => !current)}
            title="only the icons that carry a layer model, and so have four treatments"
          >
            layered only
          </Chip>
          <Chip on={slowMotion} onClick={() => setSlowMotion((current) => !current)}>
            slow motion
          </Chip>
        </Group>
      </div>
    </div>
  );

  if (mode === 'split') {
    return (
      <ThemeRoot mode="light">
        <div {...stylex.props(styles.page)}>
          {bar}
          <div {...stylex.props(styles.split)}>
            {(['light', 'dark'] as ThemeMode[]).map((pane) => (
              <div key={pane} {...stylex.props(styles.splitPane)}>
                <ThemeRoot mode={pane}>
                  <div {...stylex.props(styles.page)}>{board}</div>
                </ThemeRoot>
              </div>
            ))}
          </div>
        </div>
      </ThemeRoot>
    );
  }

  return (
    <ThemeRoot mode={mode}>
      <div {...stylex.props(styles.page)}>
        {bar}
        {board}
      </div>
    </ThemeRoot>
  );
}
