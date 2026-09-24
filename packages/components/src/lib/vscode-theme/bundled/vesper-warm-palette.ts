import { hexColorToRgb, normalizeHexColor } from '../vscode-theme-color';
import type { LodyResolvedVSCodeTheme } from '../vscode-theme-schemas';

/**
 * Lody's warm Vesper. Upstream Vesper paints its chrome in pure neutral grays
 * (#101010 canvas, #A0A0A0 muted text, #FFFFFF text); over long sessions a warm
 * color temperature reads calmer. Every achromatic color of the theme — workbench
 * colors and syntax foregrounds — takes a warm white point, so the canvas lands
 * near #141312 and reading text near #D2CDC5. Near-black surfaces are also lifted
 * one step, keeping their order and spacing. Accents (#FFC799, #99FFE4, #FF8080)
 * are chromatic and keep their values; pure black (foreground on accent fills)
 * stays black.
 *
 * Applied once when the bundled theme resolves, so the app tokens, the terminal,
 * code highlighting and the `--vscode-*` variables all share the same palette.
 */
export const warmVesperTheme = (theme: LodyResolvedVSCodeTheme): LodyResolvedVSCodeTheme => ({
  ...theme,
  colors: Object.fromEntries(
    Object.entries(theme.colors).map(([colorId, color]) => [colorId, warmNeutralHexColor(color)])
  ),
  tokenColors: theme.tokenColors.map((rule) =>
    rule.settings.foreground
      ? {
          ...rule,
          settings: { ...rule.settings, foreground: warmNeutralHexColor(rule.settings.foreground) },
        }
      : rule
  ),
});

/** Channel gains of the warm white point: #FFFFFF maps to #FFF8EF. */
const WARM_WHITE_POINT = { r: 1, g: 0.976, b: 0.938 } as const;
/** A gray whose channels differ by more than this is treated as a color. */
const NEUTRAL_CHANNEL_SPREAD = 3;
/** Opaque surfaces darker than this are lifted by `SURFACE_LIFT` (clamped to it). */
const SURFACE_LIFT_LIMIT = 0x30;
const SURFACE_LIFT = 4;

export const warmNeutralHexColor = (color: string): string => {
  const normalized = normalizeHexColor(color);
  const { r, g, b } = hexColorToRgb(normalized);
  if (Math.max(r, g, b) - Math.min(r, g, b) > NEUTRAL_CHANNEL_SPREAD) return normalized;

  const alpha = normalized.slice(7);
  let value = (r + g + b) / 3;
  if (!alpha && value > 0 && value < SURFACE_LIFT_LIMIT) {
    value = Math.min(SURFACE_LIFT_LIMIT, value + SURFACE_LIFT);
  }
  // Floor, not round: rounding can pull neighbouring surfaces' green and blue
  // channels together (the canvas / sidebar step must stay visible).
  const channel = (gain: number) =>
    Math.floor(value * gain)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${channel(WARM_WHITE_POINT.r)}${channel(WARM_WHITE_POINT.g)}${channel(WARM_WHITE_POINT.b)}${alpha}`;
};
