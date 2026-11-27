import type { CSSProperties } from 'react';
import { hexColorToRgb, readWorkbenchColor } from './vscode-theme-color';
import type { LodyResolvedVSCodeTheme } from './vscode-theme-schemas';

type AnsiColorClass =
  | 'ansi-black'
  | 'ansi-red'
  | 'ansi-green'
  | 'ansi-yellow'
  | 'ansi-blue'
  | 'ansi-magenta'
  | 'ansi-cyan'
  | 'ansi-white'
  | 'ansi-bright-black'
  | 'ansi-bright-red'
  | 'ansi-bright-green'
  | 'ansi-bright-yellow'
  | 'ansi-bright-blue'
  | 'ansi-bright-magenta'
  | 'ansi-bright-cyan'
  | 'ansi-bright-white';

export type VSCodeTerminalPalette = Partial<Record<AnsiColorClass, string>>;

export type VSCodeTerminalTheme = {
  palette: VSCodeTerminalPalette;
  containerStyle: CSSProperties;
};

const ANSI_CLASS_TO_VSCODE_COLOR_ID: Record<AnsiColorClass, string> = {
  'ansi-black': 'terminal.ansiBlack',
  'ansi-red': 'terminal.ansiRed',
  'ansi-green': 'terminal.ansiGreen',
  'ansi-yellow': 'terminal.ansiYellow',
  'ansi-blue': 'terminal.ansiBlue',
  'ansi-magenta': 'terminal.ansiMagenta',
  'ansi-cyan': 'terminal.ansiCyan',
  'ansi-white': 'terminal.ansiWhite',
  'ansi-bright-black': 'terminal.ansiBrightBlack',
  'ansi-bright-red': 'terminal.ansiBrightRed',
  'ansi-bright-green': 'terminal.ansiBrightGreen',
  'ansi-bright-yellow': 'terminal.ansiBrightYellow',
  'ansi-bright-blue': 'terminal.ansiBrightBlue',
  'ansi-bright-magenta': 'terminal.ansiBrightMagenta',
  'ansi-bright-cyan': 'terminal.ansiBrightCyan',
  'ansi-bright-white': 'terminal.ansiBrightWhite',
};

const ANSI_RGB_PATTERN = /^\d+\s*,\s*\d+\s*,\s*\d+$/;
const DEFAULT_ANSI_CLASS_COLORS: Record<AnsiColorClass, string> = {
  'ansi-black': 'rgb(0, 0, 0)',
  'ansi-red': 'rgb(187, 0, 0)',
  'ansi-green': 'rgb(0, 187, 0)',
  'ansi-yellow': 'rgb(187, 187, 0)',
  'ansi-blue': 'rgb(0, 0, 187)',
  'ansi-magenta': 'rgb(187, 0, 187)',
  'ansi-cyan': 'rgb(0, 187, 187)',
  'ansi-white': 'rgb(187, 187, 187)',
  'ansi-bright-black': 'rgb(85, 85, 85)',
  'ansi-bright-red': 'rgb(255, 85, 85)',
  'ansi-bright-green': 'rgb(85, 255, 85)',
  'ansi-bright-yellow': 'rgb(255, 255, 85)',
  'ansi-bright-blue': 'rgb(85, 85, 255)',
  'ansi-bright-magenta': 'rgb(255, 85, 255)',
  'ansi-bright-cyan': 'rgb(85, 255, 255)',
  'ansi-bright-white': 'rgb(255, 255, 255)',
};

export const createVSCodeTerminalTheme = (
  theme: LodyResolvedVSCodeTheme | undefined
): VSCodeTerminalTheme | undefined => {
  if (!theme) {
    return undefined;
  }

  const foregroundColor = readWorkbenchColor(theme, [
    'terminal.foreground',
    'editor.foreground',
    'foreground',
  ]);
  const backgroundColor = readWorkbenchColor(theme, [
    'terminal.background',
    'input.background',
    'editorWidget.background',
    'editor.background',
  ]);
  const palette: VSCodeTerminalPalette = {};
  for (const [ansiClass, colorId] of Object.entries(ANSI_CLASS_TO_VSCODE_COLOR_ID)) {
    const color = theme.colors[colorId];
    palette[ansiClass as AnsiColorClass] =
      color ??
      ensureReadableAnsiFallback(
        DEFAULT_ANSI_CLASS_COLORS[ansiClass as AnsiColorClass],
        backgroundColor,
        foregroundColor
      );
  }

  return {
    palette,
    containerStyle: {
      color: foregroundColor,
      backgroundColor,
    },
  };
};

export const resolveAnsiColorToCss = (
  color: string | null | undefined,
  truecolor: string | null | undefined,
  palette: VSCodeTerminalPalette | undefined
): string | undefined => {
  const trimmed = color?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === 'ansi-truecolor') {
    return rgbChannelToCss(truecolor);
  }
  if (isAnsiColorClass(trimmed)) {
    return palette?.[trimmed] ?? DEFAULT_ANSI_CLASS_COLORS[trimmed];
  }
  const rgbCss = rgbChannelToCss(trimmed);
  if (rgbCss !== undefined || ANSI_RGB_PATTERN.test(trimmed)) {
    return rgbCss;
  }
  return trimmed;
};

const rgbChannelToCss = (raw: string | null | undefined): string | undefined => {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const rgb = parseRgbChannels(trimmed);
  if (rgb) {
    return rgbToCss(rgb);
  }
  return undefined;
};

const isAnsiColorClass = (value: string): value is AnsiColorClass =>
  Object.prototype.hasOwnProperty.call(ANSI_CLASS_TO_VSCODE_COLOR_ID, value);

const MIN_TERMINAL_ANSI_CONTRAST = 4.5;

type RgbTriplet = {
  r: number;
  g: number;
  b: number;
};

const ensureReadableAnsiFallback = (
  fallbackColor: string,
  backgroundColor: string | undefined,
  referenceForeground: string | undefined
): string => {
  if (!backgroundColor || !referenceForeground) {
    return fallbackColor;
  }

  const fallbackRgb = parseCssColor(fallbackColor);
  const backgroundRgb = parseCssColor(backgroundColor);
  const foregroundRgb = parseCssColor(referenceForeground);

  if (!fallbackRgb || !backgroundRgb || !foregroundRgb) {
    return fallbackColor;
  }

  if (getContrastRatio(fallbackRgb, backgroundRgb) >= MIN_TERMINAL_ANSI_CONTRAST) {
    return fallbackColor;
  }

  const adjusted = mixTowardContrast(
    fallbackRgb,
    foregroundRgb,
    backgroundRgb,
    MIN_TERMINAL_ANSI_CONTRAST
  );
  return rgbToCss(adjusted);
};

const mixTowardContrast = (
  source: RgbTriplet,
  target: RgbTriplet,
  background: RgbTriplet,
  minContrast: number
): RgbTriplet => {
  let low = 0;
  let high = 1;
  let best = target;

  for (let index = 0; index < 12; index += 1) {
    const factor = (low + high) / 2;
    const mixed = mixRgb(source, target, factor);
    if (getContrastRatio(mixed, background) >= minContrast) {
      best = mixed;
      high = factor;
    } else {
      low = factor;
    }
  }

  return best;
};

const mixRgb = (start: RgbTriplet, end: RgbTriplet, factor: number): RgbTriplet => ({
  r: Math.round(start.r + (end.r - start.r) * factor),
  g: Math.round(start.g + (end.g - start.g) * factor),
  b: Math.round(start.b + (end.b - start.b) * factor),
});

const rgbToCss = (rgb: RgbTriplet): string => `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;

const parseCssColor = (color: string): RgbTriplet | undefined => {
  const trimmed = color.trim();
  if (trimmed.startsWith('#')) {
    return hexColorToRgb(trimmed);
  }

  const rgbMatch = trimmed.match(
    /^rgb\(\s*(?<r>\d{1,3})\s*,\s*(?<g>\d{1,3})\s*,\s*(?<b>\d{1,3})\s*\)$/i
  );
  if (!rgbMatch?.groups) {
    return undefined;
  }

  return parseRgbChannels(`${rgbMatch.groups.r},${rgbMatch.groups.g},${rgbMatch.groups.b}`);
};

const parseRgbChannels = (raw: string): RgbTriplet | undefined => {
  if (!ANSI_RGB_PATTERN.test(raw)) {
    return undefined;
  }

  const [r, g, b] = raw.split(',').map((value) => Number.parseInt(value.trim(), 10));
  if ([r, g, b].some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
    return undefined;
  }

  return { r, g, b };
};

const getContrastRatio = (first: RgbTriplet, second: RgbTriplet): number => {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
};

const relativeLuminance = ({ r, g, b }: RgbTriplet): number => {
  const [red, green, blue] = [r, g, b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};
