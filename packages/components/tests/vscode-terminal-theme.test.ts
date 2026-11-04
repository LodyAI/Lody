import { describe, expect, it } from 'vitest';
import { createVSCodeTerminalTheme, type LodyResolvedVSCodeTheme } from '../src/lib/vscode-theme';

const theme: LodyResolvedVSCodeTheme = {
  schemaVersion: 1,
  id: 'terminal-fixture',
  label: 'Terminal Fixture',
  type: 'dark',
  source: { kind: 'test-fixture' },
  colors: {
    'editor.background': '#101010',
    'editor.foreground': '#FFFFFF',
    'terminal.ansiRed': '#FF8080',
    'terminal.ansiBrightRed': '#FFA198',
    'terminal.background': '#000000',
    'terminal.foreground': '#EEEEEE',
  },
  tokenColors: [],
};

const themeWithoutTerminalPalette: LodyResolvedVSCodeTheme = {
  schemaVersion: 1,
  id: 'terminal-fallback-fixture',
  label: 'Terminal Fallback Fixture',
  type: 'dark',
  source: { kind: 'test-fixture' },
  colors: {
    'editor.background': '#101010',
    'editor.foreground': '#FFFFFF',
    'input.background': '#1C1C1C',
  },
  tokenColors: [],
};

describe('VSCode terminal theme adapter', () => {
  it('creates terminal container styles and preserves explicit ANSI colors while filling readable fallbacks', () => {
    const terminalTheme = createVSCodeTerminalTheme(theme);

    expect(terminalTheme?.containerStyle).toEqual({
      backgroundColor: '#000000',
      color: '#EEEEEE',
    });
    expect(terminalTheme?.palette['ansi-red']).toBe('#FF8080');
    expect(terminalTheme?.palette['ansi-bright-red']).toBe('#FFA198');
    expect(terminalTheme?.palette['ansi-black']).not.toBe('rgb(0, 0, 0)');
    expect(Object.keys(terminalTheme?.palette ?? {})).toHaveLength(16);
  });

  it('derives readable fallback ANSI colors when a VSCode theme omits terminal palette tokens', () => {
    const terminalTheme = createVSCodeTerminalTheme(themeWithoutTerminalPalette);

    expect(terminalTheme?.containerStyle).toEqual({
      backgroundColor: '#1C1C1C',
      color: '#FFFFFF',
    });
    expect(terminalTheme?.palette['ansi-black']).not.toBe('rgb(0, 0, 0)');
    expect(terminalTheme?.palette['ansi-blue']).not.toBe('rgb(0, 0, 187)');
    expect(terminalTheme?.palette['ansi-white']).toBe('rgb(187, 187, 187)');

    const background = parseRgb('#1C1C1C');
    const blackContrast = getContrastRatio(
      parseRgb(terminalTheme?.palette['ansi-black']),
      background
    );
    const blueContrast = getContrastRatio(
      parseRgb(terminalTheme?.palette['ansi-blue']),
      background
    );

    expect(blackContrast).toBeGreaterThanOrEqual(4.5);
    expect(blueContrast).toBeGreaterThanOrEqual(4.5);
  });
});

const parseRgb = (color: string | undefined) => {
  expect(color).toBeTruthy();
  const trimmed = color!.trim();

  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
    };
  }

  const match = trimmed.match(/^rgb\((\d{1,3}), (\d{1,3}), (\d{1,3})\)$/);
  expect(match).toBeTruthy();
  return {
    r: Number.parseInt(match![1], 10),
    g: Number.parseInt(match![2], 10),
    b: Number.parseInt(match![3], 10),
  };
};

const getContrastRatio = (
  first: { r: number; g: number; b: number },
  second: { r: number; g: number; b: number }
) => {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
};

const relativeLuminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
  const [red, green, blue] = [r, g, b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};
