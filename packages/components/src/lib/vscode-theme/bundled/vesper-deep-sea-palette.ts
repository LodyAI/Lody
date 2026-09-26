import { hexColorToRgb, normalizeHexColor } from '../vscode-theme-color';
import type { LodyResolvedVSCodeTheme } from '../vscode-theme-schemas';

/**
 * Lody's deep-sea Vesper. Upstream Vesper paints its chrome in pure neutral
 * grays and accents it with orange. Lody keeps the chrome a quiet graphite with
 * only a faint cool cast (a warm cast darkened reads as brown; a strongly blue
 * one reads as another editor theme), and gives the blue to what should glow:
 * the brand's jellyfish cyan marks links, selection, focus and primary actions.
 *
 * - Surfaces take hand-tuned graphite colors (`DEEP_SEA_SURFACES`).
 * - Every other neutral gray (workbench colors and syntax foregrounds) keeps its
 *   lightness and takes a slight cool cast that fades as it brightens, so text
 *   stays near-neutral (`deepSeaNeutralHexColor`).
 * - The orange accent becomes jellyfish cyan (`DEEP_SEA_ACCENTS`), except where
 *   it means "warning" or "modified", which stay amber.
 *
 * Applied once when the bundled theme resolves, so the app tokens, the terminal,
 * code highlighting and the `--vscode-*` variables all share the same palette.
 */
export const deepSeaVesperTheme = (theme: LodyResolvedVSCodeTheme): LodyResolvedVSCodeTheme => ({
  ...theme,
  colors: Object.fromEntries(
    Object.entries(theme.colors).map(([colorId, color]) => [
      colorId,
      deepSeaWorkbenchColor(colorId, color),
    ])
  ),
  tokenColors: theme.tokenColors.map((rule) =>
    rule.settings.foreground
      ? {
          ...rule,
          settings: {
            ...rule.settings,
            foreground: deepSeaNeutralHexColor(rule.settings.foreground),
          },
        }
      : rule
  ),
});

/** Vesper's opaque surface grays, mapped to the ink layers. */
const DEEP_SEA_SURFACES: Readonly<Record<string, string>> = {
  '#101010': '#131416', // canvas
  '#161616': '#191A1D', // sidebar, raised panels
  '#1C1C1C': '#1E2023', // cards, inputs, inline code
  '#232323': '#25272B', // selection, hover
  '#282828': '#2B2D31', // borders
};

/** The orange accent (and its hover step) as jellyfish cyan. */
const DEEP_SEA_ACCENTS: Readonly<Record<string, string>> = {
  '#FFC799': '#7CC4E8',
  '#FFCFA8': '#9AD3EF',
};

/** Orange that means warning / modified, not "accent": it stays amber. */
const AMBER_COLOR_IDS = new Set(['editorWarning.foreground', 'editorGutter.modifiedBackground']);

const deepSeaWorkbenchColor = (colorId: string, color: string): string => {
  const normalized = normalizeHexColor(color);
  const accent = DEEP_SEA_ACCENTS[normalized.slice(0, 7)];
  if (accent && !AMBER_COLOR_IDS.has(colorId)) return accent + normalized.slice(7);
  return deepSeaNeutralHexColor(normalized);
};

/** A gray whose channels differ by more than this is treated as a color. */
const NEUTRAL_CHANNEL_SPREAD = 3;

/**
 * Cool cast (channel spread, 0–255) by gray value: a few units on darks and
 * mid grays, fading toward white so text stays near-neutral.
 */
const CAST_BY_VALUE: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [24, 3],
  [48, 5],
  [120, 7],
  [165, 7],
  [220, 4],
  [255, 2],
];

const castForValue = (value: number): number => {
  for (let index = 1; index < CAST_BY_VALUE.length; index += 1) {
    const [x1, y1] = CAST_BY_VALUE[index]!;
    if (value <= x1) {
      const [x0, y0] = CAST_BY_VALUE[index - 1]!;
      return y0 + ((y1 - y0) * (value - x0)) / (x1 - x0);
    }
  }
  return CAST_BY_VALUE[CAST_BY_VALUE.length - 1]![1];
};

export const deepSeaNeutralHexColor = (color: string): string => {
  const normalized = normalizeHexColor(color);
  const alpha = normalized.slice(7);
  const surface = !alpha ? DEEP_SEA_SURFACES[normalized] : undefined;
  if (surface) return surface;
  const { r, g, b } = hexColorToRgb(normalized);
  if (Math.max(r, g, b) - Math.min(r, g, b) > NEUTRAL_CHANNEL_SPREAD) return normalized;
  const value = (r + g + b) / 3;
  if (value === 0) return normalized;
  // A blue-leaning cyan (about 213°): red lowest, blue highest, green between.
  const cast = castForValue(value);
  const red = value - 0.55 * cast;
  const channel = (level: number) =>
    Math.round(Math.min(255, Math.max(0, level)))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${channel(red)}${channel(red + 0.45 * cast)}${channel(value + 0.45 * cast)}${alpha}`;
};
